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
    const index = numberValue(event.index) ?? 0
    // A single tri-branch handles the three delta shapes: `text` (regular
    // text), `thinking` (reasoning text), and `partial_json` (tool args).
    const text = stringValue(delta?.text)
    if (typeof text === "string" && text.length > 0) {
      const id = `text-${index}`
      return [{ type: "text-delta", id, delta: text }]
    }
    const thinking = stringValue(delta?.thinking)
    if (typeof thinking === "string" && thinking.length > 0) {
      const id = `thinking-${index}`
      return [{ type: "reasoning-delta", id, delta: thinking }]
    }
    // Tool input delta: { type: "input_json_delta", partial_json: "..." }
    const partial = stringValue(delta?.partial_json)
    if (typeof partial === "string" && partial.length > 0) {
      const id = `tool-${index}`
      // Emit as tool-input-delta; caller may have started tool
      return [{ type: "tool-input-delta", id, delta: partial }]
    }
    return []
  }

  if (type === "content_block_stop") {
    // Stateless codec: the STOP event carries only `index`, not the block
    // type, so the matching end part is emitted for every block family the
    // protocol defines (issue #71: thinking blocks previously never received
    // a `reasoning-end` here). Emitting the full set is safe for stateless
    // consumers: each family's ids are index-disjoint (`text-<i>`,
    // `thinking-<i>`, `tool-<i>`), and the AI SDK ignores end parts for ids
    // that never started.
    const index = numberValue(event.index) ?? 0
    return [
      { type: "text-end", id: `text-${index}` },
      { type: "reasoning-end", id: `thinking-${index}` },
      { type: "tool-input-end", id: `tool-${index}` },
    ]
  }

  if (type === "content_block_start") {
    const block = asRecord(event.content_block)
    const blockType = stringValue(block?.type)
    const index = numberValue(event.index) ?? 0
    if (blockType === "text") {
      const id = `text-${index}`
      return [{ type: "text-start", id }]
    }
    if (blockType === "thinking") {
      const id = stringValue(block?.id) ?? `thinking-${index}`
      return [{ type: "reasoning-start", id }]
    }
    if (blockType === "tool_use") {
      const id = stringValue(block?.id) ?? `tool-${index}`
      const name = stringValue(block?.name) ?? ""
      return [{ type: "tool-input-start", id, toolName: name }]
    }
    return []
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
  // OpenAI streams finish_reason on the last content chunk, then the real
  // usage on a separate trailing usage-only chunk (choices:[]). Remember the
  // finish_reason here so the usage-only chunk's finish keeps the real reason
  // (e.g. "length") instead of defaulting to "stop".
  let lastFinishReason: LanguageModelV3FinishReason | undefined
  let reasoningStarted = false
  let reasoningEnded = false
  let reasoningId: string | undefined
  let textStarted = false
  let textEnded = false
  let textId: string | undefined

  function closeReasoning(): LanguageModelV3StreamPart[] {
    if (reasoningStarted && !reasoningEnded && reasoningId) {
      reasoningEnded = true
      return [{ type: "reasoning-end", id: reasoningId }]
    }
    return []
  }

  function closeText(): LanguageModelV3StreamPart[] {
    if (textStarted && !textEnded && textId) {
      textEnded = true
      return [{ type: "text-end", id: textId }]
    }
    return []
  }

  return (event) => {
    if (!isRecord(event)) return []
    // Error events flow through the stateless mapper (redacted throw). Issue
    // #72: a terminal error mid-stream must not strand open reasoning/text
    // parts — "failed mid-generation" is exactly the lifecycle gap reported
    // there — so the close helpers run first and the mapper's throw is
    // captured into an error part (the transport and doGenerate already
    // treat `{type: "error"}` parts as terminal).
    if (event.error !== undefined || stringValue(event.type) === "error") {
      const closing: LanguageModelV3StreamPart[] = [...closeReasoning(), ...closeText()]
      let errorParts: LanguageModelV3StreamPart[]
      try {
        errorParts = openAIEventToStreamPart(event)
      } catch (error) {
        errorParts = [{ type: "error", error }]
      }
      return [...closing, ...errorParts]
    }
    const parts: LanguageModelV3StreamPart[] = []
    const choice = firstChoice(event)
    const delta = choice ? deltaFromChoice(choice) : undefined
    const eventId = stringValue((event as Record<string, unknown>).id)

    if (delta) {
      const reasoning = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content)
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningStarted || reasoningEnded) {
          if (textStarted && !textEnded) {
            parts.push(...closeText())
          }
          reasoningStarted = true
          reasoningEnded = false
          reasoningId = eventId || "reasoning-0"
          parts.push({ type: "reasoning-start", id: reasoningId })
        }
        parts.push(reasoningDeltaPart(reasoningId ?? eventId, reasoning))
      }

      const content = stringValue(delta.content)
      if (typeof content === "string" && content.length > 0) {
        if (reasoningStarted && !reasoningEnded) {
          parts.push(...closeReasoning())
        }
        if (!textStarted || textEnded) {
          textStarted = true
          textEnded = false
          textId = eventId || "text-0"
          parts.push({ type: "text-start", id: textId })
        }
        parts.push(textDeltaPart(textId ?? eventId, content))
      }

      const toolCalls = delta.tool_calls ?? delta.toolCalls
      if (Array.isArray(toolCalls)) {
        if (reasoningStarted && !reasoningEnded) {
          parts.push(...closeReasoning())
        }
        if (textStarted && !textEnded) {
          parts.push(...closeText())
        }
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
    if (finishReason) lastFinishReason = finishReason
    if (lastFinishReason || hasUsage) {
      if (reasoningStarted && !reasoningEnded) {
        parts.push(...closeReasoning())
      }
      if (textStarted && !textEnded) {
        parts.push(...closeText())
      }
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
      // The usage-only trailing chunk carries no finish_reason; reuse the one
      // captured from the finish_reason chunk so the real reason survives.
      const reason = finishReason ?? lastFinishReason
      parts.push(finishPart(reason, hasUsage ? usageToAiSdk(rawUsage) : undefined))
    }
    return parts
  }
}

export function createAnthropicStreamParser(): (event: unknown) => LanguageModelV3StreamPart[] {
  const toolBlocks = new Map<number, ToolCallBuffer>()
  const blockTypes = new Map<number, "text" | "tool_use" | "thinking">()
  // Start-id per block index (issue #72): content_block_start may carry a real
  // block id (thinking blocks), and the matching content_block_stop must close
  // the SAME id — the bare `thinking-<index>` fallback is only correct when no
  // id was provided.
  const blockIds = new Map<number, string>()
  return (event) => {
    if (!isRecord(event)) return []
    const type = stringValue(event.type)
    if (type === "content_block_start") {
      const block = asRecord(event.content_block)
      const index = numberValue(event.index) ?? 0
      const blockType = stringValue(block?.type)
      if (blockType === "tool_use") {
        blockTypes.set(index, "tool_use")
        const id = stringValue(block?.id) ?? `tool-${index}`
        blockIds.set(index, id)
        const name = stringValue(block?.name) ?? ""
        toolBlocks.set(index, { id, name, input: "", started: true, emitted: false })
        return [{ type: "tool-input-start", id, toolName: name }]
      }
      if (blockType === "thinking") {
        blockTypes.set(index, "thinking")
        const id = stringValue(block?.id) ?? `thinking-${index}`
        blockIds.set(index, id)
        return [{ type: "reasoning-start", id }]
      }
      if (blockType === "text") {
        blockTypes.set(index, "text")
        const id = `text-${index}`
        blockIds.set(index, id)
        return [{ type: "text-start", id }]
      }
      return []
    }
    if (type === "content_block_delta") {
      const delta = asRecord(event.delta)
      const index = numberValue(event.index) ?? 0
      const text = stringValue(delta?.text)
      if (typeof text === "string" && text.length > 0) {
        return [{ type: "text-delta", id: `text-${index}`, delta: text }]
      }
      const thinking = stringValue(delta?.thinking)
      if (typeof thinking === "string" && thinking.length > 0) {
        return [{ type: "reasoning-delta", id: `thinking-${index}`, delta: thinking }]
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
      const bType = blockTypes.get(index)
      blockTypes.delete(index)
      const startedId = blockIds.get(index) ?? `thinking-${index}`
      blockIds.delete(index)
      if (bType === "tool_use") {
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
      } else if (bType === "thinking") {
        return [{ type: "reasoning-end", id: startedId }]
      }
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
      // Text blocks are the only remaining family: close with the start id
      // recorded for this index (falls back to the index-derived id for
      // streams whose start event never arrived).
      return [{ type: "text-end", id: bType === "text" ? startedId : `text-${index}` }]
    }
    // Everything else (message_delta, message_stop, ping, error, …) shares the
    // stateless mapper's handling.
    return anthropicEventToStreamPart(event)
  }
}

// Canonical stream entry points: openAIEventToStreamPart / anthropicEventToStreamPart
// and the per-stream stateful parsers createOpenAIStreamParser / createAnthropicStreamParser.
