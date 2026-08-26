// src/provider/reasoning.ts — reasoning-effort metadata tables (PLAN #5 Part A,
// port of pi's models.ts:67-150). Reasoning metadata now comes from the
// generated catalog facts (`src/catalog/facts.ts`), with hand-maintained
// classification sets (`REASONING_MODELS`) layered on top.

import { MODEL_EFFORTS as GENERATED_MODEL_EFFORTS } from "../catalog/facts.js"

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
 * Models Command Code advertises as reasoning-capable without exposing
 * explicit effort levels (Command Code chooses the reasoning depth). These
 * advertise `reasoning: true` in opencode but never generate `variants`.
 */
export const REASONING_MODELS: ReadonlySet<string> = new Set([
  "MiniMaxAI/MiniMax-M3",
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.7-Max",
  "Qwen/Qwen3.7-Plus",
  "meta/muse-spark-1.1",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
  "minimax/minimax-m3-free",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K3",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "poolside/laguna-s-2.1-free",
  "stealth/ox-alpha",
  "stepfun/Step-3.7-Flash",
  "tencent/hy3-paid",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
])

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
