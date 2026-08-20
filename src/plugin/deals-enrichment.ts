// src/plugin/deals-enrichment.ts — docs-derived model enrichment for the
// config hook. Purely additive: every field is gap-filled only when the user
// left it unset, and every lookup is guarded so missing/empty deal data
// leaves the config byte-identical to today's output (degradation contract).
import type { Config } from "@opencode-ai/sdk/v2"
import { MODEL_DEALS, type ModelDeals } from "../catalog/deals.js"
import { vendorFamilyForModel } from "./vendor.js"

export function enrichCommandCodeModels(
  config: Config,
  deals: Readonly<Record<string, ModelDeals>> = MODEL_DEALS,
): void {
  const provider = config.provider?.["commandcode"]
  if (!provider?.models) return
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!model) continue
    const entry = deals[modelId]
    if (!entry) continue
    if (model.family === undefined) {
      const family = vendorFamilyForModel(modelId)
      if (family !== undefined) model.family = family
    }
    if (model.options?.["cmd"] === undefined) {
      model.options ??= {}
      model.options["cmd"] = buildCmdOptions(entry)
    }
    if (entry.overContext && model.cost?.["context_over_200k"] === undefined) {
      const c = entry.overContext
      // Only the higher-context tier is carried here; the SDK `cost` type
      // requires base input/output, so the unset branch is cast.
      model.cost ??= {} as never
      model.cost["context_over_200k"] = {
        input: c.input,
        output: c.output,
        cache_read: c.cacheRead,
        cache_write: c.cacheWrite,
      }
    }
  }
}

export function buildCmdOptions(deals: ModelDeals): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (deals.tier !== undefined) out.tier = deals.tier
  if (deals.allowance !== undefined && Object.keys(deals.allowance).length > 0) {
    out.allowance = deals.allowance
  }
  if (deals.discount !== undefined) out.discount = deals.discount
  if (deals.was !== undefined) out.was = deals.was
  if (deals.now !== undefined) out.now = deals.now
  if (deals.benchmark !== undefined) out.benchmark = deals.benchmark
  if (deals.peakOffPeak !== undefined) out.peakOffPeak = deals.peakOffPeak
  if (deals.overContext !== undefined) out.overContext = deals.overContext
  out.free = deals.free
  return out
}
