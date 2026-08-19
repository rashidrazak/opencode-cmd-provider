// src/provider/reasoning.ts — reasoning-effort metadata tables (PLAN #5 Part A,
// port of pi's models.ts:67-150; catalog parsing deferred to #6/#7)

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
type CommandCodeReasoningEffort = Exclude<PiThinkingLevel, "off">

/**
 * Per-model reasoning efforts supported by Command Code's generate endpoint.
 *
 * The Provider API does not expose reasoning metadata. This is an exact
 * snapshot of `reasoningEfforts` from the command-code@1.28.1 model catalog
 * (`packages/shared/src/model-catalog.ts`, also published in the generated
 * `dist/bundled/command-code-knowledge/reference/models.md`). Models omitted
 * here let Command Code choose their reasoning depth, matching the CLI.
 */
export const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {
  "Qwen/Qwen3.8-27B": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.3": ["low", "high", "max"],
}

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
  return MODEL_EFFORTS[modelId] !== undefined
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
