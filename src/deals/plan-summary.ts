// src/deals/plan-summary.ts — cmd_plan_summary tool: plan-aware allowance
// breakdown. Plan resolution: tool arg → COMMANDCODE_PLAN → the account's
// billing subscription (issue #159). There is deliberately no fallback plan —
// "detected Go" and "could not tell" stay distinguishable, and an unresolved
// plan renders as unknown rather than silently asserting Go's numbers.
//
// The summary also renders its own provenance (issue #205): the account the
// lookup answered for and the rung that supplied the credential. On a machine
// with several Command Code accounts a plan read with a legacy file of another
// account is exactly the wrong answer that used to be invisible; the line makes
// it legible, and it stays key-free (ADR-0015 rule 4).
//
// Transport selection never calls this lookup: the provider transport honours
// only an explicitly written plan pin, so no request is made merely to route
// (see src/provider/command-code-model.ts). Rendering is a pure function so
// tests never touch the network.
import { z } from "zod"
import { MODEL_COSTS } from "../catalog/facts.js"
import { normalizePlan, type PlanId } from "../catalog/plans.js"
import { getApiBase } from "../env.js"
import {
  resolveApiKeyWithSource,
  type ApiKeySource,
  type HostCredential,
  type HostCredentialSource,
} from "../provider/auth-key.js"
import { isRecord, stringValue } from "../provider/converters.js"
import type { V2ToolDefinition } from "../plugin/v2-types.js"
import { MODEL_DEALS, PLAN_CATALOG, type ModelDeals, type PlanInfo } from "./catalog.js"

const PLAN_DISPLAY: Record<PlanId, string> = {
  go: "Go",
  goat: "GOAT",
  pro: "Pro",
  max: "Max 10×",
  max20: "Max 20×",
  teampro: "Team Pro",
  provider: "Provider",
}

/**
 * Subscription statuses that still identify a plan, mirroring the official
 * Command Code CLI's own billing client. Any other status — canceled, unpaid,
 * or one upstream adds later — resolves to unknown rather than reusing a plan
 * the account no longer holds.
 */
const PLAN_BEARING_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"])

/** Abort budget for each billing lookup request. */
const LOOKUP_TIMEOUT_MS = 5000

export interface ResolvePlanOptions {
  /** Resolved API key for the billing lookup (defaults to the
   * COMMANDCODE_API_KEY env var). The tool path passes the credential it
   * resolved through the ADR-0015 ladder, so an opencode /connect credential
   * resolves without an exported env var. */
  apiKey?: string
  /** Base URL for the lookup (defaults to getApiBase(env)). */
  baseURL?: string
  /** Fetch implementation for the lookup (defaults to the global fetch). */
  fetch?: typeof fetch
}

/**
 * Resolves the account's plan, or undefined when nothing resolves. Callers
 * must present undefined as unknown — never as a default plan (issue #159).
 */
export async function resolvePlan(
  planArg: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePlanOptions = {},
): Promise<PlanId | undefined> {
  const fromArg = normalizePlan(planArg)
  if (fromArg) return fromArg
  const fromEnv = normalizePlan(env.COMMANDCODE_PLAN)
  if (fromEnv) return fromEnv
  return (await fetchBillingPlan(env, options)).plan
}

/** The account label's ceiling: identity, not a payload. */
const ACCOUNT_LABEL_MAX_CHARS = 32

/**
 * A short, non-sensitive label for the account a lookup answered for: the
 * `userName` handle, else an elided `user.id`. Never the email, never the key
 * (issue #205) — and never anything that could break out of the summary's
 * single line or forge a table row in it.
 */
function accountLabel(whoami: unknown): string | undefined {
  if (!isRecord(whoami) || !isRecord(whoami.user)) return undefined
  const raw = stringValue(whoami.user.userName) ?? stringValue(whoami.user.id)
  if (!raw) return undefined
  const clean = raw
    .replace(/[`|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean) return undefined
  return clean.length > ACCOUNT_LABEL_MAX_CHARS
    ? `${clean.slice(0, ACCOUNT_LABEL_MAX_CHARS - 1)}…`
    : clean
}

/** What a billing lookup resolved: the plan, and the account it answered for. */
interface BillingLookup {
  plan?: PlanId
  account?: string
}

/**
 * Plan identity comes from the billing endpoints: `GET /alpha/whoami` stopped
 * returning `planId`/`plan`, which is what made every account render as Go
 * (issue #159).
 *
 *   GET /alpha/whoami                        → org id (team plans bill the org)
 *   GET /alpha/billing/subscriptions?orgId=… → data.planId, status-gated
 *   GET /alpha/billing/credits?orgId=…       → credits.planId (fallback)
 *
 * This mirrors the official Command Code CLI's billing client. Each leg fails
 * on its own — a flaky whoami must not hide a valid personal subscription —
 * and every failure (no credential, offline, timeout, non-2xx, unparseable or
 * unknown plan id) resolves to undefined.
 *
 * The `whoami` response is also the summary's only account source (issue #205):
 * the plan is read with one credential, so the account that credential belongs
 * to is what makes a mismatch visible.
 */
async function fetchBillingPlan(
  env: NodeJS.ProcessEnv,
  options: ResolvePlanOptions,
): Promise<BillingLookup> {
  const key = options.apiKey ?? env.COMMANDCODE_API_KEY
  if (!key) return {} // no credential → no request and no guessed plan
  const base = options.baseURL ?? getApiBase(env)
  const fetchImpl = options.fetch ?? fetch

  const getJson = async (path: string): Promise<unknown> => {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      })
      return response.ok ? await response.json() : undefined
    } catch {
      // offline, timeout, unreachable or unparseable — this leg simply misses
      return undefined
    }
  }

  const whoami = await getJson("/alpha/whoami")
  const orgId = isRecord(whoami) && isRecord(whoami.org) ? stringValue(whoami.org.id) : undefined
  const account = accountLabel(whoami)
  const lookup: BillingLookup = account === undefined ? {} : { account }
  const scoped = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""

  const subscriptions = await getJson(`/alpha/billing/subscriptions${scoped}`)
  const subscription =
    isRecord(subscriptions) && isRecord(subscriptions.data) ? subscriptions.data : undefined
  const status = subscription ? stringValue(subscription.status) : undefined
  if (subscription && status && PLAN_BEARING_SUBSCRIPTION_STATUSES.has(status)) {
    const plan = normalizePlan(subscription.planId)
    if (plan) return { ...lookup, plan }
  }

  const credits = await getJson(`/alpha/billing/credits${scoped}`)
  const plan = normalizePlan(
    isRecord(credits) && isRecord(credits.credits) ? credits.credits.planId : undefined,
  )
  return plan ? { ...lookup, plan } : lookup
}

const REQUEST_PROFILE = { input: 800, output: 200, cacheRead: 50_000 }

/**
 * What decided the plan a summary renders (issue #205). Either an explicit pin
 * (ADR-0011 §2 — no lookup happened), a Host-resolved credential, rung of this
 * package's own ladder, or nothing at all. Display provenance only: the rungs
 * carry no key material, and a file rung carries its store's label.
 */
export type PlanSource =
  | { kind: "pin"; via: "argument" | "environment" }
  | { kind: "host"; source: HostCredentialSource }
  | { kind: "ladder"; rung: ApiKeySource }
  | { kind: "none" }

/**
 * How a summary's plan was resolved, for the one provenance line the renderer
 * prints. `account` is what `whoami` called the account behind the credential —
 * absent when it did not answer, and the line then claims no identity rather
 * than inventing one.
 */
export interface PlanProvenance {
  account?: string
  source: PlanSource
}

/** A plan and how it was resolved: what the tool renders. */
export interface PlanResolution {
  plan: PlanId | undefined
  provenance: PlanProvenance
}

/** The credential text of a provenance line, without the account part. */
function credentialLabel(source: PlanSource): string {
  switch (source.kind) {
    case "pin": {
      const via = source.via === "argument" ? "the `plan` argument" : "COMMANDCODE_PLAN"
      return `none — plan pinned by ${via}, so no lookup was made.`
    }
    case "none":
      return "none resolved — no lookup was made."
    case "host":
      switch (source.source) {
        case "host":
          return "Host connection"
        case "environment":
          return "Host connection (COMMANDCODE_API_KEY)"
        case "config":
          return "Host configuration"
      }
    case "ladder":
      switch (source.rung.kind) {
        case "option":
          return "the explicit `apiKey` option"
        case "environment":
          return "COMMANDCODE_API_KEY"
        case "file":
          return `legacy file \`${source.rung.label}\``
      }
  }
}

/**
 * The summary's provenance line: the account the lookup answered for (when
 * `whoami` named one) plus the rung that supplied the credential. One line, so
 * a mismatched or legacy-file fallback is visible where the plan is read rather
 * than silent (issue #205, ADR-0015 rule 4).
 */
function renderProvenance(provenance: PlanProvenance | undefined): string | undefined {
  if (!provenance) return undefined
  const label = credentialLabel(provenance.source)
  if (provenance.account === undefined) return `Credential: ${label}`
  return `Account: \`${provenance.account}\` — credential: ${label}`
}

export function renderPlanSummary(
  plan: PlanId | undefined,
  deals: Readonly<Record<string, ModelDeals>> = MODEL_DEALS,
  catalog: Readonly<Record<PlanId, PlanInfo>> = PLAN_CATALOG,
  provenance?: PlanProvenance,
): string {
  const lines: string[] = []
  lines.push(`# Command Code plan: ${plan ? PLAN_DISPLAY[plan] : "unknown"}`)
  const provenanceLine = renderProvenance(provenance)
  if (provenanceLine) lines.push(provenanceLine)
  if (plan === undefined) {
    lines.push(
      "The plan could not be detected — no `plan` argument or COMMANDCODE_PLAN override, and the Command Code API reported no active subscription (or could not be reached).",
    )
    lines.push(
      "Pass `plan` or set COMMANDCODE_PLAN to pin it: go|goat|pro|max|max20|teampro|provider.",
    )
    lines.push(
      "No allowance or deal figures are shown rather than reporting a plan you may not be on.",
    )
    lines.push("See https://commandcode.ai/docs/resources/pricing-limits for the live table.")
    return lines.join("\n")
  }
  const info = catalog[plan]
  if (plan === "provider") {
    lines.push("pay-as-you-go at model API rates — no monthly allowances or window caps.")
  } else if (info) {
    lines.push(
      `$${info.price}/mo buys $${info.credits} of credits; 5-hour window $${info.window5h}, weekly window $${info.windowWeek}.`,
    )
    if (plan !== "goat" && plan !== "pro") {
      lines.push(
        "This plan has no per-model allowances — active deals apply to your full credit balance at the discounted rates below.",
      )
    }
  }
  const rows = Object.entries(deals).filter(([, d]) => d.allowance?.[plan] !== undefined)
  const freeRows = Object.entries(deals).filter(([id, d]) => d.free && !d.allowance?.[plan])
  const hasAllowances = plan === "goat" || plan === "pro"
  const dealRows = hasAllowances
    ? []
    : Object.entries(deals).filter(([, d]) => d.discount || d.peakOffPeak)
  if (rows.length === 0 && freeRows.length === 0 && dealRows.length === 0) {
    lines.push("No deal data is bundled for this plan.")
    lines.push("See https://commandcode.ai/docs/resources/pricing-limits for the live table.")
    return lines.join("\n")
  }
  lines.push("")
  if (hasAllowances) {
    lines.push("| Model | $/mo allowance | ~requests/mo | Deal |")
    lines.push("| --- | --- | --- | --- |")
  } else {
    lines.push("| Model | Deal | Rates |")
    lines.push("| --- | --- | --- |")
  }
  for (const [id, d] of [...rows, ...freeRows, ...dealRows]) {
    const safeId = id.replace(/[|`]/g, " ")
    const dealBits: string[] = []
    if (d.free) dealBits.push("FREE")
    if (d.discount)
      dealBits.push(
        `${d.discount.pct}% off${d.discount.endsAt ? ` until ${d.discount.endsAt}` : ""}`,
      )
    if (d.peakOffPeak) dealBits.push(`peak/off-peak (${d.peakOffPeak.windows})`)
    const dealText = dealBits.join("; ") || "—"
    if (hasAllowances) {
      const allowance = d.allowance?.[plan]
      const estimate =
        allowance && d.free === false
          ? estimateMonthlyRequests(id, allowance).toLocaleString("en-US")
          : "—"
      lines.push(
        `| \`${safeId}\` | ${allowance !== undefined ? `$${allowance}` : "free"} | ${estimate} | ${dealText} |`,
      )
    } else {
      const rates =
        d.discount && d.was
          ? `was $${d.was.input}/$${d.was.output} in/out`
          : d.peakOffPeak
            ? `$${d.peakOffPeak.peak.input}/$${d.peakOffPeak.peak.output} peak`
            : "—"
      lines.push(`| \`${safeId}\` | ${dealText} | ${rates} |`)
    }
  }
  lines.push("")
  lines.push("Estimates assume ~800 fresh input + 50K cache-read + 200 output tokens per request.")
  lines.push("Source: https://commandcode.ai/docs/resources/pricing-limits")
  return lines.join("\n")
}

function estimateMonthlyRequests(modelId: string, allowance: number): number {
  const cost = MODEL_COSTS[modelId]
  // No cost row bundled (e.g. not yet in the snapshot): the allowance is the
  // best estimate we have, so report it directly as a placeholder.
  if (!cost) return Math.round(allowance)
  const perRequest =
    (REQUEST_PROFILE.input * cost.input +
      REQUEST_PROFILE.output * cost.output +
      REQUEST_PROFILE.cacheRead * cost.cacheRead) /
    1_000_000
  if (perRequest <= 0) return Math.round(allowance)
  return Math.floor(allowance / perRequest + 1e-9)
}

/**
 * The tool's description and argument contract, shared verbatim by both hosts
 * so a v1 and a v2 session see the same tool (ADR-0010). v1 builds it with the
 * `tool()` zod helper, v2 with a plain JSON Schema.
 */
export const PLAN_SUMMARY_DESCRIPTION =
  "Show the Command Code plan's credits, usage windows, per-model monthly allowances (GOAT/Pro) or active deals (other plans), with estimated monthly request counts. The plan is detected from the account's billing subscription; pass the `plan` argument or set COMMANDCODE_PLAN (go|goat|pro|max|max20|teampro|provider) to pin it without network access. When no plan can be detected the summary says so instead of guessing."
export const PLAN_SUMMARY_ARG_DESCRIPTION = "go|goat|pro|max|max20|teampro|provider"

/**
 * Credential seam for the tool path: `apiKey` and the Host getter below feed
 * the ADR-0015 ladder, then `resolveApiKeyWithSource`, whose precedence
 * (opencode /connect credential → COMMANDCODE_API_KEY → legacy auth files) is
 * the same one the provider transport uses. Without the seam the lookup needed
 * an exported env var and skipped the request entirely (issue #159); which rung
 * answered is rendered back (issue #205).
 */
export interface PlanSummaryOptions {
  apiKey?: string
  authPaths?: readonly string[]
  baseURL?: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  /**
   * The credential the Host resolved for the provider (issue #201). Consulted
   * after an explicit `apiKey` and before `COMMANDCODE_API_KEY` and the legacy
   * files, because only the Host knows which credential the session streams
   * with: v2 keeps it in its own store and injects it into the provider SDK
   * only, and v1 exposes it through the plugin's SDK client (ADR-0015).
   *
   * The remaining ladder is untouched — it mirrors the transport's own
   * fallback — and a getter that yields `undefined`, or rejects, falls through
   * to it, so a Host that cannot answer costs the summary nothing (ADR-0011:
   * unknown, never a guessed account).
   */
  hostCredential?: () => Promise<HostCredential | undefined>
}

/**
 * A Host that cannot produce a credential must not fail the lookup: its
 * refusal — `undefined` or a rejection — is just the next rung of the ladder.
 */
async function readHostCredential(
  getter: (() => Promise<HostCredential | undefined>) | undefined,
): Promise<HostCredential | undefined> {
  if (!getter) return undefined
  try {
    const credential = await getter()
    return credential?.key ? credential : undefined
  } catch {
    return undefined
  }
}

/** A key the summary will look up with, plus the rung it came from. */
interface ToolCredential {
  key: string
  source: PlanSource
}

/**
 * The credential the lookup uses, in the ADR-0015 order: an explicit `apiKey`,
 * then the Host's own credential, then this package's ladder. The rung travels
 * with the key so the rendered line can name it (issue #205).
 */
async function resolveToolCredential(
  options: PlanSummaryOptions,
): Promise<ToolCredential | undefined> {
  if (options.apiKey) {
    return { key: options.apiKey, source: { kind: "ladder", rung: { kind: "option" } } }
  }
  const host = await readHostCredential(options.hostCredential)
  if (host) return { key: host.key, source: { kind: "host", source: host.source } }

  const env = options.env ?? process.env
  const ladder = resolveApiKeyWithSource({ env, authPaths: options.authPaths })
  if (!ladder) return undefined
  return { key: ladder.key, source: { kind: "ladder", rung: ladder.source } }
}

async function resolveToolPlan(
  planArg: string | undefined,
  options: PlanSummaryOptions,
): Promise<PlanResolution> {
  const env = options.env ?? process.env
  // A pin needs no credential: resolving it first keeps a pinned summary free
  // of both the network and the Host round-trip (ADR-0011 §2), and the pin is
  // then the provenance it renders — no identity is worth a request (issue #205).
  const fromArg = normalizePlan(planArg)
  if (fromArg) return { plan: fromArg, provenance: { source: { kind: "pin", via: "argument" } } }
  const fromEnv = normalizePlan(env.COMMANDCODE_PLAN)
  if (fromEnv) {
    return { plan: fromEnv, provenance: { source: { kind: "pin", via: "environment" } } }
  }

  const credential = await resolveToolCredential(options)
  if (!credential) return { plan: undefined, provenance: { source: { kind: "none" } } }

  const lookup = await fetchBillingPlan(env, {
    apiKey: credential.key,
    baseURL: options.baseURL,
    fetch: options.fetch,
  })
  return {
    plan: lookup.plan,
    provenance: {
      ...(lookup.account === undefined ? {} : { account: lookup.account }),
      source: credential.source,
    },
  }
}

/** One rendering for both hosts: the plan's summary plus its provenance. */
function renderResolution(resolution: PlanResolution): string {
  return renderPlanSummary(resolution.plan, MODEL_DEALS, PLAN_CATALOG, resolution.provenance)
}

export function planSummaryTool(options: PlanSummaryOptions = {}) {
  return {
    description: PLAN_SUMMARY_DESCRIPTION,
    args: {
      plan: z.string().optional().describe(PLAN_SUMMARY_ARG_DESCRIPTION),
    },
    execute: async (args: { plan?: string }) =>
      renderResolution(await resolveToolPlan(args.plan, options)),
  }
}

export interface PlanSummaryInput {
  plan?: string
}

/**
 * v2 tool definition (ADR-0010): the Promise API takes JSON Schema input and
 * returns structured content, so the rendered summary moves into
 * `{ content }` unchanged. Same name, description, argument, and rendering as
 * the v1 tool — `cmd_plan_summary` behaves identically in either host.
 */
export function planSummaryV2Tool(
  options: PlanSummaryOptions = {},
): V2ToolDefinition<PlanSummaryInput> {
  return {
    name: "cmd_plan_summary",
    description: PLAN_SUMMARY_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        plan: { type: "string", description: PLAN_SUMMARY_ARG_DESCRIPTION },
      },
      additionalProperties: false,
    },
    execute: async (input) => ({
      content: renderResolution(await resolveToolPlan(input?.plan, options)),
    }),
  }
}
