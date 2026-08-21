// src/deals/plan-summary.ts — cmd_plan_summary tool: plan-aware allowance
// breakdown. Plan resolution: tool arg → COMMANDCODE_PLAN → live /alpha/whoami
// (when a key is present and the network works) → default "go". Rendering is a
// pure function so tests never touch the network.
import { tool } from "@opencode-ai/plugin"
import { MODEL_COSTS } from "../catalog/facts.js"
import {
  MODEL_DEALS,
  PLAN_CATALOG,
  type ModelDeals,
  type PlanId,
  type PlanInfo,
} from "./catalog.js"
import { getApiBase } from "../env.js"

const PLAN_DISPLAY: Record<PlanId, string> = {
  go: "Go",
  goat: "GOAT",
  pro: "Pro",
  max: "Max 10×",
  max20: "Max 20×",
  teampro: "Team Pro",
  provider: "Provider",
}

const PLAN_ALIASES: Readonly<Record<string, PlanId>> = {
  go: "go",
  "individual-go": "go",
  goat: "goat",
  "individual-goat": "goat",
  pro: "pro",
  "individual-pro": "pro",
  "individual-pro-v1": "pro",
  max: "max",
  max10: "max",
  "max-10x": "max",
  "max 10x": "max",
  "individual-max": "max",
  max20: "max20",
  "max-20x": "max20",
  "max 20x": "max20",
  "individual-ultra": "max20",
  ultra: "max20",
  teampro: "teampro",
  "team-pro": "teampro",
  "team pro": "teampro",
  provider: "provider",
  "individual-provider": "provider",
}

export function normalizePlan(value: unknown): PlanId | undefined {
  if (typeof value !== "string") return undefined
  return PLAN_ALIASES[value.toLowerCase()]
}

export async function resolvePlan(
  planArg: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlanId> {
  const fromArg = normalizePlan(planArg)
  if (fromArg) return fromArg
  const fromEnv = normalizePlan(env.COMMANDCODE_PLAN)
  if (fromEnv) return fromEnv
  if (env.COMMANDCODE_API_KEY) {
    try {
      const response = await fetch(`${getApiBase(env)}/alpha/whoami`, {
        headers: { authorization: `Bearer ${env.COMMANDCODE_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) {
        const body = (await response.json()) as {
          planId?: unknown
          plan?: { id?: unknown }
        }
        const plan = normalizePlan(body.planId ?? body.plan?.id)
        if (plan) return plan
      }
    } catch {
      // offline or unreachable — fall through to the default
    }
  }
  return "go"
}

const REQUEST_PROFILE = { input: 800, output: 200, cacheRead: 50_000 }

export function renderPlanSummary(
  plan: PlanId,
  deals: Readonly<Record<string, ModelDeals>> = MODEL_DEALS,
  catalog: Readonly<Record<PlanId, PlanInfo>> = PLAN_CATALOG,
): string {
  const info = catalog[plan]
  const lines: string[] = []
  lines.push(`# Command Code plan: ${PLAN_DISPLAY[plan]}`)
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

export function planSummaryTool() {
  return tool({
    description:
      "Show the Command Code plan's credits, usage windows, per-model monthly allowances (GOAT/Pro) or active deals (other plans), with estimated monthly request counts. Set COMMANDCODE_PLAN (go|goat|pro|max|max20|teampro|provider) to pin the plan without network access.",
    args: {
      plan: tool.schema.string().optional().describe("go|goat|pro|max|max20|teampro|provider"),
    },
    execute: async (args) => renderPlanSummary(await resolvePlan(args.plan)),
  })
}
