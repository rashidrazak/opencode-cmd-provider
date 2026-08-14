// src/provider/aisdk-types.ts — AI SDK v3 type aliases for this package (PLAN #2 Part A)
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3Prompt,
  LanguageModelV3DataContent,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider"

export type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3Prompt,
  LanguageModelV3DataContent,
  LanguageModelV3FunctionTool,
}

/**
 * Call options for doStream/doGenerate. The installed @ai-sdk/provider (3.x)
 * exports LanguageModelV3CallOptions directly, so this is a plain alias.
 * (The plan sketched a local shape with a `mode` field — that is the v2-era
 * shape; v3 call options have no `mode`.)
 */
export type ModelCallOptions = LanguageModelV3CallOptions
