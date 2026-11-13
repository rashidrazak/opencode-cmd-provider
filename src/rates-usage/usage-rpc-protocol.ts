// src/rates-usage/usage-rpc-protocol.ts — the usage bridge's wire contract
// (ADR-0020, issue #243 amendment), split out of its two ends so a non-TUI
// client can ship it without the server half's fetch path: the portable port
// definition both ends register/call, and the defensive parsers for what
// crosses it.
//
// The port is deliberately not a "resolve credential" call: returning the key
// over the API would expose credentials to any local HTTP client. Fetching
// server-side keeps the key where it already lives (ADR-0015 rule 4's hygiene,
// one surface over). The `previous` snapshot travels *to* the server on each
// call — display data only, parsed as defensively as any other wire input — so
// the server half stays stateless (ADR-0020). The `progress` event carries one
// landing leg's merged view back (#251).
//
// Both payloads are parsed structurally — the wire shapes are this package's
// own, but the host codec round-trips them, so the boundary applies the same
// defensive rule as every other parse in the slice. The module imports no
// runtime `@opencode/*` (the port's definition is a plain JSON-Schema object)
// and no TUI or node runtime, so the server bundle, the TUI bundle and the
// desktop window bundle may all load it.
import { normalizePlan } from "../catalog/plans.js"
import { isRecord, numberValue, stringValue } from "../provider/converters.js"
import type { UsagePanelState } from "./usage-panel.js"
import type { UsageCredentialSource, UsageResult, UsageScope, UsageSnapshot } from "./usage.js"

/** The port id: the plugin's own, registered once by the server half. */
export const USAGE_RPC_ID = "commandcode"

/** The single method of the port. */
export const USAGE_RPC_METHOD = "usage"

/** The single progress event: one landing leg's merged view (#251). */
export const USAGE_RPC_PROGRESS = "progress"

/**
 * The portable definition (`Rpc.PortableDefinition`, mirrored from
 * `@opencode/schema/rpc`): one method whose JSON Schemas are deliberately
 * coarse — the payload shapes are this package's own and are parsed
 * defensively by each side, so the schema pins object-ness, not fields — plus
 * the `progress` event a caller can correlate with its `callId` (#251).
 */
export const USAGE_RPC_DEFINITION = {
  id: USAGE_RPC_ID,
  methods: {
    [USAGE_RPC_METHOD]: {
      input: {
        type: "object",
        properties: {
          scope: { type: "object" },
          previous: { type: "object" },
          callId: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          result: { type: "object" },
          scope: { type: "object" },
          provenance: { type: "object" },
        },
        required: ["result"],
        additionalProperties: false,
      },
    },
  },
  events: {
    [USAGE_RPC_PROGRESS]: {
      schema: {
        type: "object",
        properties: {
          callId: { type: "string" },
          result: { type: "object" },
          provenance: { type: "object" },
        },
        required: ["callId", "result"],
        additionalProperties: false,
      },
    },
  },
} as const

/**
 * The `usage` method's input: the caller's cached scope (#245's client-side
 * subscription cache), its last-good snapshot to merge over (#251), and — when
 * the caller wants progressive updates — a `callId` correlating the
 * `progress` events this call emits. All three round-trip so the server half
 * stays stateless.
 */
export interface UsageRpcInput {
  readonly scope?: UsageScope
  readonly previous?: UsageSnapshot
  readonly callId?: string
}

/**
 * The `usage` method's output: what the panel renders — the snapshot result,
 * the scope to cache next, and the display rung the credential answered for.
 * No key ever travels in either direction.
 */
export interface UsageRpcOutcome {
  readonly result: UsageResult
  readonly scope?: UsageScope
  readonly provenance?: UsageCredentialSource
}

/**
 * One `progress` event as the panel consumes it: the event's `callId` must
 * match the loader's own, and only a renderable usage state is forwarded.
 * Malformed payloads drop silently — a lost progress frame is cosmetic.
 */
export function parseProgressEvent(event: unknown, callId: string): UsagePanelState | undefined {
  if (!isRecord(event) || !isRecord(event.data)) return undefined
  const data = event.data
  if (stringValue(data.callId) !== callId) return undefined
  const result = parseUsageResult(data.result)
  if (result.state !== "usage") return undefined
  const provenance = parseProvenance(data.provenance)
  return provenance === undefined ? { result } : { result, provenance }
}

/** The RPC result as a load outcome; any shape drift degrades, never throws. */
export function parseUsageOutcome(output: unknown): {
  result: UsageResult
  scope?: UsageScope
  provenance?: UsageCredentialSource
} {
  if (!isRecord(output)) return { result: { state: "unavailable" } }
  const scope = parseScope(output.scope)
  const provenance = parseProvenance(output.provenance)
  return {
    result: parseUsageResult(output.result),
    ...(scope === undefined ? {} : { scope }),
    ...(provenance === undefined ? {} : { provenance }),
  }
}

function parseUsageResult(value: unknown): UsageResult {
  if (!isRecord(value)) return { state: "unavailable" }
  const state = stringValue(value.state)
  if (state === "no-credential") return { state: "no-credential" }
  if (state !== "usage") return { state: "unavailable" }
  const snapshot = parseSnapshot(value.snapshot)
  return snapshot === undefined ? { state: "unavailable" } : { state: "usage", snapshot }
}

/** One rolling window of a round-tripped snapshot; `used` is the requirement. */
function parseWindow(value: unknown) {
  if (!isRecord(value)) return undefined
  const used = numberValue(value.used)
  if (used === undefined) return undefined
  const window = { used, exceeded: value.exceeded === true } as NonNullable<
    UsageSnapshot["fiveHour"]
  >
  const cap = numberValue(value.cap)
  if (cap !== undefined) window.cap = cap
  const resetAt = numberValue(value.resetAt)
  if (resetAt !== undefined) window.resetAt = resetAt
  return window
}

/** The monthly pool: both numbers are required for a meter. */
function parseMonthly(value: unknown) {
  if (!isRecord(value)) return undefined
  const used = numberValue(value.used)
  const cap = numberValue(value.cap)
  return used === undefined || cap === undefined ? undefined : { used, cap }
}

/** The cycle totals: whichever live numbers survived the round trip. */
function parseTotals(value: unknown) {
  if (!isRecord(value)) return undefined
  const totals: NonNullable<UsageSnapshot["totals"]> = {}
  for (const key of ["requests", "tokens", "tokensIn", "tokensOut", "cost"] as const) {
    const number = numberValue(value[key])
    if (number !== undefined) totals[key] = number
  }
  return Object.keys(totals).length === 0 ? undefined : totals
}

/** A round-tripped snapshot with every field reconsidered; never throws. */
export function parseSnapshot(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const snapshot: UsageSnapshot = {}
  const plan = normalizePlan(value.plan)
  if (plan !== undefined) snapshot.plan = plan
  if (typeof value.limited === "boolean") snapshot.limited = value.limited
  const fiveHour = parseWindow(value.fiveHour)
  if (fiveHour !== undefined) snapshot.fiveHour = fiveHour
  const weekly = parseWindow(value.weekly)
  if (weekly !== undefined) snapshot.weekly = weekly
  const monthly = parseMonthly(value.monthly)
  if (monthly !== undefined) snapshot.monthly = monthly
  const purchasedCredits = numberValue(value.purchasedCredits)
  if (purchasedCredits !== undefined) snapshot.purchasedCredits = purchasedCredits
  const totals = parseTotals(value.totals)
  if (totals !== undefined) snapshot.totals = totals
  const periodEnd = numberValue(value.periodEnd)
  if (periodEnd !== undefined) snapshot.periodEnd = periodEnd
  const periodBasis = stringValue(value.periodBasis)
  if (periodBasis !== undefined) snapshot.periodBasis = periodBasis
  return snapshot
}

/** The cached scope as it crosses the wire; malformed fields are dropped. */
export function parseScope(value: unknown): UsageScope | undefined {
  if (!isRecord(value)) return undefined
  const scope: UsageScope = {}
  const orgId = stringValue(value.orgId)
  if (orgId !== undefined) scope.orgId = orgId
  const subscription = parseSubscriptionCache(value.subscription)
  if (subscription !== undefined) scope.subscription = subscription
  return Object.keys(scope).length === 0 ? undefined : scope
}

/** The subscription cache's own fields; `readAt` is the required one. */
function parseSubscriptionCache(value: unknown) {
  if (!isRecord(value)) return undefined
  const readAt = numberValue(value.readAt)
  if (readAt === undefined) return undefined
  const cache = { readAt } as NonNullable<UsageScope["subscription"]>
  const plan = normalizePlan(value.plan)
  if (plan !== undefined) cache.plan = plan
  const since = stringValue(value.since)
  if (since !== undefined) cache.since = since
  const periodEnd = numberValue(value.periodEnd)
  if (periodEnd !== undefined) cache.periodEnd = periodEnd
  return cache
}

/** The display rung as the renderer consumes it; unknown kinds are dropped. */
function parseProvenance(value: unknown): UsageCredentialSource | undefined {
  if (!isRecord(value)) return undefined
  const kind = stringValue(value.kind)
  if (kind === "host") return { kind: "host" }
  if (kind === "environment") return { kind: "environment" }
  if (kind === "file") {
    const label = stringValue(value.label)
    return label === undefined ? undefined : { kind: "file", label }
  }
  return undefined
}
