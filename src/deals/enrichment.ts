// src/deals/enrichment.ts — docs-derived model enrichment for the config hook
// (v1) and the provider transform (v2). Purely additive: every field is
// gap-filled only when the user left it unset. When the Deals catalog is empty
// the mitigated state is visible: `cmd.unavailable` is injected instead of
// leaving `cmd` absent, while `family`/`cost` are preserved and Declared `cmd`
// is never overwritten.
import type { Config } from "@opencode-ai/sdk/v2"
import type { V2ProviderEditor } from "../plugin/v2-types.js"
import { MODEL_DEALS, type ModelDeals } from "./catalog.js"
import { vendorFamilyForModel } from "./vendor.js"

/** Provider id both hosts register under — the enrichment's only target. */
const PROVIDER_ID = "commandcode"
/** Context threshold of the over-200k rate tier, keyed `context_over_200k` in v1. */
const OVER_CONTEXT_TIER_SIZE = 200_000

export function enrichCommandCodeModels(
  config: Config,
  deals: Readonly<Record<string, ModelDeals>> = MODEL_DEALS,
): void {
  const provider = config.provider?.["commandcode"]
  if (!provider?.models) return
  const isEmpty = Object.keys(deals).length === 0
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!model) continue
    if (model.family === undefined) {
      const family = vendorFamilyForModel(modelId)
      if (family !== undefined) model.family = family
    }
    const entry = deals[modelId]
    if (!entry) {
      if (isEmpty && model.options?.["cmd"] === undefined) {
        model.options ??= {}
        model.options["cmd"] = { unavailable: true }
      }
      continue
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

/**
 * v2 counterpart of `enrichCommandCodeModels` (ADR-0010), run as a provider
 * transform extension right after Auto-registration. Field-by-field the same
 * gap-fill against the same Deals catalog:
 *  - `family` ← the vendor table;
 *  - `options.cmd` → `settings.cmd` (v2 settings are the model's provider
 *    options);
 *  - `cost.context_over_200k` → a `cost` entry tiered at 200k tokens — v2's
 *    cost shape is an array of context tiers, so the over-200k rate is the
 *    tiered entry rather than a sibling key.
 * Declared values are never overwritten, and an empty Deals catalog still
 * surfaces `{ unavailable: true }` instead of a silent gap.
 */
export function enrichCommandCodeModelsV2(
  editor: V2ProviderEditor,
  deals: Readonly<Record<string, ModelDeals>> = MODEL_DEALS,
): void {
  const record = editor.get(PROVIDER_ID)
  if (!record) return
  const isEmpty = Object.keys(deals).length === 0
  for (const [modelId, current] of record.models) {
    const entry = deals[modelId]
    const family = current.family === undefined ? vendorFamilyForModel(modelId) : undefined
    editor.models.update(PROVIDER_ID, modelId, (model) => {
      if (family !== undefined && model.family === undefined) model.family = family
      if (!entry) {
        if (isEmpty && model.settings?.["cmd"] === undefined) {
          model.settings ??= {}
          model.settings["cmd"] = { unavailable: true }
        }
        return
      }
      if (model.settings?.["cmd"] === undefined) {
        model.settings ??= {}
        model.settings["cmd"] = buildCmdOptions(entry)
      }
      if (entry.overContext !== undefined && !hasOverContextTier(model)) {
        const c = entry.overContext
        model.cost.push({
          tier: { type: "context", size: OVER_CONTEXT_TIER_SIZE },
          input: c.input,
          output: c.output,
          cache: { read: c.cacheRead, write: c.cacheWrite },
        })
      }
    })
  }
}

function hasOverContextTier(model: {
  cost: readonly { tier?: { type: "context"; size: number } }[]
}): boolean {
  return model.cost.some(
    (entry) => entry.tier?.type === "context" && entry.tier.size === OVER_CONTEXT_TIER_SIZE,
  )
}
