// src/plugin/models.ts — catalog → opencode Model mapping (PLAN #11)
import type { Model } from "@opencode-ai/sdk/v2"
import type { CommandCodeModel } from "../provider/models.js"
import { MODEL_COSTS, ZERO_MODEL_COST } from "../provider/pricing.js"
import { isReasoningModel, thinkingMetadataForModel } from "../provider/reasoning.js"
import { inputModalitiesForModel } from "../provider/modalities.js"

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536

export interface CatalogMappingOptions {
  npm: string
  url: string
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
      options: {
        ...(thinkingMetadataForModel(model.id)
          ? { thinking: thinkingMetadataForModel(model.id) }
          : {}),
      },
      headers: {},
      release_date: "",
    }
  }
  return out
}
