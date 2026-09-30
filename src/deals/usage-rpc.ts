// src/deals/usage-rpc.ts — the usage bridge between the plugin's own two v2
// halves (ADR-0020, issue #243 amendment). The v2 Host keeps the connected
// account's credential in its own store: the provider payload no longer
// carries it and the TUI context has no connection service, so the TUI half
// cannot read it — but the *server* half can, through the same
// `ctx.integration.connection` seam `cmd_plan_summary` uses. This module is
// that seam's one sanctioned relay:
//
//   server half  `ctx.rpc.register` — a portable plugin-RPC port whose
//                handler resolves the Host's active connection credential
//                (host-credential getter passed by src/plugin/index.ts) and
//                runs the four-leg billing fetch with it. Only display data
//                leaves: the snapshot, the refreshed scope, the rung;
//   TUI half     `ctx.client.rpc(definition)` — the same port, called with
//                the panel's cached scope and abort signal. No credential
//                resolution happens in the TUI process for v2, and no
//                fallback exists: when the server half has no connected
//                credential the answer is the notice, never another account.
//
// The port is deliberately not a "resolve credential" call: returning the key
// over the API would expose credentials to any local HTTP client. Fetching
// server-side keeps the key where it already lives (ADR-0015 rule 4's hygiene,
// one surface over).
//
// Both payloads are parsed structurally — the wire shapes are this package's
// own, but the host codec round-trips them, so the boundary applies the same
// defensive rule as every other parse in the slice. The module imports no
// runtime `@opencode/*` (the port's definition is a plain JSON-Schema object)
// and no TUI runtime, so both bundles may load it.
import { normalizePlan } from "../catalog/plans.js"
import { isRecord, numberValue, stringValue } from "../provider/converters.js"
import type { HostCredential } from "../provider/auth-key.js"
import type { V2RpcCallContext, V2SetupContext } from "../plugin/v2-types.js"
import type { V2TuiClient } from "../plugin/v2-tui-types.js"
import type { UsageLoadOutcome, UsageLoader, UsageLoadRequest } from "./tui-usage.js"
import {
  fetchUsageSnapshot,
  type FetchUsageOptions,
  type UsageCredentialSource,
  type UsageMonthly,
  type UsageResult,
  type UsageScope,
  type UsageSnapshot,
  type UsageSubscriptionCache,
  type UsageTotals,
  type UsageWindow,
} from "./usage.js"

/** The port id: the plugin's own, registered once by the server half. */
const USAGE_RPC_ID = "commandcode"

/** The single method of the port. */
const USAGE_RPC_METHOD = "usage"

/**
 * The portable definition (`Rpc.PortableDefinition`, mirrored from
 * `@opencode/schema/rpc`): one method whose JSON Schemas are deliberately
 * coarse — the payload shapes are this package's own and are parsed
 * defensively by each side, so the schema pins object-ness, not fields.
 */
export const USAGE_RPC_DEFINITION = {
  id: USAGE_RPC_ID,
  methods: {
    [USAGE_RPC_METHOD]: {
      input: {
        type: "object",
        properties: { scope: { type: "object" } },
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
  events: {},
} as const

/**
 * The `usage` method's input: the caller's cached scope (#245's client-side
 * subscription cache), round-tripped so the server half stays stateless.
 */
export interface UsageRpcInput {
  readonly scope?: UsageScope
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

/** Injection seams for the registration's tests (the transport is the host's). */
export interface UsageRpcRegistrationOptions {
  fetchOptions?: Omit<FetchUsageOptions, "apiKey" | "scope" | "onScope" | "signal" | "now">
}

/**
 * Registers the usage port on the server half. The getter is the same
 * `hostCredentialFromV2(ctx)` the plan tool receives (ADR-0015): read per call,
 * stored credentials included, so a `/connect` mid-session is observed.
 */
export async function registerUsageRpc(
  ctx: V2SetupContext,
  hostCredential: () => Promise<HostCredential | undefined>,
  options: UsageRpcRegistrationOptions = {},
): Promise<void> {
  const handler = async (input: unknown, context: V2RpcCallContext): Promise<UsageRpcOutcome> => {
    const credential = await hostCredential()
    if (credential === undefined) return { result: { state: "no-credential" } }
    let scope = parseScope(isRecord(input) ? input.scope : undefined)
    const result = await fetchUsageSnapshot({
      ...options.fetchOptions,
      apiKey: credential.key,
      scope,
      onScope: (updated) => {
        scope = updated
      },
      signal: context.signal,
    })
    // The Host service distinguishes its env method from its store; both are
    // the Host's own resolution and collapse into the panel's host rung, with
    // the env method keeping its named rung.
    const provenance: UsageCredentialSource =
      credential.source === "environment" ? { kind: "environment" } : { kind: "host" }
    return {
      result,
      ...(scope === undefined ? {} : { scope }),
      provenance,
    }
  }
  await ctx.rpc.register(USAGE_RPC_DEFINITION, { [USAGE_RPC_METHOD]: handler })
}

/**
 * The TUI half's loader: one port call per chain, the request's cached scope
 * in, the refreshed scope out, the caller's abort signal joined to the RPC's
 * own cancellation. A host without the bridge, or a codec-mangled answer,
 * degrades to `unavailable` — never to a guessed account.
 */
export function createUsageRpcLoader(client: V2TuiClient): UsageLoader {
  return async (request: UsageLoadRequest): Promise<UsageLoadOutcome> => {
    const input: UsageRpcInput = request.scope === undefined ? {} : { scope: request.scope }
    const output = await client.rpc(USAGE_RPC_DEFINITION).usage(input, {
      signal: request.signal,
    })
    return parseUsageOutcome(output)
  }
}

/** The RPC result as a load outcome; any shape drift degrades, never throws. */
function parseUsageOutcome(output: unknown): UsageLoadOutcome {
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
function parseWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined
  const used = numberValue(value.used)
  if (used === undefined) return undefined
  const window: UsageWindow = { used, exceeded: value.exceeded === true }
  const cap = numberValue(value.cap)
  if (cap !== undefined) window.cap = cap
  const resetAt = numberValue(value.resetAt)
  if (resetAt !== undefined) window.resetAt = resetAt
  return window
}

/** The monthly pool: both numbers are required for a meter. */
function parseMonthly(value: unknown): UsageMonthly | undefined {
  if (!isRecord(value)) return undefined
  const used = numberValue(value.used)
  const cap = numberValue(value.cap)
  return used === undefined || cap === undefined ? undefined : { used, cap }
}

/** The cycle totals: whichever live numbers survived the round trip. */
function parseTotals(value: unknown): UsageTotals | undefined {
  if (!isRecord(value)) return undefined
  const totals: UsageTotals = {}
  for (const key of ["requests", "tokens", "tokensIn", "tokensOut", "cost"] as const) {
    const number = numberValue(value[key])
    if (number !== undefined) totals[key] = number
  }
  return Object.keys(totals).length === 0 ? undefined : totals
}

/** A round-tripped snapshot with every field reconsidered; never throws. */
function parseSnapshot(value: unknown): UsageSnapshot | undefined {
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
  const totals = parseTotals(value.totals)
  if (totals !== undefined) snapshot.totals = totals
  const periodEnd = numberValue(value.periodEnd)
  if (periodEnd !== undefined) snapshot.periodEnd = periodEnd
  const periodBasis = stringValue(value.periodBasis)
  if (periodBasis !== undefined) snapshot.periodBasis = periodBasis
  return snapshot
}

/** The cached scope as it crosses the wire; malformed fields are dropped. */
function parseScope(value: unknown): UsageScope | undefined {
  if (!isRecord(value)) return undefined
  const scope: UsageScope = {}
  const orgId = stringValue(value.orgId)
  if (orgId !== undefined) scope.orgId = orgId
  const subscription = parseSubscriptionCache(value.subscription)
  if (subscription !== undefined) scope.subscription = subscription
  return Object.keys(scope).length === 0 ? undefined : scope
}

/** The subscription cache's own fields; `readAt` is the required one. */
function parseSubscriptionCache(value: unknown): UsageSubscriptionCache | undefined {
  if (!isRecord(value)) return undefined
  const readAt = numberValue(value.readAt)
  if (readAt === undefined) return undefined
  const cache: UsageSubscriptionCache = { readAt }
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
