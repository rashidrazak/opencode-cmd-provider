// src/provider/aisdk-types.ts — AI SDK v3 type aliases for this package (PLAN #2 Part A)
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3Prompt,
  LanguageModelV3DataContent,
} from "@ai-sdk/provider"

export type { LanguageModelV3, LanguageModelV3StreamPart, LanguageModelV3Usage, LanguageModelV3Prompt, LanguageModelV3DataContent }

/**
 * Local structural call options. If the installed @ai-sdk/provider exports
 * LanguageModelV3CallOptions, alias it here instead; otherwise this local
 * shape is what doStream/doGenerate accept (structurally compatible).
 */
export interface ModelCallOptions {
  prompt: LanguageModelV3Prompt
  mode: { type: "regular" } | { type: "push" }
  providerOptions?: Record<string, unknown>
  abortSignal?: AbortSignal
  maxOutputTokens?: number
  temperature?: number
  headers?: Record<string, string>
  url?: URL
}
