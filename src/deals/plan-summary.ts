// src/deals/plan-summary.ts — cmd_plan_summary tool: plan-aware allowance
// breakdown. Plan resolution: tool arg → COMMANDCODE_PLAN → the account's
// billing subscription (issue #159). There is deliberately no fallback plan —
// "detected Go" and "could not tell" stay distinguishable, and an unresolved
// plan renders as unknown rather than silently asserting Go's numbers.
//
// Transport selection never calls this lookup: the provider transport honours
// only an explicitly written plan pin, so no request is made merely to route
// (see src/provider/command-code-model.ts). Rendering is a pure function so
// tests never touch the network.
import { z } from "zod"
import { MODEL_COSTS } from "../catalog/facts.js"
import { normalizePlan, type PlanId } from "../catalog/plans.js"
import { getApiBase } from "../env.js"
import { resolveApiKey, type HostCredential } from "../provider/auth-key.js"
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
   * COMMANDCODE_API_KEY env var). The tool path passes `resolveApiKey()`, so
   * an opencode /connect credential resolves without an exported env var. */
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
  return await fetchBillingPlan(env, options)
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
 */
async function fetchBillingPlan(
  env: NodeJS.ProcessEnv,
  options: ResolvePlanOptions,
): Promise<PlanId | undefined> {
  const key = options.apiKey ?? env.COMMANDCODE_API_KEY
  if (!key) return undefined // no credential → no request and no guessed plan
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
  const scoped = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""

  const subscriptions = await getJson(`/alpha/billing/subscriptions${scoped}`)
  const subscription =
    isRecord(subscriptions) && isRecord(subscriptions.data) ? subscriptions.data : undefined
  const status = subscription ? stringValue(subscription.status) : undefined
  if (subscription && status && PLAN_BEARING_SUBSCRIPTION_STATUSES.has(status)) {
    const plan = normalizePlan(subscription.planId)
    if (plan) return plan
  }

  const credits = await getJson(`/alpha/billing/credits${scoped}`)
  return normalizePlan(
    isRecord(credits) && isRecord(credits.credits) ? credits.credits.planId : undefined,
  )
}

const REQUEST_PROFILE = { input: 800, output: 200, cacheRead: 50_000 }

export function renderPlanSummary(
  plan: PlanId | undefined,
  deals: Readonly<Record<string, ModelDeals>> = MODEL_DEALS,
  catalog: Readonly<Record<PlanId, PlanInfo>> = PLAN_CATALOG,
): string {
  const lines: string[] = []
  lines.push(`# Command Code plan: ${plan ? PLAN_DISPLAY[plan] : "unknown"}`)
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
 * Credential seam for the tool path: forwarded to `resolveApiKey`, whose
 * precedence (opencode /connect credential → COMMANDCODE_API_KEY → legacy auth
 * files) is the same one the provider transport uses. Without it the lookup
 * needed an exported env var and skipped the request entirely (issue #159).
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
async function hostCredentialKey(
  getter: (() => Promise<HostCredential | undefined>) | undefined,
): Promise<string | undefined> {
  if (!getter) return undefined
  try {
    const credential = await getter()
    return credential?.key ? credential.key : undefined
  } catch {
    return undefined
  }
}

async function resolveToolPlan(
  planArg: string | undefined,
  options: PlanSummaryOptions,
): Promise<PlanId | undefined> {
  const env = options.env ?? process.env
  // A pin needs no credential: resolving it first keeps a pinned summary free
  // of both the network and the Host round-trip (ADR-0011 §2).
  const pinned = normalizePlan(planArg) ?? normalizePlan(env.COMMANDCODE_PLAN)
  if (pinned) return pinned
  return await resolvePlan(undefined, env, {
    apiKey: resolveApiKey({
      apiKey: options.apiKey || (await hostCredentialKey(options.hostCredential)),
      env,
      authPaths: options.authPaths,
    }),
    baseURL: options.baseURL,
    fetch: options.fetch,
  })
}

export function planSummaryTool(options: PlanSummaryOptions = {}) {
  return {
    description: PLAN_SUMMARY_DESCRIPTION,
    args: {
      plan: z.string().optional().describe(PLAN_SUMMARY_ARG_DESCRIPTION),
    },
    execute: async (args: { plan?: string }) =>
      renderPlanSummary(await resolveToolPlan(args.plan, options)),
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
      content: renderPlanSummary(await resolveToolPlan(input?.plan, options)),
    }),
  }
}
