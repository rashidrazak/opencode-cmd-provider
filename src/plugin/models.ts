// src/plugin/models.ts — snapshot → host model entry (issue #16)
//
// Two hosts, two entry shapes, one Snapshot:
//  - v1: the `config` hook fills `provider.commandcode.models` (autoRegister,
//    below) — a `ConfigModel` per row;
//  - v2: the `provider.transform` fills `Model.Info` records (catalogModelForV2)
//    — see ADR-0010.
// Both derive the same Display name, limits, reasoning variants, and modality
// facts from the Snapshot row, so a model reads identically in either host.
import type { Config, ProviderConfig } from "@opencode-ai/sdk/v2"
import type { ProviderConfig as V1ProviderConfig } from "@opencode-ai/sdk"
import type { CatalogModel } from "../catalog/snapshot.js"
import type { V2ModelInfo } from "./v2-types.js"
import { isFreeModelCost } from "../provider/pricing.js"
import { reasoningVariantsForModel, isReasoningModel } from "../provider/reasoning.js"
import { inputModalitiesForModel } from "../provider/modalities.js"

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
export const DEFAULT_DISPLAY_PREFIX = "[CMD] "
// Context advertised for a snapshot row whose catalog record carried no
// usable context length: the row ships as pending-context (issue #130) and
// the #132 ladder resolves it at refresh time. OpenCode requires a numeric
// limit, so a conservative placeholder keeps the model usable — never a
// carried-forward number: a reviewer sees the real gap in the refresh log's
// "context pending" note.
const PENDING_CONTEXT_LENGTH = 128_000

type ConfigModel = NonNullable<NonNullable<ProviderConfig["models"]>[string]>
type ConfigVariants = NonNullable<ConfigModel["variants"]>

// The v1 `config` hook's entry is typed against the v2 SDK (for `variants`,
// which the v1 generated types lack), but the v1 host *decodes* the config
// with its own schema — and there `modalities` requires BOTH lists whenever
// the key is present, while v2 makes them optional. This type pins the v1
// entry's modality shape to the v1 schema, so a missing `output` is a
// typecheck failure instead of a user's TUI startup: v2.2.0 shipped an
// `input`-only `modalities` and OpenCode v1's `config.get` refused the whole
// config ("Missing key at [...].modalities.output").
type V1ConfigModel = NonNullable<NonNullable<V1ProviderConfig["models"]>[string]>
type V1Modalities = NonNullable<V1ConfigModel["modalities"]>

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
 * Ship-bar fields come from the snapshot row itself (ADR-0024: the catalog
 * endpoint's client view is the membership authority):
 *  - contextLength null falls back to the OpenCode default context — never 0,
 *    never a fabricated value;
 *  - cost null advertises NO cost entry — missing never zero-fills (only an
 *    explicit all-zero record means free).
 */
function configModelFor(model: CatalogModel, prefix = DEFAULT_DISPLAY_PREFIX): ConfigModel {
  const variants = reasoningVariantsForModel(model.id)
  const rowCost = model.cost
  return {
    name: displayNameFor(model, prefix),
    limit: limitsFor(model),
    reasoning: isReasoningModel(model.id) ? true : undefined,
    variants: variants as ConfigVariants | undefined,
    // `tool_call: true` advertises tool use (the runtime already sends tools).
    // `attachment` is deliberately unset: Command Code's published catalog
    // exposes no per-model attachment support, and the runtime converter only
    // handles text + image content parts — claiming attachment support would
    // promise file uploads the plugin cannot deliver.
    tool_call: true,
    modalities: v1ModalitiesFor(model.id),
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

/**
 * Display name for a Snapshot row: the configurable prefix, the catalog name,
 * and the "(free)" marker for an explicitly all-zero price cell (Display name
 * in CONTEXT.md). Shared by both hosts so a model never reads differently in
 * v1 and v2.
 */
function displayNameFor(model: CatalogModel, prefix: string): string {
  const freeSuffix = model.cost !== null && isFreeModelCost(model.cost) ? " (free)" : ""
  return `${prefix}${model.name}${freeSuffix}`
}

/**
 * Context/output limits for a Snapshot row. OpenCode requires a numeric
 * context limit, so a row whose catalog record carried no context ships as
 * pending-context (issue #130) behind PENDING_CONTEXT_LENGTH — never 0, never
 * a fabricated listing-API value.
 */
function limitsFor(model: CatalogModel): { context: number; output: number } {
  const contextLength = model.contextLength ?? PENDING_CONTEXT_LENGTH
  return { context: contextLength, output: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS) }
}

/**
 * v1 modality lists for a Snapshot row — both lists, always: the v1 config
 * schema requires `input` and `output` together once `modalities` is present
 * (see V1Modalities), and an `input`-only entry fails the host's config
 * decode. `output` stays text-only: Command Code's published catalog exposes
 * no non-text output, mirroring the v2 half's `capabilities.output`.
 */
function v1ModalitiesFor(modelId: string): V1Modalities {
  return { input: [...inputModalitiesForModel(modelId)], output: ["text"] }
}

/**
 * v2 `Model.Info` draft fields for a Snapshot row (ADR-0010).
 *
 * Same ship-bar authority as the v1 entry — the row's own parsed price and
 * context cell, with missing never zero-filling:
 *  - cost null advertises an empty `cost` array (no rate), never a $0 tier;
 *  - the v2 `cost` shape is an array of context tiers with a required
 *    `cache.{read,write}`, so the v1 flat `cache_read`/`cache_write` pair maps
 *    onto the single untiered entry.
 * Reasoning effort reaches the runtime through `variants` (`settings` become
 * the model's provider options in v2), the counterpart of v1's `variants` map.
 * `capabilities.input` carries the modality table; `output` stays text-only —
 * Command Code's published catalog exposes no non-text output.
 */
export type V2CatalogModelFields = Pick<
  V2ModelInfo,
  "name" | "limit" | "capabilities" | "cost" | "variants" | "status"
>

export function catalogModelForV2(
  model: CatalogModel,
  prefix = DEFAULT_DISPLAY_PREFIX,
): V2CatalogModelFields {
  const rowCost = model.cost
  return {
    name: displayNameFor(model, prefix),
    limit: limitsFor(model),
    capabilities: {
      tools: true,
      input: [...inputModalitiesForModel(model.id)],
      output: ["text"],
    },
    cost:
      rowCost === null
        ? []
        : [
            {
              input: rowCost.input,
              output: rowCost.output,
              cache: { read: rowCost.cacheRead, write: rowCost.cacheWrite },
            },
          ],
    variants: catalogVariantsForV2(model.id),
    status: "active",
  }
}

/**
 * Reasoning-effort variants for a v2 model entry. v2 carries the effort in the
 * variant's `settings`, which the host projects into the model's provider
 * options — the counterpart of v1's `variants` map, where the effort sat at the
 * variant's top level.
 */
export function catalogVariantsForV2(modelId: string): V2ModelInfo["variants"] {
  const variants = reasoningVariantsForModel(modelId)
  if (variants === undefined) return []
  return Object.entries(variants).map(([id, settings]) => ({ id, settings: { ...settings } }))
}
