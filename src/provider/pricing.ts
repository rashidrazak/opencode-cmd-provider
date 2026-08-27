// src/provider/pricing.ts — Command Code model pricing types + cost table.
// MODEL_COSTS is GENERATED (src/catalog/facts.ts) — see FACTS_SOURCE_URL.
import {
  MODEL_COSTS,
  FACTS_SOURCE_URL as PRICING_SOURCE_URL,
  FACTS_LAST_REFRESHED as PRICING_LAST_VERIFIED,
} from "../catalog/facts.js"

export { MODEL_COSTS, PRICING_SOURCE_URL, PRICING_LAST_VERIFIED }

export interface CommandCodeModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface CommandCodeModelCost extends CommandCodeModelCostRates {}

export const ZERO_MODEL_COST: CommandCodeModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

/**
 * True when every rate is zero — the model is served free (e.g. the MiniMax
 * M3 / M2.7 free variants). Used to disambiguate display names: the upstream
 * catalog names the paid and free variants identically (`MiniMax M3`), so the
 * auto-registered picker entry appends `(free)` when this matches.
 */
export function isFreeModelCost(cost: CommandCodeModelCost | undefined): boolean {
  return (
    cost !== undefined &&
    cost.input === 0 &&
    cost.output === 0 &&
    cost.cacheRead === 0 &&
    cost.cacheWrite === 0
  )
}
