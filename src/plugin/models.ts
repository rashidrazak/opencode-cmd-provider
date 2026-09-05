// src/plugin/models.ts — snapshot → config auto-registration (issue #16)
import type { Config, ProviderConfig } from "@opencode-ai/sdk/v2"
import type { CatalogModel } from "../catalog/snapshot.js"
import { isFreeModelCost } from "../provider/pricing.js"
import { reasoningVariantsForModel, isReasoningModel } from "../provider/reasoning.js"
import { inputModalitiesForModel } from "../provider/modalities.js"

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
export const DEFAULT_DISPLAY_PREFIX = "[CMD] "
// Context advertised for a snapshot row whose models.md Context cell is
// missing ("—"): the row ships as pending-context (issue #130) and the
// fallback ladder lands in #132. OpenCode requires a numeric limit, so a
// conservative placeholder keeps the model usable — it is deliberately
// NOT the listing API's value (the API wins no ship-bar field) and NOT
// any carried-forward number: a reviewer sees the real gap in the
// refresh log's "context pending" note and the #132 ladder resolves it.
const PENDING_CONTEXT_LENGTH = 128_000

type ConfigModel = NonNullable<NonNullable<ProviderConfig["models"]>[string]>
type ConfigVariants = NonNullable<ConfigModel["variants"]>

/**
 * Resolves the auto-registration display-name prefix from the user-declared
 * `provider.commandcode.options.display_prefix` key. A string value is used
 * verbatim (empty string disables the prefix); anything else falls back to
 * `[CMD] `. Read-only: never persisted into the user's config.
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
  entry.env ??= ["COMMANDCODE_API_KEY"]
  entry.options ??= {}
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
 * prefixed display name, context/output limits with output capped at
 * 65_536, and metadata enriched from the reasoning, modality, and pricing
 * tables.
 *
 * Ship-bar fields come from the snapshot row itself (issue #130: the
 * models.md row is the authority; the listing API wins no field):
 *  - contextLength null (the models.md Context cell was "—") falls back to
 *    the OpenCode default context — never 0, never a fabricated API value;
 *  - cost null (the price cell was "—") advertises NO cost entry — missing
 *    never zero-fills (only an explicit all-zero cell means free).
 */
function configModelFor(model: CatalogModel, prefix = DEFAULT_DISPLAY_PREFIX): ConfigModel {
  const variants = reasoningVariantsForModel(model.id)
  // The row's own parsed price is the ship-bar authority. A null cost
  // (missing models.md price cell) advertises no cost entry — the
  // zero-cost defensive fallback (ZERO_MODEL_COST) is deliberately not
  // used here: a missing price must never read as a $0 model (the parent
  // spec's "missing never zero-fills").
  const rowCost = model.cost
  const freeSuffix = rowCost !== null && isFreeModelCost(rowCost) ? " (free)" : ""
  // OpenCode requires a numeric context limit. A package row whose Context
  // cell is missing ships as pending-context (issue #130) and must not read
  // as 0 — that would advertise a broken model. PENDING_CONTEXT_LENGTH is
  // a conservative placeholder for such a row until the ladder (issue
  // #132) resolves it.
  const contextLength = model.contextLength ?? PENDING_CONTEXT_LENGTH
  return {
    name: `${prefix}${model.name}${freeSuffix}`,
    limit: {
      context: contextLength,
      output: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
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
    ...(rowCost !== null
      ? {
          cost: {
            input: rowCost.input,
            output: rowCost.output,
            cache_read: rowCost.cacheRead,
            cache_write: rowCost.cacheWrite,
          },
        }
      : {}),
    status: "active",
  }
}
