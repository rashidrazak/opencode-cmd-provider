// src/provider/reasoning.ts — reasoning-effort metadata tables (PLAN #5 Part A,
// port of pi's models.ts:67-150). Reasoning metadata comes from the
// generated catalog facts (`src/catalog/facts.ts`, the efforts table) and
// the generated classification module (`src/catalog/classification.ts`,
// the per-model capability flag the docs' RSC records carry). There is no
// hand-maintained reasoning set: classification is **derived** (ADR-0006) —
//   reasoning-without-efforts = capability flag true AND no efforts entry;
//   isReasoningModel          = has an efforts entry OR capability flag true.
// The only human seam is the classification override map baked into the
// generated module at refresh time.

import { MODEL_EFFORTS as GENERATED_MODEL_EFFORTS } from "../catalog/facts.js"
import { MODEL_REASONING_CAPABILITY } from "../catalog/classification.js"

/**
 * Models omitted here let Command Code choose their reasoning depth.
 */
// facts.ts types MODEL_EFFORTS values as `readonly string[]`, wider than the
// local `CommandCodeReasoningEffort` union ("minimal" | "low" | ... | "max"),
// so a literal `export { MODEL_EFFORTS }` fails typecheck where
// `ThinkingMetadata` uses the union. The cast assumes every effort string the
// generated catalog emits is a valid `PiThinkingLevel` (the models.md Efforts
// column is constrained to those levels; the release gate catches drift). Do
// NOT "simplify" this back to a direct re-export — it breaks the build.
export const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> =
  GENERATED_MODEL_EFFORTS as Readonly<Record<string, readonly CommandCodeReasoningEffort[]>>

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
type CommandCodeReasoningEffort = Exclude<PiThinkingLevel, "off">

/**
 * Derives the reasoning-without-efforts set from a capability map and an
 * efforts table: a model is reasoning-capable without explicit efforts
 * when upstream's capability flag is true AND the facts carry no efforts
 * entry for it. Efforts precedence holds by construction — an efforts
 * model never appears in this set, so the "a model is classified exactly
 * once" invariant is true by construction rather than asserted after
 * regeneration (spec #108 / issue #111). Exported for the derivation
 * checks; the runtime consumes the derived REASONING_MODELS below.
 */
export function deriveReasoningWithoutEfforts(
  capability: Readonly<Record<string, boolean>>,
  efforts: Readonly<Record<string, readonly string[]>>,
): ReadonlySet<string> {
  return new Set(
    Object.entries(capability)
      .filter(([id, flag]) => flag === true && efforts[id] === undefined)
      .map(([id]) => id),
  )
}

/**
 * Models Command Code advertises as reasoning-capable without exposing
 * explicit effort levels (Command Code chooses the reasoning depth). These
 * advertise `reasoning: true` in opencode but never generate `variants`.
 *
 * Derived from the generated classification module + the generated efforts
 * facts — upstream data is the source of truth, so upstream classification
 * changes land on the next catalog refresh with zero human edits.
 */
export const REASONING_MODELS: ReadonlySet<string> = deriveReasoningWithoutEfforts(
  MODEL_REASONING_CAPABILITY,
  GENERATED_MODEL_EFFORTS,
)

const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

export interface ThinkingMetadata {
  thinkingLevelMap: Partial<Record<PiThinkingLevel, string | null>>
  thinking: {
    mode: "effort"
    effortMap: Partial<Record<CommandCodeReasoningEffort, string>>
    efforts: readonly CommandCodeReasoningEffort[]
  }
}

export function thinkingMetadataForModel(modelId: string): ThinkingMetadata | undefined {
  const efforts = MODEL_EFFORTS[modelId]
  if (!efforts) return undefined
  const thinkingLevelMap: Partial<Record<PiThinkingLevel, string | null>> = {}
  for (const level of PI_THINKING_LEVELS) {
    if (level === "off") continue
    thinkingLevelMap[level] = efforts.includes(level) ? level : null
  }
  return {
    thinkingLevelMap,
    thinking: {
      mode: "effort",
      effortMap: Object.fromEntries(efforts.map((effort) => [effort, effort])),
      efforts,
    },
  }
}

/**
 * A model is reasoning-capable when it has an explicit efforts entry OR
 * upstream's capability flag is true. Derived entirely from the generated
 * catalogs — no hand-maintained set remains.
 */
export function isReasoningModel(modelId: string): boolean {
  return MODEL_EFFORTS[modelId] !== undefined || REASONING_MODELS.has(modelId)
}

/**
 * opencode model `variants` for the Command Code model: one entry per supported
 * reasoning effort, keyed by the effort name. Each variant carries
 * `{ reasoningEffort: effort }`, which opencode merges into the request
 * `providerOptions` when the user cycles reasoning with `ctrl+t`. Without a
 * non-empty `variants` map (and `capabilities.reasoning: true`), opencode has
 * nothing to cycle and the effort is never surfaced.
 */
export function reasoningVariantsForModel(
  modelId: string,
): Record<string, { reasoningEffort: string }> | undefined {
  const efforts = MODEL_EFFORTS[modelId]
  if (!efforts) return undefined
  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
}

export function mappedReasoningEffort(
  model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>> },
  options?: { reasoning?: string },
): string | undefined {
  const level = options?.reasoning
  if (!level || level === "off" || !model.reasoning) return undefined
  const mapped = model.thinkingLevelMap?.[level as PiThinkingLevel]
  return typeof mapped === "string" && mapped !== "off" ? mapped : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Resolves the user's requested reasoning effort from AI SDK v3 call
 * providerOptions. The v3 shape namespaces options per provider
 * (`{ commandcode: { reasoningEffort } }`), but some runtimes pass the
 * effort at the top level — accept both. Without this, opencode's
 * `reasoningEffort` agent setting is silently dropped and the API falls
 * back to its default reasoning depth.
 */
export function resolveProviderReasoning(
  providerOptions: unknown,
  providerId: string,
): string | undefined {
  if (!isRecord(providerOptions)) return undefined
  const topLevel =
    stringValue(providerOptions.reasoning) ?? stringValue(providerOptions.reasoningEffort)
  if (topLevel) return topLevel
  const namespaced = providerOptions[providerId]
  if (isRecord(namespaced)) {
    return stringValue(namespaced.reasoning) ?? stringValue(namespaced.reasoningEffort)
  }
  return undefined
}
