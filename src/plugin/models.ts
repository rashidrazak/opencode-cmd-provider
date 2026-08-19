// src/plugin/models.ts — snapshot → config auto-registration (issue #16)
import type { Config, ProviderConfig } from "@opencode-ai/sdk/v2"
import type { CatalogModel } from "../catalog/snapshot.js"
import { MODEL_COSTS, ZERO_MODEL_COST, type CommandCodeModelCost } from "../provider/pricing.js"
import { reasoningVariantsForModel, isReasoningModel } from "../provider/reasoning.js"
import { inputModalitiesForModel } from "../provider/modalities.js"

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536

type ConfigModel = NonNullable<NonNullable<ProviderConfig["models"]>[string]>
type ConfigVariants = NonNullable<ConfigModel["variants"]>

export interface AutoRegisterOptions {
  npm: string
  name: string
  baseURL: string
}

/**
 * Registers the `commandcode` provider entry into opencode's config so every
 * snapshot model is available without any user declaration.
 *
 * opencode only invokes a plugin's `provider.models` hook for providers that
 * already exist in its models.dev catalog; `commandcode` is not in that
 * catalog, so models reach the session through the config-declared
 * `provider.commandcode.models` map. The `config` hook runs before opencode
 * reads `config.provider` and honors in-place mutation (ADR-0001), which makes
 * this the only zero-declaration mechanism available today.
 *
 * Pure function: takes a config and a snapshot, mutates and returns the config.
 * Merge semantics — the user's declared entry always wins:
 * - provider-level keys (`npm`, `name`, `env`, `options.baseURL`) are filled
 *   only when unset;
 * - snapshot models are added only when no declared model claims the id (by
 *   config key or by the entry's `id`);
 * - declared models are never modified, and declared models that left the
 *   catalog stay usable.
 */
export function autoRegister(
  config: Config,
  snapshot: readonly CatalogModel[],
  options: AutoRegisterOptions,
): Config {
  if (snapshot.length === 0) return config

  const provider = (config.provider ??= {})
  const entry = (provider["commandcode"] ??= {}) as ProviderConfig
  entry.npm ??= options.npm
  entry.name ??= options.name
  entry.env ??= ["COMMANDCODE_API_KEY"]
  entry.options ??= {}
  entry.options.baseURL ??= options.baseURL
  entry.models ??= {}

  const declaredById = new Set(
    Object.values(entry.models)
      .map((model) => model?.id)
      .filter((id): id is string => typeof id === "string"),
  )

  for (const model of snapshot) {
    if (entry.models[model.id] !== undefined || declaredById.has(model.id)) continue
    entry.models[model.id] = configModelFor(model)
  }
  return config
}

/**
 * Augments config-declared commandcode models with reasoning metadata and
 * variants so opencode's `ctrl+t` can cycle reasoning effort.
 *
 * Gap-fill only: a user-declared `reasoning` value is never overwritten, and
 * no variants are injected when the user explicitly disabled reasoning
 * (variants without `reasoning: true` would make `ctrl+t` cycle an effort the
 * model was told not to use).
 *
 * In-place mutation of the config object (the plugin `config` hook contract).
 */
export function augmentConfigCommandCodeModels(config: Config): void {
  const provider = config.provider?.["commandcode"]
  if (!provider?.models) return
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!model) continue
    if (model.reasoning === undefined && isReasoningModel(modelId)) model.reasoning = true
    if (model.reasoning === false) continue
    const variants = reasoningVariantsForModel(modelId)
    if (variants) {
      model.variants = variants as ConfigVariants
    }
  }
}

/**
 * Config-schema model entry (not the SDK `Model` shape) for a snapshot model:
 * `[CMD]`-prefixed display name, context/output limits with output capped at
 * 65_536, and metadata enriched from the reasoning, modality, and pricing
 * tables.
 */
function configModelFor(model: CatalogModel): ConfigModel {
  const variants = reasoningVariantsForModel(model.id)
  const costs: CommandCodeModelCost = MODEL_COSTS[model.id] ?? ZERO_MODEL_COST
  return {
    name: `[CMD] ${model.name}`,
    limit: {
      context: model.contextLength,
      output: Math.min(model.contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
    },
    reasoning: isReasoningModel(model.id) ? true : undefined,
    variants: variants as ConfigVariants | undefined,
    // `tool_call: true` advertises tool use (the runtime already sends tools).
    // `attachment` is deliberately unset: Command Code's published catalog
    // exposes no per-model attachment support, and the runtime converter only
    // handles text + image content parts — claiming attachment support would
    // promise file uploads the plugin cannot deliver.
    tool_call: true,
    modalities: {
      input: [...inputModalitiesForModel(model.id)],
    },
    cost: {
      input: costs.input,
      output: costs.output,
      cache_read: costs.cacheRead,
      cache_write: costs.cacheWrite,
    },
    status: "active",
  }
}
