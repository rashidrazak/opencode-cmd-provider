// src/catalog/plans.ts — Command Code plan identity (Core).
//
// The plan vocabulary this package works in, plus the alias table mapping the
// ids the Command Code API and CLI use (`individual-go`, `individual-pro-v1`,
// `teams-pro`, …), the display spellings, and the bare ids onto it. Core owns
// this module because transport selection must recognise an explicit
// `plan=go` pin to pick the legacy transport, and Core never imports the
// excisable Deals slice (ADR-0004): the plan lookup that feeds
// `cmd_plan_summary` lives in `src/deals/plan-summary.ts` and reads
// `PlanId`/`normalizePlan` from here.
export type PlanId = "go" | "goat" | "pro" | "max" | "max20" | "teampro" | "provider"

/**
 * Aliases as returned by `GET /alpha/billing/subscriptions` (`planId`), as
 * accepted by the CLI, and as written by hand in `COMMANDCODE_PLAN` / the
 * model's `plan` option. Matched case-insensitively; anything else is not a
 * plan and normalizes to undefined rather than guessing.
 */
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
  "teams-pro": "teampro",
  provider: "provider",
  "individual-provider": "provider",
}

/** Normalizes a plan id/alias to this package's vocabulary; undefined when the
 * value is not a known plan (never a default — see issue #159). */
export function normalizePlan(value: unknown): PlanId | undefined {
  if (typeof value !== "string") return undefined
  return PLAN_ALIASES[value.toLowerCase()]
}
