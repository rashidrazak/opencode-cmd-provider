// src/provider/cost.ts — local cost calculation for Command Code usage
// (PLAN #6, port of pi's cost.ts; longWrite arithmetic verbatim)
import type { LanguageModelV3Usage } from "@ai-sdk/provider"
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

/**
 * Maps an emitted AI SDK v3 usage onto billable token counts: fresh input
 * (`noCache`), cache read, and cache write each bill at their own rate, so
 * the cache-inclusive `total` must not be billed as fresh input (issue #36).
 */
export function costUsageFromAiSdkUsage(usage: LanguageModelV3Usage): CostUsage {
  return {
    input: usage.inputTokens.noCache ?? 0,
    output: usage.outputTokens.total ?? 0,
    cacheRead: usage.inputTokens.cacheRead ?? 0,
    cacheWrite: usage.inputTokens.cacheWrite ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

export function calculateCommandCodeCost(model: CostModel, usage: CostUsage): void {
  const rates = model.cost

  const longWrite = usage.cacheWrite1h ?? 0
  const shortWrite = usage.cacheWrite - longWrite
  usage.cost.input = (rates.input / 1_000_000) * usage.input
  usage.cost.output = (rates.output / 1_000_000) * usage.output
  usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead
  usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite
}
