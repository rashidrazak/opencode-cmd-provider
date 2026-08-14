// src/provider/stream.ts — Command Code SSE events → AI SDK v3 stream parts (PLAN #3 Part A)
//
// Port of pi's parseStreamEventLine / usage parsing / event mapping, emitting
// the installed @ai-sdk/provider (3.x) v3 stream part shapes:
//   - text-delta / reasoning-delta carry { id, delta }
//   - tool calls stream as tool-input-start / tool-input-delta / tool-input-end
//     (with id + argsTextDelta as delta), then a final tool-call part
//   - finishReason is { unified, raw }
//   - usage is nested { inputTokens: { total, noCache, cacheRead, cacheWrite },
//     outputTokens: { total } } — cache tokens are folded into the input
//     totals the way pi folds them into its usage shape (AI SDK v3 has no
//     separate cache fields on the model-facing shape we emit here).
import type { LanguageModelV3StreamPart, LanguageModelV3Usage, LanguageModelV3FinishReason } from "@ai-sdk/provider"
import { isRecord, stringValue, numberValue, recordOrEmpty } from "./converters.js"
import { commandCodeErrorMessage } from "./redact.js"

export function parseStreamEventLine(line: string): unknown | undefined {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === "[DONE]") return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

export function mapFinishReason(reason: unknown): LanguageModelV3FinishReason {
  const raw = stringValue(reason) ?? "unknown"
  if (raw === "tool_use" || raw === "tool-calls") return { unified: "tool-calls", raw }
  if (
    raw === "length" ||
    raw === "max_tokens" ||
    raw === "max-tokens" ||
    raw === "max_output_tokens"
  ) {
    return { unified: "length", raw }
  }
  if (raw === "stop") return { unified: "stop", raw }
  if (raw === "error") return { unified: "error", raw }
  if (raw === "content-filter") return { unified: "content-filter", raw }
  return { unified: "other", raw }
}

export function ccUsageToAiSdkUsage(event: Record<string, unknown>): LanguageModelV3Usage | undefined {
  const usage = event.totalUsage
  if (!isRecord(usage)) return undefined
  const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
  const totalInput = numberValue(usage.inputTokens) ?? 0
  const noCache = numberValue(details?.noCacheTokens)
  const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
  const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
  const inputTotal = noCache ?? Math.max(0, totalInput - cacheRead - cacheWrite)
  const outputTokens = numberValue(usage.outputTokens) ?? 0
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead, cacheWrite },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  }
}

function toolCallIdOf(event: Record<string, unknown>): string {
  return stringValue(event.toolCallId) ?? stringValue(event.id) ?? ""
}

export function ccEventToStreamPart(event: unknown): LanguageModelV3StreamPart[] {
  if (!isRecord(event)) return []
  switch (event.type) {
    case "text-delta": {
      const id = toolCallIdOf(event) || "text"
      return [{ type: "text-delta", id, delta: stringValue(event.text) ?? "" }]
    }
    case "reasoning-delta": {
      const id = toolCallIdOf(event) || "reasoning"
      return [{ type: "reasoning-delta", id, delta: stringValue(event.text) ?? "" }]
    }
    case "reasoning-start":
    case "reasoning-end":
    case "tool-result":
      return []
    case "tool-call": {
      const id = toolCallIdOf(event)
      const toolName = stringValue(event.toolName) ?? ""
      const args = recordOrEmpty(event.input ?? event.args ?? event.arguments)
      const argsTextDelta = JSON.stringify(args)
      return [
        { type: "tool-input-start", id, toolName },
        { type: "tool-input-delta", id, delta: argsTextDelta },
        { type: "tool-input-end", id },
        { type: "tool-call", toolCallId: id, toolName, input: argsTextDelta },
      ]
    }
    case "finish": {
      const usage = ccUsageToAiSdkUsage(event)
      return [{ type: "finish", finishReason: mapFinishReason(event.finishReason), usage: usage ?? {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      } }]
    }
    case "error": {
      const message =
        commandCodeErrorMessage(event.error) ??
        commandCodeErrorMessage(event.message) ??
        "Command Code stream error"
      throw new Error(message)
    }
    default:
      return []
  }
}
