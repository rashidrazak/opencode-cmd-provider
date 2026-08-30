// src/plugin/core.ts — generation-agnostic registration/enrichment core.
//
// Both the v1 config-hook surface (`autoRegister`, config-model entries) and
// the v2 catalog-transform surface (`v2ModelInfoFor`, `v2ProviderPatch`)
// consume these tables so the auto-registered model catalog — display names,
// limits, reasoning variants, modalities, costs — stays identical across
// opencode generations. Merged semantics are unchanged: user-declared entries
// always win, snapshot models fill only what is missing.
import type { Config, ProviderConfig } from "@opencode-ai/sdk/v2"
import type { CatalogModel } from "../catalog/snapshot.js"
import {
  MODEL_COSTS,
  ZERO_MODEL_COST,
  isFreeModelCost,
  type CommandCodeModelCost,
} from "../provider/pricing.js"
import { reasoningVariantsForModel, isReasoningModel } from "../provider/reasoning.js"
import { inputModalitiesForModel } from "../provider/modalities.js"
import { getApiBase } from "../env.js"

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
export const DEFAULT_DISPLAY_PREFIX = "[CMD] "
export const DISPLAY_PREFIX_OPTION = "display_prefix"

type ConfigModel = NonNullable<NonNullable<ProviderConfig["models"]>[string]>
type ConfigVariants = NonNullable<ConfigModel["variants"]>

/**
 * Resolves the auto-registration display-name prefix from the user-declared
 * `provider.commandcode.options.display_prefix` key (v1). A string value is
 * used verbatim (empty string disables the prefix); anything else falls back
 * to `[CMD] `. Read-only: never persisted into the user's config.
 */
export function resolveDisplayPrefix(entry: ProviderConfig | undefined): string {
  const value = entry?.options?.display_prefix
  return typeof value === "string" ? value : DEFAULT_DISPLAY_PREFIX
}

export interface AutoRegisterOptions {
  npm: string
  name: string
  baseURL: string
}

/** v1 auto-registration options (package name + API base). */
export function autoRegisterOptions(): AutoRegisterOptions {
  return {
    npm: "opencode-cmd-provider",
    name: "Command Code",
    baseURL: getApiBase(),
  }
}

/**
 * Registers the `commandcode` provider entry into opencode v1's config so
 * every snapshot model is available without any user declaration.
 *
 * opencode v1 only invokes a plugin's `provider.models` hook for providers
 * that already exist in its models.dev catalog; `commandcode` is not in that
 * catalog, so models reach the session through the config-declared
 * `provider.commandcode.models` map. The `config` hook runs before opencode
 * reads `config.provider` and honors in-place mutation (ADR-0001), which
 * makes this the only zero-declaration mechanism available there.
 *
 * Pure function: takes a config and a snapshot, mutates and returns the config.
 * Merge semantics — the user's declared entry always wins:
 * - provider-level keys (`npm`, `name`, `env`, `options.baseURL`) are filled
 *   only when unset;
 * - snapshot models are added only when no declared model claims the id (by
 *   config key or by the entry's `id`);
 * - declared models are never modified, and declared models that left the
 *   catalog stay usable.
 * - `options.display_prefix` (string) overrides the default `[CMD] `
 *   display-name prefix for auto-registered models; an empty string disables
 *   the prefix.
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
  // Register the env credential hint only when the user has not supplied a
  // static key in config: on affected v1 builds an empty `{env:}` substitution
  // can block `options.apiKey` (upstream #34388), and a static key makes the
  // env hint pointless either way.
  entry.options ??= {}
  if (!entry.options.apiKey) {
    entry.env ??= ["COMMANDCODE_API_KEY"]
  }
  entry.options.baseURL ??= options.baseURL
  entry.models ??= {}

  const prefix = resolveDisplayPrefix(entry)
  const declaredById = new Set(
    Object.values(entry.models)
      .map((model) => model?.id)
      .filter((id): id is string => typeof id === "string"),
  )

  for (const model of snapshot) {
    if (entry.models[model.id] !== undefined || declaredById.has(model.id)) continue
    entry.models[model.id] = configModelFor(model, prefix)
  }
  return config
}

/**
 * Augments config-declared commandcode models with reasoning metadata and
 * variants so opencode's `ctrl+t` can cycle reasoning effort (v1 surface).
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
 * Builds a v2 `Model.Info` for a snapshot model: prefixed display name,
 * context/output limits, real reasoning-effort variants (each variant's
 * `settings.reasoningEffort` is merged into the call's providerOptions by the
 * v2 runtime), input modalities, and the pricing-table cost. Returns
 * undefined when the model carries no usable metadata (never expected for
 * committed snapshots, but keeps the transform total).
 */
export function v2ModelInfoFor(
  model: CatalogModel,
  providerId: string,
  prefix = DEFAULT_DISPLAY_PREFIX,
): Record<string, unknown> | undefined {
  const costs: CommandCodeModelCost = MODEL_COSTS[model.id] ?? ZERO_MODEL_COST
  const freeSuffix = MODEL_COSTS[model.id] !== undefined && isFreeModelCost(costs) ? " (free)" : ""
  const efforts = reasoningEffortsForModel(model.id)
  return {
    id: model.id,
    modelID: model.id,
    providerID: providerId,
    name: `${prefix}${model.name}${freeSuffix}`,
    capabilities: {
      tools: true,
      input: [...inputModalitiesForModel(model.id)],
      output: ["text", "reasoning"],
    },
    variants: reasoningVariantsForModel(model.id)
      ? efforts.map((effort) => ({
          id: effort,
          settings: { reasoningEffort: effort },
        }))
      : [],
    time: { released: 0 },
    cost: [
      {
        input: costs.input,
        output: costs.output,
        cache: { read: costs.cacheRead, write: costs.cacheWrite },
      },
    ],
    status: "active",
    enabled: true,
    limit: {
      context: model.contextLength,
      output: Math.min(model.contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
    },
  }
}

/**
 * Gap-fill for a v2 provider record: fill display name when unset. The v2
 * runtime owns package routing (the plugin always claims the `aisdk:` seam)
 * and activation (auto), so a user customization story on v2 is limited to
 * what the catalog draft exposes; anything the user already set wins.
 */
export function v2ProviderPatch(_provider: unknown): { name: string } {
  return { name: "Command Code" }
}

function reasoningEffortsForModel(modelId: string): string[] {
  const variants = reasoningVariantsForModel(modelId)
  return variants ? Object.keys(variants) : []
}

/**
 * Config-schema model entry (not the SDK `Model` shape) for a snapshot model
 * (v1 surface): prefixed display name, context/output limits with output
 * capped at 65_536, and metadata enriched from the reasoning, modality, and
 * pricing tables.
 */
function configModelFor(model: CatalogModel, prefix = DEFAULT_DISPLAY_PREFIX): ConfigModel {
  const variants = reasoningVariantsForModel(model.id)
  const costs: CommandCodeModelCost = MODEL_COSTS[model.id] ?? ZERO_MODEL_COST
  // Upstream names the paid and free MiniMax variants identically
  // (`MiniMax M3` / `MiniMax M2.7`); append `(free)` to the picker entry so
  // users can tell them apart. Data-driven from the zero cost table — a model
  // is only "free" when the catalog has an actual zero-cost entry (an absent
  // entry falls back to ZERO_MODEL_COST and is NOT free).
  const freeSuffix = MODEL_COSTS[model.id] !== undefined && isFreeModelCost(costs) ? " (free)" : ""
  return {
    name: `${prefix}${model.name}${freeSuffix}`,
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
