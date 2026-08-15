// src/plugin/models.ts — catalog → opencode Model mapping (PLAN #11)
import type { Config, Model, ProviderConfig } from "@opencode-ai/sdk/v2"
import type { CommandCodeModel } from "../provider/models.js"
import { MODEL_COSTS, ZERO_MODEL_COST } from "../provider/pricing.js"
import { isReasoningModel, reasoningVariantsForModel } from "../provider/reasoning.js"
import { inputModalitiesForModel } from "../provider/modalities.js"

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536

type ConfigModel = NonNullable<NonNullable<ProviderConfig["models"]>[string]>
type ConfigVariants = NonNullable<ConfigModel["variants"]>

export interface CatalogMappingOptions {
  npm: string
  url: string
}

/**
 * Augments config-declared commandcode models with reasoning metadata and
 * variants so opencode's `ctrl+t` can cycle reasoning effort.
 *
 * opencode only invokes a plugin's `provider.models` hook for providers that
 * already exist in its models.dev catalog; `commandcode` is not in that catalog,
 * so models reach the session through the config-declared `provider.commandcode
 * .models` map. That config shape supports `reasoning` and `variants`, which the
 * `config` hook can populate before the provider is built.
 *
 * In-place mutation of the config object (the plugin `config` hook contract).
 */
export function augmentConfigCommandCodeModels(config: Config): void {
  const provider = config.provider?.["commandcode"]
  if (!provider?.models) return
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!model) continue
    const variants = reasoningVariantsForModel(modelId)
    if (variants) {
      model.reasoning = true
      model.variants = variants as ConfigVariants
    }
  }
}

export function catalogToOpenCodeModels(
  models: readonly CommandCodeModel[],
  options: CatalogMappingOptions,
): Record<string, Model> {
  const out: Record<string, Model> = {}
  for (const model of models) {
    const costs = MODEL_COSTS[model.id] ?? ZERO_MODEL_COST
    const modalities = inputModalitiesForModel(model.id)
    out[model.id] = {
      id: model.id,
      providerID: "commandcode",
      api: { id: model.id, url: options.url, npm: options.npm },
      name: model.name,
      capabilities: {
        temperature: false,
        reasoning: isReasoningModel(model.id),
        attachment: modalities.includes("image"),
        toolcall: true,
        input: {
          text: true,
          image: modalities.includes("image"),
          audio: false,
          video: false,
          pdf: false,
        },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: costs.input,
        output: costs.output,
        cache: { read: costs.cacheRead, write: costs.cacheWrite },
      },
      limit: {
        context: model.contextWindow,
        output: Math.min(model.contextWindow, DEFAULT_MAX_OUTPUT_TOKENS),
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "",
      variants: reasoningVariantsForModel(model.id) ?? {},
    }
  }
  return out
}
