// src/provider/cost.ts — local cost calculation for Command Code usage
// (PLAN #6, port of pi's cost.ts; tier logic and longWrite arithmetic verbatim)
import type { CommandCodeModelCost } from "./pricing.js"

export interface CostUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface CostModel {
  cost: CommandCodeModelCost
}

export function calculateCommandCodeCost(model: CostModel, usage: CostUsage): void {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite
  let rates = model.cost
  let matchedThreshold = -1
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier
      matchedThreshold = tier.inputTokensAbove
    }
  }

  const longWrite = usage.cacheWrite1h ?? 0
  const shortWrite = usage.cacheWrite - longWrite
  usage.cost.input = (rates.input / 1_000_000) * usage.input
  usage.cost.output = (rates.output / 1_000_000) * usage.output
  usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead
  usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite
}
