// src/provider/stream.ts — Command Code SSE events → AI SDK v3 stream parts (PLAN #3 Part A)
//
// Provider streaming contracts: https://commandcode.ai/docs/provider#streaming
// - OpenAI /provider/v1/chat/completions: stream:true + stream_options:{include_usage:true}
//   streams choices[].delta.content and final usage chunk → finish {usage}
// - Anthropic /provider/v1/messages: stream:true streams content_block_* and message_delta {usage} → finish
//   Both emit usage at end without extra opt-in; errors use OpenAI {error:{message,type}} vs
//   Anthropic {type:"error",error:{type,message}} envelopes (see #errors).
//
// Event mapping is split by scope: the stateful parsers own content (block
// lifecycles, part ids, fragmented tool arguments) and the stateless mappers
// cover only events that are complete in a single message.
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
//     carries the fresh-only remainder so downstream context usage and cost
//     display stay correct (issue #36).
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
} from "@ai-sdk/provider"
import { isRecord, stringValue, numberValue, recordOrEmpty } from "./converters.js"
import { commandCodeErrorMessage, redactCommandCodeErrorText } from "./redact.js"
import {
  NETWORK_FAILURE,
  TRUNCATION_FAILURE,
  TRUNCATION_MESSAGE,
  TransportFailureError,
  type StreamErrorFacts,
} from "./retry.js"

type FinishPart = Extract<LanguageModelV3StreamPart, { type: "finish" }>

/**
 * Marks a `finish` part whose usage this codec had to synthesize because the
 * wire reported none. Such a part is not a complete turn report — the usage
 * chunk the codec was waiting for never arrived — and the transport refuses to
 * emit it as one (issue #171). Symbol-keyed on purpose: the marker is internal
 * to this package and never shows up on a part a consumer serializes.
 */
const SYNTHESIZED_USAGE = Symbol("commandcode.synthesizedUsage")

/**
 * True when a held `finish` part carries usage the provider actually reported.
 * A finish whose usage this module invented (`zeroedUsage()`) is a lie about
 * the turn's cost, so the transport fails (and may retry) instead of emitting
 * it (issue #171).
 */
export function finishCarriesReportedUsage(part: FinishPart): boolean {
  return (part as FinishPart & { [SYNTHESIZED_USAGE]?: true })[SYNTHESIZED_USAGE] !== true
}

/**
 * The wire's stop reason for a turn the provider paused rather than finished:
 * the model stopped mid-turn and the same request continues it. It arrives in
 * every codec's own spelling — Anthropic's `message_delta` stop_reason, the
 * legacy `finish` event, an OpenAI `finish_reason` — and maps to the unified
 * `other`, since the AI SDK has no reason for it. The transport owns what a
 * pause means; this module owns only the vocabulary (issue #172).
 */
const PAUSE_TURN_REASON = "pause_turn"

/**
 * True when a `finish` reports a paused turn. Upstream `command-code@1.54.0`
 * loops on exactly this raw reason (`Ph = 5`) and folds the continuations'
 * usage with `addUsage2` (issue #172). Only the finish reason is read, so the
 * check takes the one field it needs rather than the whole part.
 */
export function finishIsPauseTurn(part: Pick<FinishPart, "finishReason">): boolean {
  return part.finishReason.raw === PAUSE_TURN_REASON
}

/**
 * Sums two usage reports into one. The v3 shape's `total` fields are
 * cache-inclusive, so component-wise addition is correct for every bucket;
 * an absent bucket counts as zero. The transport uses it to fold a paused
 * turn's continuations into the single finish it emits — upstream's
 * `addUsage2`, the only place the CLI sums usage across responses (issue
 * #172).
 */
export function addAiSdkUsage(
  a: LanguageModelV3Usage,
  b: LanguageModelV3Usage,
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: (a.inputTokens.total ?? 0) + (b.inputTokens.total ?? 0),
      noCache: (a.inputTokens.noCache ?? 0) + (b.inputTokens.noCache ?? 0),
      cacheRead: (a.inputTokens.cacheRead ?? 0) + (b.inputTokens.cacheRead ?? 0),
      cacheWrite: (a.inputTokens.cacheWrite ?? 0) + (b.inputTokens.cacheWrite ?? 0),
    },
    outputTokens: {
      total: (a.outputTokens.total ?? 0) + (b.outputTokens.total ?? 0),
      text: (a.outputTokens.text ?? 0) + (b.outputTokens.text ?? 0),
      reasoning: (a.outputTokens.reasoning ?? 0) + (b.outputTokens.reasoning ?? 0),
    },
  }
}

/**
 * The server's own `error` event, surfaced as a failure the transport can
 * classify (issue #171). The AI SDK `error` part has room for the message
 * only, so the event's retryability signals — its `isRetryable` flag, the
 * status it reported, its code and rate-limit window — ride on the instance.
 * The message is redacted where the error is built.
 */
export class ProviderStreamError extends Error {
  readonly facts: StreamErrorFacts
  constructor(message: string, facts: StreamErrorFacts) {
    super(message)
    this.name = "ProviderStreamError"
    this.facts = facts
  }
}

/**
 * The facts an error event gives about its own failure. Both wire envelopes
 * carry them under `error` (the OpenAI `{error:{message,type,statusCode,
 * isRetryable}}` shape and the Anthropic `{type:"error",error:{…}}` one); a
 * string `error` carries a message and nothing else. A message the event never
 * gave stays empty: classification must not invent wording to match on.
 */
function streamErrorFacts(event: Record<string, unknown>): StreamErrorFacts {
  const inner = isRecord(event.error) ? event.error : event
  return {
    message: commandCodeErrorMessage(event.error) ?? commandCodeErrorMessage(event.message) ?? "",
    reportedStatus: numberValue(inner.statusCode) ?? numberValue(inner.status),
    retryableFlag: typeof inner.isRetryable === "boolean" ? inner.isRetryable : undefined,
    code: stringValue(inner.code),
    window: isRecord(inner.rateLimit) ? inner.rateLimit.window : undefined,
  }
}

/** Throws the redacted, classified failure an error event describes. */
function throwStreamError(event: Record<string, unknown>, message: string): never {
  throw new ProviderStreamError(redactCommandCodeErrorText(message), streamErrorFacts(event))
}

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

/**
 * The tool-call spellings: Anthropic's `tool_use`, the OpenAI `tool_calls`, the
 * hyphenated AI SDK form, and OpenAI's older `function_call`. Upstream
 * `command-code@1.54.1` normalises the reason by lowercasing it first
 * (`normalizeStopReason` / `normalizeStopReason2`), so the match is
 * case-insensitive here too (issue #186).
 */
const TOOL_CALL_FINISH_REASONS = new Set([
  "tool_use",
  "tool-calls",
  "tool_calls",
  "function_call",
  "function-call",
])

/**
 * The length family: OpenAI's `length`, the `max_tokens` /
 * `max_output_tokens` spellings, and Anthropic's context-window exhaustion.
 * Upstream groups exactly these under `max_tokens`.
 */
const LENGTH_FINISH_REASONS = new Set([
  "length",
  "max_tokens",
  "max-tokens",
  "max_output_tokens",
  "max-output-tokens",
  "model_context_window_exceeded",
  "model-context-window-exceeded",
])

/**
 * Maps a wire stop reason to the AI SDK v3 finish reason (issue #186).
 *
 * The vocabulary is the one the wire can actually send, matched
 * case-insensitively the way upstream's normaliser matches. Everything else —
 * `stop`, `end_turn`, `stop_sequence`, `refusal`, `content_filter`,
 * `max_turn_requests`, `cancelled`, and any reason this build has never seen —
 * is a **completed turn**: upstream's normaliser maps every reason it does not
 * recognise to `end_turn`, and a turn that ended must never be reported as
 * `unified: "other"` (OpenCode v2 coerces that to `unknown` and fails the turn
 * as a retryable incomplete stream — ADR-0013). Deliberately, no refusal or
 * content-filter spelling maps to the AI SDK's `content-filter` either: the
 * plugin's contract is CLI parity, and the CLI completes such a turn (the
 * model's refusal is the answer) rather than labelling it filtered.
 *
 * The one reason whose unified value is not decided here is the pause marker:
 * `pause_turn` maps to a completed turn too, but the transport intercepts the
 * finish by its raw reason before any part is emitted (issue #172).
 */
export function mapFinishReason(reason: unknown): LanguageModelV3FinishReason {
  const raw = stringValue(reason) ?? "unknown"
  const normalised = raw.toLowerCase()
  if (TOOL_CALL_FINISH_REASONS.has(normalised)) return { unified: "tool-calls", raw }
  if (LENGTH_FINISH_REASONS.has(normalised)) return { unified: "length", raw }
  if (normalised === "error") return { unified: "error", raw }
  return { unified: "stop", raw }
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

/**
 * Upstream's `isNetworkFailureFinish` (`command-code@1.54.1`): a finish reason
 * naming a failure of the connection that carried the stream — `network`,
 * `connection` or `upstream` + `error`, with any separator and in any case.
 * Such a turn died mid-stream; it never ended.
 */
export function isNetworkFailureFinishReason(reason: string): boolean {
  return /^(?:network|connection|upstream)[-_\s]?error$/i.test(reason.trim())
}

/**
 * The two guards upstream's legacy consume loop carries on its finish event and
 * this codec did not (issue #187). Both are raised instead of mapped, because
 * neither is an ending: the vocabulary mapper completes every reason it does
 * not recognise (issue #186), so without these a truncated or connection-failed
 * turn would be reported to the Host as a finished one — and OpenCode v2 would
 * fail it anyway as an unknown finish reason.
 *
 * - A finish reporting the AI SDK's `other` **with no raw reason** never ended a
 *   turn: upstream's condition is `stopReason === "other" && rawFinishReason ===
 *   undefined`, and it raises its own truncation error for it (retryable while
 *   the consumer has seen nothing — the body may simply have been cut).
 * - A reason naming a network/connection/upstream error is a transport failure
 *   that died mid-stream, retryable the same way.
 *
 * The two fields are read the way the finish mapping below reads them: the
 * unified reason off `finishReason`, the effective raw reason off
 * `rawFinishReason ?? finishReason`.
 */
function assertLegacyFinishEndedTurn(event: Record<string, unknown>): void {
  const rawReason = stringValue(event.rawFinishReason)
  if (rawReason === undefined && stringValue(event.finishReason)?.toLowerCase() === "other") {
    throw new TransportFailureError(TRUNCATION_MESSAGE, TRUNCATION_FAILURE, 502)
  }
  const reason = rawReason ?? stringValue(event.finishReason)
  if (reason !== undefined && isNetworkFailureFinishReason(reason)) {
    throw new TransportFailureError(
      redactCommandCodeErrorText(
        `Provider finished with reason "${reason}" — upstream connection failed mid-stream`,
      ),
      NETWORK_FAILURE,
      502,
    )
  }
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
      // The legacy codec's terminal carries its usage inline
      // (`totalUsage`): a finish without one has none to report. Upstream's
      // own consumer reads the terminal's two reason fields apart — the
      // unified reason off `finishReason`, the raw one off `rawFinishReason ??
      // finishReason` — and the transport loops on the raw one, where
      // `pause_turn` is reported (issue #172). Two of those readings are not
      // endings at all and are refused before any part exists (issue #187).
      assertLegacyFinishEndedTurn(event)
      const reason = mapFinishReason(event.finishReason)
      const rawReason = stringValue(event.rawFinishReason)
      return [
        finishPart(
          rawReason === undefined ? reason : { unified: reason.unified, raw: rawReason },
          ccUsageToAiSdkUsage(event),
        ),
      ]
    }
    case "error": {
      throwStreamError(
        event,
        commandCodeErrorMessage(event.error) ??
          commandCodeErrorMessage(event.message) ??
          "Command Code stream error",
      )
    }
    default:
      // Events with no part of their own. That includes the finish-less
      // terminals `ccEventIsTerminal` owns (`CC_FINISHLESS_TERMINALS`): their
      // meaning is the end of the turn, not a part (issue #170).
      return []
  }
}

/**
 * The legacy `/alpha/generate` event types that end a stream *without* a finish
 * part — `{"type":"abort"}`, the server's "generation aborted" terminal. The
 * single authority for that vocabulary: `ccEventIsTerminal` reads it, and
 * `ccEventToStreamPart` leaves them to the `default` branch.
 */
const CC_FINISHLESS_TERMINALS = new Set(["abort"])

/**
 * True for an event in `CC_FINISHLESS_TERMINALS`. Upstream's AI SDK consumer
 * treats such an event as a clean end — its truncation check is
 * `!finish && !abort` (`consumeFullStream`) — and ai@6 tolerates a missing
 * finish (its part transform closes the stream), so the transport closes the
 * parts the parser still holds open and ends the turn, instead of fabricating
 * a `finish` or reporting the close as a truncation (issue #170).
 */
export function ccEventIsTerminal(event: unknown): boolean {
  if (!isRecord(event)) return false
  const type = stringValue(event.type)
  return type !== undefined && CC_FINISHLESS_TERMINALS.has(type)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function extractUsageTokens(
  usage: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const rec = asRecord(usage)
  if (!rec) return undefined
  // OpenAI: prompt_tokens / completion_tokens / total_tokens, with the cached
  // prefix nested in prompt_tokens_details.cached_tokens (DeepSeek also reports
  // prompt_cache_hit_tokens at the top level).
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
  // Explicit top-level cache fields win; the OpenAI nested detail and the
  // DeepSeek top-level alias are the last resorts (issue #158).
  const promptDetails = asRecord(rec.prompt_tokens_details)
  const cacheRead =
    numberValue(rec.cache_read_input_tokens) ??
    numberValue(rec.cacheReadTokens) ??
    numberValue(rec.cacheRead) ??
    numberValue(promptDetails?.cached_tokens) ??
    numberValue(rec.prompt_cache_hit_tokens) ??
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

/**
 * How a provider's prompt total relates to the cached prefix it reports.
 * OpenAI's `prompt_tokens` already counts the cached tokens; Anthropic's
 * `input_tokens` counts only the fresh remainder (#158, #178).
 */
type InputTokenAccounting = "cache-inclusive" | "cache-exclusive"

function usageToAiSdk(
  usage: unknown,
  inputAccounting: InputTokenAccounting,
): LanguageModelV3Usage | undefined {
  const tokens = extractUsageTokens(usage)
  if (!tokens) return undefined
  // `total` is cache-inclusive by AI SDK v3 convention and `noCache` is the
  // fresh remainder, whichever way the provider reports its prompt total.
  const cacheInclusive = inputAccounting === "cache-inclusive"
  return {
    inputTokens: {
      total: cacheInclusive ? tokens.input : tokens.input + tokens.cacheRead + tokens.cacheWrite,
      noCache: cacheInclusive
        ? Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite)
        : tokens.input,
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

/** The usage object inside an event, or the value itself when it already is
 * one: these mappers accept either ("event may be the full chunk or just the
 * usage object"). */
function usageArgOf(eventOrUsage: unknown): unknown {
  return isRecord(eventOrUsage) ? (eventOrUsage.usage ?? eventOrUsage) : eventOrUsage
}

/**
 * Maps OpenAI-shape usage: `prompt_tokens` counts the cached prefix
 * (`prompt_tokens_details.cached_tokens`), so the fresh remainder is derived by
 * subtracting it (issue #158).
 */
export function openAIUsageToAiSdkUsage(event: unknown): LanguageModelV3Usage | undefined {
  return usageToAiSdk(usageArgOf(event), "cache-inclusive")
}

/**
 * Maps Anthropic-shape usage: `input_tokens` excludes the cached prefix, so
 * the cache-inclusive total the AI SDK expects is the sum of all three buckets
 * and `noCache` is `input_tokens` itself (issue #178).
 */
export function anthropicUsageToAiSdkUsage(event: unknown): LanguageModelV3Usage | undefined {
  return usageToAiSdk(usageArgOf(event), "cache-exclusive")
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

/** Records that a finish part's usage was invented, not reported (#171). */
function markSynthesizedUsage(part: FinishPart): FinishPart {
  ;(part as FinishPart & { [SYNTHESIZED_USAGE]?: true })[SYNTHESIZED_USAGE] = true
  return part
}

/**
 * The one finish-part constructor. A `usage` the codec could not read means
 * the wire reported none, so the part is zero-filled *and* marked as
 * synthesized: the transport fails such a turn instead of reporting it as a
 * complete one with zero cost (issue #171).
 */
function finishPart(
  finishReason: LanguageModelV3FinishReason | undefined,
  usage: LanguageModelV3Usage | undefined,
): FinishPart {
  const part: FinishPart = {
    type: "finish",
    finishReason: finishReason ?? { unified: "stop", raw: "stop" },
    usage: usage ?? zeroedUsage(),
  }
  return usage === undefined ? markSynthesizedUsage(part) : part
}

function textDeltaPart(id: unknown, delta: string): LanguageModelV3StreamPart {
  return { type: "text-delta", id: stringValue(id) ?? "text", delta }
}

function reasoningDeltaPart(id: unknown, delta: string): LanguageModelV3StreamPart {
  return { type: "reasoning-delta", id: stringValue(id) ?? "reasoning", delta }
}

/**
 * The end of a thinking block. Anthropic signs such a block with a
 * `signature_delta`, an event with no part of its own; the signature rides here
 * instead, in the provider metadata the AI SDK reserves for provider-specific
 * data (the Anthropic convention is `providerMetadata.anthropic.signature`), so
 * a request that continues a paused turn can replay the block verbatim rather
 * than re-derive a signature it cannot (issue #189).
 */
function reasoningEndPart(entry: { id: string; signature?: string }): LanguageModelV3StreamPart {
  return entry.signature === undefined
    ? { type: "reasoning-end", id: entry.id }
    : {
        type: "reasoning-end",
        id: entry.id,
        providerMetadata: { anthropic: { signature: entry.signature } },
      }
}

// --- OpenAI Chat Completions streaming ---
export function openAIEventToStreamPart(event: unknown): LanguageModelV3StreamPart[] {
  if (!isRecord(event)) return []
  // Error handling — OpenAI errors have { error: { message, type, code } } or top-level error
  if (event.error !== undefined) {
    throwStreamError(
      event,
      commandCodeErrorMessage(event.error) ??
        commandCodeErrorMessage(event) ??
        "Provider stream error",
    )
  }
  if (stringValue(event.type) === "error") {
    throwStreamError(
      event,
      commandCodeErrorMessage(event.error) ??
        commandCodeErrorMessage(event.message) ??
        "Provider stream error",
    )
  }

  // Extract usage if present (terminal chunk)
  const rawUsage = (event as Record<string, unknown>).usage
  const hasUsage = rawUsage !== undefined && rawUsage !== null
  const usage = hasUsage ? openAIUsageToAiSdkUsage(rawUsage) : undefined

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
    throwStreamError(
      event,
      commandCodeErrorMessage(event.error) ??
        commandCodeErrorMessage(event.message) ??
        "Provider stream error",
    )
  }

  // Content blocks belong to createAnthropicStreamParser, the only Anthropic
  // entry point that sees a whole stream. A per-event mapper cannot complete
  // them: `content_block_stop` carries just the block index — never the type —
  // so the correct end part (`text-end`, `reasoning-end` or `tool-input-end`)
  // is unknowable here, and a tool call whose `input_json_delta` fragments span
  // events cannot be completed at all. Emitting a partial lifecycle (starts and
  // deltas with no matching end) would orphan parts for any stateless caller,
  // which is the failure #71 describes, so this codec stays silent for content
  // and maps only the events that are complete in one message: errors, the
  // terminal finish, ping, and the top-level usage fallback below.
  if (
    type === "content_block_start" ||
    type === "content_block_delta" ||
    type === "content_block_stop"
  ) {
    return []
  }

  // Terminal message_delta: { type: "message_delta", delta: { stop_reason }, usage: { ... } }
  if (type === "message_delta") {
    const delta = asRecord(event.delta)
    const stopReason = stringValue(delta?.stop_reason) ?? stringValue(delta?.stopReason) ?? "stop"
    return [finishPart(mapFinishReason(stopReason), anthropicUsageToAiSdkUsage(event))]
  }

  // Alternative terminal: { type: "message_stop" } without usage — emit generic finish.
  // The stateful parser suppresses this once `message_delta` has finished the
  // stream, so the synthesized zeroed usage cannot replace the reported one
  // (issue #174); a stateless caller has no per-stream state to consult.
  if (type === "message_stop") {
    return [finishPart(undefined, undefined)]
  }

  // Ping/heartbeat or other known non-content types
  if (type === "ping" || type === "message_start") return []

  // Fallback: check for usage at top level without type (some providers send final usage as top-level)
  if (event.usage !== undefined) {
    const usage = anthropicUsageToAiSdkUsage(event)
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
// and fragment deltas would carry empty/index-only ids. They cannot complete a
// content-block lifecycle either — `content_block_stop` names only the block
// index, not its type (issue #71). These factories are the sole owners of
// content: they close over per-stream state (block types and ids, tool-call
// buffers) so one stream produces the same observable parts as the legacy
// transport: text/reasoning/tool lifecycles with matching part ids and a final
// tool-call carrying the real tool id, then finish.

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

/**
 * A per-stream event parser: one SSE event in, stream parts out. `closeStream`
 * closes every part the stream still has open when the transport ends it
 * without a terminal event — a mid-stream error, an abort, or a body that stops
 * early (issue #72). It is idempotent.
 *
 * `unmodelledBlocks` reports the content-block types the stream carried that
 * this parser does not model — content it deliberately emits no part for, so
 * nothing downstream can see it (issue #72). A turn that *ends* is unaffected by
 * that: the block is simply not among the parts. A turn the provider **paused**
 * is a different matter, because its continuation is rebuilt from those parts
 * and would silently resume a turn that never contained the block — so the
 * transport asks here before continuing (issue #192). A parser whose dialect has
 * no such concept omits the method.
 */
export interface StreamEventParser {
  (event: unknown): LanguageModelV3StreamPart[]
  closeStream(): LanguageModelV3StreamPart[]
  unmodelledBlocks?(): readonly string[]
}

export function createOpenAIStreamParser(): StreamEventParser {
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

  const parse: StreamEventParser = (event) => {
    if (!isRecord(event)) return []
    // Error events flow through the stateless mapper (redacted throw).
    if (event.error !== undefined || stringValue(event.type) === "error") {
      return openAIEventToStreamPart(event)
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
      // An empty array is not a tool call: some OpenAI-dialect providers attach
      // `tool_calls: []` to every content chunk (Command Code's GLM-5.3 does),
      // and closing the open reasoning/text parts on the empty array split them
      // once per chunk — the same one-word-per-line symptom as the usage
      // terminal below.
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
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
          if (args && !buffer.emitted) buffer.input += args
          if (!buffer.started && buffer.name) {
            buffer.started = true
            parts.push({ type: "tool-input-start", id: buffer.id, toolName: buffer.name })
            // Arguments that arrived before the name opened the part still
            // belong to this call, so they are flushed now: the consumer rejects
            // a tool-input-delta for a call it never saw started (issue #72).
            if (buffer.input) {
              parts.push({ type: "tool-input-delta", id: buffer.id, delta: buffer.input })
            }
          } else if (args && !buffer.emitted && buffer.started) {
            parts.push({ type: "tool-input-delta", id: buffer.id, delta: args })
          }
          // Complete as soon as the accumulated arguments parse as JSON; the
          // finish chunk below flushes anything that never completes. A call
          // that never got a name stays unopened — a bare end would close a part
          // the consumer never saw start.
          if (buffer.started && !buffer.emitted) {
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
    // A usage report alone does not end the turn: some OpenAI-dialect providers
    // attach a cumulative usage object to every content chunk — Command Code's
    // GLM-5.3 does (its Z.ai upstream reports usage per SSE event) — and
    // reading each one as the terminal closed and reopened the reasoning and
    // text parts once per token, which the Host renders one word per line. The
    // dialect's only usage-only terminal is the trailing `choices: []` report,
    // and it counts as terminal only once a finish_reason has already been seen:
    // a usage-only chunk before any finish_reason is a running report from a
    // per-event-usage provider, not an ending.
    const finishReasonRaw =
      stringValue(choice?.finish_reason) ??
      stringValue(choice?.finishReason) ??
      stringValue((event as Record<string, unknown>).finish_reason) ??
      stringValue((event as Record<string, unknown>).finishReason)
    const finishReason = finishReasonRaw ? mapFinishReason(finishReasonRaw) : undefined
    if (finishReason) lastFinishReason = finishReason
    if (lastFinishReason) {
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
      // A usage chunk we cannot read is still a reported usage chunk: the
      // turn is complete and reports zeros, unlike a finish_reason chunk whose
      // trailing usage chunk never arrived (issue #171).
      parts.push(
        finishPart(
          reason,
          hasUsage ? (openAIUsageToAiSdkUsage(rawUsage) ?? zeroedUsage()) : undefined,
        ),
      )
    }
    return parts
  }

  // The transport ends a stream on error/abort without ever seeing a finish, so
  // the open content parts have to be closable from outside this reducer
  // (issue #72).
  parse.closeStream = () => [...closeReasoning(), ...closeText()]
  return parse
}

export function createAnthropicStreamParser(): StreamEventParser {
  const toolBlocks = new Map<number, ToolCallBuffer>()
  // Per-index block state. `type` decides which end part `content_block_stop`
  // emits; `id` is the part id chosen at `content_block_start`, reused by the
  // delta and stop events so they close the part the consumer saw opened.
  // Anthropic's thinking blocks carry no `id` today, but a gateway may add one,
  // and re-deriving the id from the index at every event would then orphan the
  // open reasoning part (issue #71). `signature` is the thinking block's
  // cryptographic signature, which arrives in a `signature_delta` after the
  // thinking deltas: it is what lets a resumed request replay the block, so it
  // rides on the block's `reasoning-end` (issue #189). A block type this parser
  // does not model is recorded as "other" so its stop closes nothing (#72).
  const blocks = new Map<
    number,
    {
      type: "text" | "tool_use" | "thinking" | "redacted_thinking" | "other"
      id: string
      signature?: string
    }
  >()
  // The content-block types this stream carried that the parser does not model.
  // They emit no part (#72), which is invisible for a turn that ends and a lie
  // for a paused turn whose continuation is rebuilt from the parts — the
  // transport reads this before continuing one (issue #192). Not cleared by
  // `closeStream`: a parser is one attempt's stream (`createParser`), and the
  // transport asks once, at the pause decision.
  const unmodelled = new Set<string>()
  // True once a `message_delta` finished this stream. Anthropic reports usage
  // (and the real stop_reason) on `message_delta` and then closes with a bare
  // `message_stop`; mapping that terminal too would hand the transport a
  // second, zeroed finish for its last-wins hold to prefer, zeroing every
  // Claude turn's usage and masking the stop_reason (issue #174). The terminal
  // is still mapped when no `message_delta` arrived — the fallback finish a
  // stream that never reports usage needs.
  let messageDeltaFinished = false

  /**
   * Resolves the part a delta of `kind` belongs to at `index`, synthesizing the
   * start when the delta's own start never arrived (a dropped or unparseable
   * SSE line). The synthesized part is recorded so the matching stop closes the
   * part this stream opened. Returns undefined when the index holds a part of a
   * different kind — a delta for it would be an orphan (issue #72).
   */
  function openPart(
    index: number,
    kind: "text" | "thinking",
  ): { parts: LanguageModelV3StreamPart[]; id: string } | undefined {
    const existing = blocks.get(index)
    if (existing) return existing.type === kind ? { parts: [], id: existing.id } : undefined
    const id = `${kind === "text" ? "text" : "thinking"}-${index}`
    blocks.set(index, { type: kind, id })
    return {
      parts: [{ type: kind === "text" ? "text-start" : "reasoning-start", id }],
      id,
    }
  }

  const parse: StreamEventParser = (event) => {
    if (!isRecord(event)) return []
    const type = stringValue(event.type)
    if (type === "content_block_start") {
      const block = asRecord(event.content_block)
      const index = numberValue(event.index) ?? 0
      const blockType = stringValue(block?.type)
      if (blockType === "tool_use") {
        const id = stringValue(block?.id) ?? `tool-${index}`
        const name = stringValue(block?.name) ?? ""
        blocks.set(index, { type: "tool_use", id })
        toolBlocks.set(index, { id, name, input: "", started: true, emitted: false })
        return [{ type: "tool-input-start", id, toolName: name }]
      }
      if (blockType === "thinking") {
        const id = stringValue(block?.id) ?? `thinking-${index}`
        // A gateway may put the signature on the block start instead of
        // streaming it as a delta; either way it belongs to this block.
        const signature = stringValue(block?.signature)
        blocks.set(index, { type: "thinking", id, ...(signature ? { signature } : {}) })
        return [{ type: "reasoning-start", id }]
      }
      if (blockType === "text") {
        const id = `text-${index}`
        blocks.set(index, { type: "text", id })
        return [{ type: "text-start", id }]
      }
      if (blockType === "redacted_thinking") {
        // Anthropic's encrypted thinking block: it carries no deltas — the
        // whole block is the `data` payload — and it streams as a reasoning
        // block whose start carries the payload in the provider metadata the AI
        // SDK's own Anthropic provider uses (`anthropic.redactedData`). It has
        // to be visible on the stream, or a paused turn's continuation cannot
        // put it back (issues #192, #193).
        const data = stringValue(block?.data)
        if (data !== undefined && data.length > 0) {
          const id = stringValue(block?.id) ?? `redacted-${index}`
          blocks.set(index, { type: "redacted_thinking", id })
          return [
            {
              type: "reasoning-start",
              id,
              providerMetadata: { anthropic: { redactedData: data } },
            },
          ]
        }
        // No payload: there is nothing to replay, so the block falls through to
        // unmodelled — a pause that carried it is refused (#192) rather than
        // handing the provider an empty block.
      }
      // server tool blocks, a future addition: recorded as
      // unmodelled so its stop does not fall through to a text-end for a part
      // that was never opened (issue #72). The type is remembered, not just
      // discarded: a paused turn is continued from the parts, so the transport
      // has to know a block it cannot see was there (issue #192).
      blocks.set(index, { type: "other", id: stringValue(block?.id) ?? `block-${index}` })
      unmodelled.add(blockType ?? "untyped")
      return []
    }
    if (type === "content_block_delta") {
      const delta = asRecord(event.delta)
      const index = numberValue(event.index) ?? 0
      const text = stringValue(delta?.text)
      if (typeof text === "string" && text.length > 0) {
        const part = openPart(index, "text")
        if (!part) return []
        return [...part.parts, { type: "text-delta", id: part.id, delta: text }]
      }
      const thinking = stringValue(delta?.thinking)
      if (typeof thinking === "string" && thinking.length > 0) {
        const part = openPart(index, "thinking")
        if (!part) return []
        return [...part.parts, { type: "reasoning-delta", id: part.id, delta: thinking }]
      }
      const partial = stringValue(delta?.partial_json)
      if (typeof partial === "string" && partial.length > 0) {
        const block = toolBlocks.get(index)
        if (!block) {
          // A fragment carries neither the call id nor its name, so there is no
          // tool part to open when its block start was lost: drop it rather than
          // emit a tool-input-delta the consumer cannot match (issue #72).
          return []
        }
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
      const signature = stringValue(delta?.signature)
      if (typeof signature === "string" && signature.length > 0) {
        // Anthropic signs a thinking block with a `signature_delta` between its
        // thinking deltas and `content_block_stop`. The signature has no part
        // of its own — it is remembered for the block's `reasoning-end`, which
        // is where the transport reads it back for a continuation (issue #189).
        // A signature for a block this parser does not model is ignored, like
        // the block itself.
        const entry = blocks.get(index)
        if (entry?.type === "thinking") entry.signature = signature
        return []
      }
      return []
    }
    if (type === "content_block_stop") {
      const index = numberValue(event.index) ?? 0
      const entry = blocks.get(index)
      blocks.delete(index)
      if (entry?.type === "tool_use") {
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
      } else if (entry?.type === "thinking" || entry?.type === "redacted_thinking") {
        // A redacted block carries no signature, so the helper emits its bare
        // end — the payload rode on the start part.
        return [reasoningEndPart(entry)]
      } else if (entry?.type === "text") {
        return [{ type: "text-end", id: entry.id }]
      } else if (entry) {
        // Unmodelled block: it opened no part, so it closes none.
        return []
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
      // Nothing this stream opened at that index (a stop whose start was lost):
      // emitting an end would close a part the consumer never saw start — the
      // #69 failure mode (issue #72).
      return []
    }
    // Everything else (message_delta, message_stop, ping, error, …) shares the
    // stateless mapper's handling. The terminal is the one exception: once
    // `message_delta` produced the finish, the bare `message_stop` adds neither
    // usage nor a reason, so it maps to nothing rather than to a zeroed finish
    // the transport would prefer (issue #174).
    if (type === "message_stop") {
      return messageDeltaFinished ? [] : anthropicEventToStreamPart(event)
    }
    const parts = anthropicEventToStreamPart(event)
    if (type === "message_delta") messageDeltaFinished = true
    return parts
  }

  // A tool call is settled by its own tool-call part, never by a bare end, so
  // tool blocks are left to the consumer's cleanup; only the content parts this
  // stream opened are closed here (issue #72).
  parse.closeStream = () => {
    const parts: LanguageModelV3StreamPart[] = []
    for (const entry of blocks.values()) {
      if (entry.type === "thinking") parts.push(reasoningEndPart(entry))
      else if (entry.type === "redacted_thinking")
        parts.push({ type: "reasoning-end", id: entry.id })
      else if (entry.type === "text") parts.push({ type: "text-end", id: entry.id })
    }
    blocks.clear()
    return parts
  }
  parse.unmodelledBlocks = () => [...unmodelled]
  return parse
}

// Canonical stream entry points. The transport wires in the stateful parsers
// (createOpenAIStreamParser / createAnthropicStreamParser): they own content —
// block lifecycles, part ids, fragmented tool arguments. The stateless mappers
// (openAIEventToStreamPart / anthropicEventToStreamPart) cover the events that
// are complete in a single message: errors, terminal finish, ping, usage.
