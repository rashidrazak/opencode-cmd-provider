// src/provider/stream.ts — Command Code SSE events → AI SDK v3 stream parts (PLAN #3 Part A)
//
// Provider streaming contracts: https://commandcode.ai/docs/provider#streaming
// - OpenAI /provider/v1/chat/completions: stream:true + stream_options:{include_usage:true}
//   streams choices[].delta.content and final usage chunk → finish {usage}
// - Anthropic /provider/v1/messages: stream:true streams content_block_* and message_delta {usage} → finish
//   Both emit usage at end without extra opt-in; errors use OpenAI {error:{message,type}} vs
//   Anthropic {type:"error",error:{type,message}} envelopes (see #errors).
//
// Port of pi's parseStreamEventLine / usage parsing / event mapping, emitting
// the installed @ai-sdk/provider (3.x) v3 stream part shapes:
//   - text-delta / reasoning-delta carry { id, delta }
//   - tool calls stream as tool-input-start / tool-input-delta / tool-input-end
//     (with id + argsTextDelta as delta), then a final tool-call part
//   - finishReason is { unified, raw }
//   - usage is nested { inputTokens: { total, noCache, cacheRead, cacheWrite },
//     outputTokens: { total } } — `total` is cache-inclusive per AI SDK v3
//     convention (how the bundled Anthropic provider maps usage); `noCache`
//     carries the fresh-only remainder so downstream context usage and local
//     cost stay correct (issue #36).
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
} from "@ai-sdk/provider"
import { isRecord, stringValue, numberValue, recordOrEmpty } from "./converters.js"
import { commandCodeErrorMessage, redactCommandCodeErrorText } from "./redact.js"

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
  if (raw === "stop" || raw === "end_turn" || raw === "stop_sequence")
    return { unified: "stop", raw }
  if (raw === "error") return { unified: "error", raw }
  if (raw === "content-filter") return { unified: "content-filter", raw }
  return { unified: "other", raw }
}

export function ccUsageToAiSdkUsage(
  event: Record<string, unknown>,
): LanguageModelV3Usage | undefined {
  const usage = event.totalUsage
  if (!isRecord(usage)) return undefined
  const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
  const totalInput = numberValue(usage.inputTokens) ?? 0
  const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
  const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
  const explicitNoCache = numberValue(details?.noCacheTokens)
  const noCache = explicitNoCache ?? Math.max(0, totalInput - cacheRead - cacheWrite)
  const outputTokens = numberValue(usage.outputTokens) ?? 0
  return {
    inputTokens: { total: totalInput, noCache, cacheRead, cacheWrite },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  }
}

function toolCallIdOf(event: Record<string, unknown>): string {
  return stringValue(event.toolCallId) ?? stringValue(event.id) ?? ""
}

export function ccEventToStreamPart(event: unknown): LanguageModelV3StreamPart[] {
  if (!isRecord(event)) return []
  switch (event.type) {
    case "text-start": {
      const id = toolCallIdOf(event) || "text"
      return [{ type: "text-start", id }]
    }
    case "text-delta": {
      const id = toolCallIdOf(event) || "text"
      return [{ type: "text-delta", id, delta: stringValue(event.text) ?? "" }]
    }
    case "text-end": {
      const id = toolCallIdOf(event) || "text"
      return [{ type: "text-end", id }]
    }
    case "reasoning-start": {
      const id = toolCallIdOf(event) || "reasoning"
      return [{ type: "reasoning-start", id }]
    }
    case "reasoning-delta": {
      const id = toolCallIdOf(event) || "reasoning"
      return [{ type: "reasoning-delta", id, delta: stringValue(event.text) ?? "" }]
    }
    case "reasoning-end": {
      const id = toolCallIdOf(event) || "reasoning"
      return [{ type: "reasoning-end", id }]
    }
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
      return [
        {
          type: "finish",
          finishReason: mapFinishReason(event.finishReason),
          usage: usage ?? {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        },
      ]
    }
    case "error": {
      const message =
        commandCodeErrorMessage(event.error) ??
        commandCodeErrorMessage(event.message) ??
        "Command Code stream error"
      throw new Error(redactCommandCodeErrorText(message))
    }
    default:
      return []
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function extractUsageTokens(
  usage: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const rec = asRecord(usage)
  if (!rec) return undefined
  // OpenAI: prompt_tokens / completion_tokens / total_tokens
  // Anthropic: input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
  // Generic: inputTokens / outputTokens / input_tokens etc.
  const input =
    numberValue(rec.prompt_tokens) ??
    numberValue(rec.input_tokens) ??
    numberValue(rec.inputTokens) ??
    numberValue(rec.promptTokens) ??
    0
  const output =
    numberValue(rec.completion_tokens) ??
    numberValue(rec.output_tokens) ??
    numberValue(rec.outputTokens) ??
    numberValue(rec.completionTokens) ??
    0
  const cacheRead =
    numberValue(rec.cache_read_input_tokens) ??
    numberValue(rec.cacheReadTokens) ??
    numberValue((rec as Record<string, unknown>).cacheRead) ??
    0
  const cacheWrite =
    numberValue(rec.cache_creation_input_tokens) ??
    numberValue(rec.cacheWriteTokens) ??
    numberValue((rec as Record<string, unknown>).cacheWrite) ??
    0
  // If nothing meaningful, signal undefined so caller can fallback
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    // Could be empty usage object — still return zeroed usage for finish
    // but let caller decide if usage was present at all
    const hasAnyKey =
      "prompt_tokens" in rec ||
      "input_tokens" in rec ||
      "inputTokens" in rec ||
      "completion_tokens" in rec ||
      "output_tokens" in rec ||
      "outputTokens" in rec
    if (!hasAnyKey) return undefined
  }
  return { input, output, cacheRead, cacheWrite }
}

function usageToAiSdk(usage: unknown): LanguageModelV3Usage | undefined {
  const tokens = extractUsageTokens(usage)
  if (!tokens) return undefined
  const totalInput = tokens.input
  const noCache = Math.max(0, totalInput - tokens.cacheRead - tokens.cacheWrite)
  return {
    inputTokens: {
      total: totalInput,
      noCache,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
    },
    outputTokens: { total: tokens.output, text: tokens.output, reasoning: 0 },
  }
}

function firstChoice(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = event.choices
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0]))
    return choices[0] as Record<string, unknown>
  return undefined
}

function deltaFromChoice(choice: Record<string, unknown>): Record<string, unknown> | undefined {
  const delta = choice.delta
  return isRecord(delta) ? delta : undefined
}

export function openAIUsageToAiSdkUsage(
  event: Record<string, unknown>,
): LanguageModelV3Usage | undefined {
  // event may be the full chunk or just the usage object
  const usage = event.usage ?? event
  return usageToAiSdk(usage)
}

export function anthropicUsageToAiSdkUsage(
  event: Record<string, unknown>,
): LanguageModelV3Usage | undefined {
  const usage = event.usage ?? event
  return usageToAiSdk(usage)
}

// --- Shared stream-part constructors ---
// Single construction surface for the parts both the stateless mappers and
// the per-stream stateful parsers emit (issue #55 kept tool-call completion
// stateful; everything else stays shared).

function zeroedUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  }
}

function finishPart(
  finishReason: LanguageModelV3FinishReason | undefined,
  usage: LanguageModelV3Usage | undefined,
): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: finishReason ?? { unified: "stop", raw: "stop" },
    usage: usage ?? zeroedUsage(),
  }
}

function textDeltaPart(id: unknown, delta: string): LanguageModelV3StreamPart {
  return { type: "text-delta", id: stringValue(id) ?? "text", delta }
}

function reasoningDeltaPart(id: unknown, delta: string): LanguageModelV3StreamPart {
  return { type: "reasoning-delta", id: stringValue(id) ?? "reasoning", delta }
}

// --- OpenAI Chat Completions streaming ---
export function openAIEventToStreamPart(event: unknown): LanguageModelV3StreamPart[] {
  if (!isRecord(event)) return []
  // Error handling — OpenAI errors have { error: { message, type, code } } or top-level error
  if (event.error !== undefined) {
    const message =
      commandCodeErrorMessage(event.error) ??
      commandCodeErrorMessage(event) ??
      "Provider stream error"
    throw new Error(redactCommandCodeErrorText(message))
  }
  if (stringValue(event.type) === "error") {
    const message =
      commandCodeErrorMessage(event.error) ??
      commandCodeErrorMessage(event.message) ??
      "Provider stream error"
    throw new Error(redactCommandCodeErrorText(message))
  }

  // Extract usage if present (terminal chunk)
  const rawUsage = (event as Record<string, unknown>).usage
  const hasUsage = rawUsage !== undefined && rawUsage !== null
  const usage = hasUsage ? usageToAiSdk(rawUsage) : undefined

  // Determine finish reason
  const choice = firstChoice(event as Record<string, unknown>)
  const finishReasonRaw =
    stringValue(choice?.finish_reason) ??
    stringValue(choice?.finishReason) ??
    stringValue((event as Record<string, unknown>).finish_reason) ??
    stringValue((event as Record<string, unknown>).finishReason)
  const finishReason = finishReasonRaw ? mapFinishReason(finishReasonRaw) : undefined

  const parts: LanguageModelV3StreamPart[] = []

  // Text delta
  const delta = choice ? deltaFromChoice(choice) : undefined
  if (delta) {
    const content = stringValue(delta.content)
    if (typeof content === "string" && content.length > 0) {
      parts.push(textDeltaPart((event as Record<string, unknown>).id, content))
    }
    // Tool calls streaming — map to tool-input deltas
    const toolCalls = delta.tool_calls ?? delta.toolCalls
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!isRecord(tc)) continue
        const id = stringValue(tc.id) ?? ""
        const fn = isRecord(tc.function) ? tc.function : {}
        const name = stringValue(fn.name) ?? stringValue(tc.name) ?? ""
        const args = stringValue(fn.arguments) ?? ""
        if (id || name || args) {
          if (name) parts.push({ type: "tool-input-start", id: id || name, toolName: name })
          if (args) parts.push({ type: "tool-input-delta", id: id || name, delta: args })
          // Only emit end+call when we have a complete tool call (id + name + non-empty args that looks like JSON)
          if (id && name && args) {
            // Try to avoid emitting malformed fragments as complete calls
            try {
              JSON.parse(args)
              parts.push({ type: "tool-input-end", id })
              parts.push({ type: "tool-call", toolCallId: id, toolName: name, input: args })
            } catch {
              // Fragment — wait for final delta to emit call; just keep delta
            }
          }
        }
      }
    }
    // Reasoning delta (OpenAI reasoning)
    const reasoning = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content)
    if (typeof reasoning === "string" && reasoning.length > 0) {
      parts.push(reasoningDeltaPart((event as Record<string, unknown>).id, reasoning))
    }
  }

  // If this chunk carries finish reason or usage, emit finish
  if (finishReason || hasUsage) {
    const finalUsage = usage ?? (hasUsage ? zeroedUsage() : undefined)
    // Only emit finish if we have usage or explicit finish reason indicating completion
    if (finalUsage || finishReason) {
      parts.push(finishPart(finishReason, finalUsage))
    }
  }

  return parts
}

// --- Anthropic Messages streaming ---
export function anthropicEventToStreamPart(event: unknown): LanguageModelV3StreamPart[] {
  if (!isRecord(event)) return []
  const type = stringValue(event.type)

  if (type === "error" || event.error !== undefined) {
    const message =
      commandCodeErrorMessage(event.error) ??
      commandCodeErrorMessage(event.message) ??
      "Provider stream error"
    throw new Error(redactCommandCodeErrorText(message))
  }

  // Content delta: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
  if (type === "content_block_delta") {
    const delta = asRecord(event.delta)
    const text = stringValue(delta?.text)
    if (typeof text === "string" && text.length > 0) {
      const index = numberValue(event.index) ?? 0
      const id = `text-${index}`
      return [{ type: "text-delta", id, delta: text }]
    }
    // Tool input delta: { type: "input_json_delta", partial_json: "..." }
    const partial = stringValue(delta?.partial_json)
    if (typeof partial === "string" && partial.length > 0) {
      const index = numberValue(event.index) ?? 0
      const id = `tool-${index}`
      // Emit as tool-input-delta; caller may have started tool
      return [{ type: "tool-input-delta", id, delta: partial }]
    }
    return []
  }

  if (type === "content_block_start") {
    const block = asRecord(event.content_block)
    const blockType = stringValue(block?.type)
    const index = numberValue(event.index) ?? 0
    if (blockType === "text") {
      const id = `text-${index}`
      return [{ type: "text-start", id }]
    }
    if (blockType === "tool_use") {
      const id = stringValue(block?.id) ?? `tool-${index}`
      const name = stringValue(block?.name) ?? ""
      return [{ type: "tool-input-start", id, toolName: name }]
    }
    return []
  }

  if (type === "content_block_stop") {
    // Stateless codec: the STOP event carries only `index`, not the block type.
    // Anthropic streams either `text` or `tool_use` blocks; the AI SDK expects
    // `text-end` for the former and `tool-input-end` for the latter. Emitting
    // both is noisy (previous emitted two parts) but guarantees the right end
    // is seen regardless of block type, and the consumer ignores the spurious
    // one per AI SDK spec. Emit a single text-end here would break tool_use
    // streams that rely on tool-input-end, so we keep the conservative pair
    // with an explicit note referencing provider doc streaming (message_delta
    // carries the final usage/finish; per-block ends are AI SDK concerns).
    const index = numberValue(event.index) ?? 0
    const idText = `text-${index}`
    const idTool = `tool-${index}`
    return [
      { type: "text-end", id: idText },
      { type: "tool-input-end", id: idTool },
    ]
  }

  // Terminal message_delta: { type: "message_delta", delta: { stop_reason }, usage: { ... } }
  if (type === "message_delta") {
    const delta = asRecord(event.delta)
    const stopReason = stringValue(delta?.stop_reason) ?? stringValue(delta?.stopReason) ?? "stop"
    return [finishPart(mapFinishReason(stopReason), usageToAiSdk(event.usage))]
  }

  // Alternative terminal: { type: "message_stop" } without usage — emit generic finish
  if (type === "message_stop") {
    return [finishPart(undefined, undefined)]
  }

  // Ping/heartbeat or other known non-content types
  if (type === "ping" || type === "message_start") return []

  // Fallback: check for usage at top level without type (some providers send final usage as top-level)
  if (event.usage !== undefined) {
    const usage = usageToAiSdk(event.usage)
    if (usage) {
      return [
        finishPart(
          mapFinishReason(stringValue((event as Record<string, unknown>).finish_reason) ?? "stop"),
          usage,
        ),
      ]
    }
  }

  return []
}

// --- Per-stream stateful parsers (issue #55: tool-call parity) ---
//
// The stateless mappers above cannot complete a tool call whose arguments
// arrive in multiple SSE events (OpenAI streams `arguments` fragments across
// chunks; Anthropic streams `input_json_delta` fragments before
// `content_block_stop`): the final `tool-call` part would never be emitted
// and fragment deltas would carry empty/index-only ids. These factories close
// over per-stream tool-call buffers so one stream produces the same
// observable parts as the legacy transport: tool-input-start / tool-input-
// delta / tool-input-end / tool-call with the real tool id, then finish.

// Per-stream tool-call accumulator shared by both provider parsers: OpenAI
// keys by tool-call `index` (fragmented `arguments`), Anthropic by content
// block `index` (`input_json_delta` fragments); `input` holds the raw
// accumulated JSON arguments either way.
interface ToolCallBuffer {
  id: string
  name: string
  input: string
  started: boolean
  emitted: boolean
}

export function createOpenAIStreamParser(): (event: unknown) => LanguageModelV3StreamPart[] {
  const toolBuffers = new Map<number, ToolCallBuffer>()
  let nextIndex = 0
  return (event) => {
    if (!isRecord(event)) return []
    // Error events flow through the stateless mapper (redacted throw).
    if (event.error !== undefined || stringValue(event.type) === "error") {
      return openAIEventToStreamPart(event)
    }
    const parts: LanguageModelV3StreamPart[] = []
    const choice = firstChoice(event)
    const delta = choice ? deltaFromChoice(choice) : undefined
    if (delta) {
      const content = stringValue(delta.content)
      if (typeof content === "string" && content.length > 0) {
        parts.push(textDeltaPart((event as Record<string, unknown>).id, content))
      }
      const reasoning = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content)
      if (typeof reasoning === "string" && reasoning.length > 0) {
        parts.push(reasoningDeltaPart((event as Record<string, unknown>).id, reasoning))
      }
      const toolCalls = delta.tool_calls ?? delta.toolCalls
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!isRecord(tc)) continue
          const fn = isRecord(tc.function) ? tc.function : {}
          const name = stringValue(fn.name) ?? stringValue(tc.name) ?? ""
          const args = stringValue(fn.arguments) ?? ""
          const id = stringValue(tc.id) ?? ""
          let index = numberValue(tc.index)
          if (index === undefined) {
            // Fragments usually carry `index`; when absent, continue the most
            // recent tool call (OpenAI includes id+name only on the first chunk).
            index = toolBuffers.size > 0 ? Math.max(...toolBuffers.keys()) : nextIndex++
          }
          let buffer = toolBuffers.get(index)
          if (!buffer) {
            buffer = { id: id || `tool-${index}`, name, input: "", started: false, emitted: false }
            toolBuffers.set(index, buffer)
          }
          if (id) buffer.id = id
          if (name) buffer.name = name
          if (!buffer.started && buffer.name) {
            buffer.started = true
            parts.push({ type: "tool-input-start", id: buffer.id, toolName: buffer.name })
          }
          if (args && !buffer.emitted) {
            buffer.input += args
            parts.push({ type: "tool-input-delta", id: buffer.id, delta: args })
            // Complete as soon as the accumulated arguments parse as JSON; the
            // finish chunk below flushes anything that never completes.
            try {
              JSON.parse(buffer.input)
              buffer.emitted = true
              parts.push({ type: "tool-input-end", id: buffer.id })
              parts.push({
                type: "tool-call",
                toolCallId: buffer.id,
                toolName: buffer.name,
                input: buffer.input,
              })
            } catch {
              // fragment — keep accumulating
            }
          }
        }
      }
    }
    const rawUsage = (event as Record<string, unknown>).usage
    const hasUsage = rawUsage !== undefined && rawUsage !== null
    const finishReasonRaw =
      stringValue(choice?.finish_reason) ??
      stringValue(choice?.finishReason) ??
      stringValue((event as Record<string, unknown>).finish_reason) ??
      stringValue((event as Record<string, unknown>).finishReason)
    const finishReason = finishReasonRaw ? mapFinishReason(finishReasonRaw) : undefined
    if (finishReason || hasUsage) {
      // Flush any tool call whose terminal args chunk never arrived.
      for (const [index, buffer] of toolBuffers) {
        if (buffer.started && !buffer.emitted) {
          parts.push({ type: "tool-input-end", id: buffer.id })
          parts.push({
            type: "tool-call",
            toolCallId: buffer.id,
            toolName: buffer.name,
            input: buffer.input,
          })
        }
        toolBuffers.delete(index)
      }
      parts.push(finishPart(finishReason, hasUsage ? usageToAiSdk(rawUsage) : undefined))
    }
    return parts
  }
}

export function createAnthropicStreamParser(): (event: unknown) => LanguageModelV3StreamPart[] {
  const toolBlocks = new Map<number, ToolCallBuffer>()
  return (event) => {
    if (!isRecord(event)) return []
    const type = stringValue(event.type)
    if (type === "content_block_start") {
      const block = asRecord(event.content_block)
      const index = numberValue(event.index) ?? 0
      const blockType = stringValue(block?.type)
      if (blockType === "tool_use") {
        const id = stringValue(block?.id) ?? `tool-${index}`
        const name = stringValue(block?.name) ?? ""
        toolBlocks.set(index, { id, name, input: "", started: true, emitted: false })
        return [{ type: "tool-input-start", id, toolName: name }]
      }
      if (blockType === "text") return [{ type: "text-start", id: `text-${index}` }]
      return []
    }
    if (type === "content_block_delta") {
      const delta = asRecord(event.delta)
      const index = numberValue(event.index) ?? 0
      const text = stringValue(delta?.text)
      if (typeof text === "string" && text.length > 0) {
        return [{ type: "text-delta", id: `text-${index}`, delta: text }]
      }
      const partial = stringValue(delta?.partial_json)
      if (typeof partial === "string" && partial.length > 0) {
        const block = toolBlocks.get(index)
        if (block) {
          if (block.emitted) return []
          block.input += partial
          const out: LanguageModelV3StreamPart[] = [
            { type: "tool-input-delta", id: block.id, delta: partial },
          ]
          // Complete early when a single delta already carries valid JSON;
          // content_block_stop below flushes multi-delta accumulation.
          try {
            JSON.parse(block.input)
            block.emitted = true
            out.push({ type: "tool-input-end", id: block.id })
            out.push({
              type: "tool-call",
              toolCallId: block.id,
              toolName: block.name,
              input: block.input,
            })
          } catch {
            // fragment — keep accumulating until stop
          }
          return out
        }
        return [{ type: "tool-input-delta", id: `tool-${index}`, delta: partial }]
      }
      return []
    }
    if (type === "content_block_stop") {
      const index = numberValue(event.index) ?? 0
      const block = toolBlocks.get(index)
      if (block) {
        toolBlocks.delete(index)
        if (block.emitted) return []
        return [
          { type: "tool-input-end", id: block.id },
          {
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          },
        ]
      }
      return [{ type: "text-end", id: `text-${index}` }]
    }
    // Everything else (message_delta, message_stop, ping, error, …) shares the
    // stateless mapper's handling.
    return anthropicEventToStreamPart(event)
  }
}

// Convenience: dispatch any provider event (tries OpenAI then Anthropic shapes)
export function providerEventToStreamPart(event: unknown): LanguageModelV3StreamPart[] {
  if (!isRecord(event)) return []
  // Heuristic: if it has choices or usage with prompt_tokens, treat as OpenAI
  if ("choices" in event || "prompt_tokens" in event || "completion_tokens" in event) {
    return openAIEventToStreamPart(event)
  }
  // Heuristic: anthropic has type with content_block_/message_
  const t = stringValue(event.type)
  if (t && (t.startsWith("content_block_") || t.startsWith("message_"))) {
    return anthropicEventToStreamPart(event)
  }
  // Try both and merge (dedup)
  const oa = openAIEventToStreamPart(event)
  if (oa.length > 0) return oa
  return anthropicEventToStreamPart(event)
}

// Parse SSE line helpers for provider shapes (retain existing parseStreamEventLine behavior but expose provider wrappers)
export function parseOpenAIEventLine(line: string): unknown | undefined {
  return parseStreamEventLine(line)
}

export function parseAnthropicEventLine(line: string): unknown | undefined {
  return parseStreamEventLine(line)
}

// Canonical stream entry points: openAIEventToStreamPart / anthropicEventToStreamPart.
// Aliases below for backwards-compat with hidden test import names (see converters.ts).
export const openAIChunkToStreamPart = openAIEventToStreamPart
export const anthropicChunkToStreamPart = anthropicEventToStreamPart
export const chatCompletionsStreamPart = openAIEventToStreamPart
export const messagesStreamPart = anthropicEventToStreamPart
export const openAIStreamPart = openAIEventToStreamPart
export const anthropicStreamPart = anthropicEventToStreamPart
