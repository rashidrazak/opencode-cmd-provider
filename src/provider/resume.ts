// src/provider/resume.ts — the paused assistant turn a continuation re-sends
// (issues #188, #189)
//
// On the Provider API a paused turn is continued by re-sending the request with
// the paused assistant turn appended: that is how upstream `command-code@1.54.x`
// resumes it (`withResumedAssistantTurn`, whose AI-SDK path appends
// `{ role: "assistant", content: assistantParts(partial) }` to the messages).
// The legacy `/alpha/generate` transport never asks here — upstream re-POSTs the
// same body there, and so does this plugin (issue #172).
//
// The turn is read off the stream parts the paused response emitted, so a shape
// this module cannot put back on the wire faithfully fails the turn rather than
// being silently dropped: a resume that loses part of the model's turn is worse
// than a visible failure. Content the stream never turned into a part is
// invisible here — an Anthropic block the parser does not model emits none
// (#72) — which is why the transport refuses a pause that carried one before
// ever asking this module to rebuild it (issue #192).
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { isRecord, stringValue } from "./converters.js"
import { redactCommandCodeErrorText } from "./redact.js"
import { RESUME_UNSUPPORTED_FAILURE, TransportFailureError } from "./retry.js"

/** The wire dialect the continuation request is built for. */
export type ResumeDialect = "anthropic" | "openai"

/** One content block of the paused assistant turn, in the order the response
 * streamed it. Blocks are delimited by their start and end parts: a reasoning
 * block's metadata — a signature, or a redacted payload — belongs to the block
 * that carried it, and a later block may reuse the id (each response of a paused
 * turn names its blocks from the same counters), so blocks never merge. */
type ResumedBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; metadata?: ReasoningMetadata }
  | { kind: "tool-call"; id: string; name: string; input: string }

/** What a reasoning block carries beyond its text: Anthropic's signature for a
 * thinking block, or the encrypted payload of a redacted one. Neither can be
 * re-derived, so both are replayed verbatim. */
interface ReasoningMetadata {
  signature?: string
  redactedData?: string
}

/** A tool call's arguments, parsed and checked, in the two encodings the wires
 * need: the JSON object Anthropic takes and the JSON text OpenAI takes. */
interface ResumedToolCall {
  id: string
  name: string
  input: unknown
  argumentsJson: string
}

/**
 * The assistant message a continuation appends to the request the paused turn
 * was sent with. `parts` is everything the turn has produced so far — a turn
 * that paused twice contributes both segments, in order, as one assistant
 * message. Returns undefined when the paused response produced no content at
 * all — there is nothing to append, and the request is re-sent as it was.
 * Throws when the turn carries a shape this module cannot represent.
 */
export function resumedAssistantMessage(
  parts: readonly LanguageModelV3StreamPart[],
  dialect: ResumeDialect,
): Record<string, unknown> | undefined {
  const blocks = collectBlocks(parts)
  if (blocks.length === 0) return undefined
  return dialect === "anthropic" ? anthropicMessage(blocks) : openAIMessage(blocks)
}

/**
 * The request body a continuation sends: the body the paused turn was sent
 * with, plus the resumed assistant turn. A body the append cannot be made to
 * (no `messages` array) is a bug in the caller's own encoder, not a provider
 * failure — it fails loudly rather than sending the conversation without the
 * turn being continued.
 */
export function withResumedAssistantTurn(
  body: Record<string, unknown>,
  parts: readonly LanguageModelV3StreamPart[],
  dialect: ResumeDialect,
): Record<string, unknown> {
  const resumed = resumedAssistantMessage(parts, dialect)
  if (resumed === undefined) return body
  const messages = body.messages
  if (!Array.isArray(messages)) {
    throw new Error(
      "Command Code request body has no messages array to append the resumed assistant turn to",
    )
  }
  return { ...body, messages: [...messages, resumed] }
}

/**
 * Reads the paused response's content blocks off the parts it emitted, in
 * order. The lifecycles (`text-start`/`text-end`, `tool-input-*`) are
 * scaffolding: the content is in the deltas and the completed `tool-call`.
 */
function collectBlocks(parts: readonly LanguageModelV3StreamPart[]): ResumedBlock[] {
  const blocks: ResumedBlock[] = []
  // The blocks still open, by part id. A block's end removes it, so a later
  // block that reuses the id opens a new one instead of merging into a finished
  // block — which would lose the earlier block's signature or payload, and with
  // it the order the turn was streamed in (issues #189, #194).
  const openById = new Map<string, ResumedBlock>()

  const reasoningFor = (id: string): Extract<ResumedBlock, { kind: "reasoning" }> => {
    const open = openById.get(id)
    if (open?.kind === "reasoning") return open
    const created: ResumedBlock = { kind: "reasoning", text: "" }
    blocks.push(created)
    openById.set(id, created)
    return created
  }

  const textFor = (id: string): Extract<ResumedBlock, { kind: "text" }> => {
    const open = openById.get(id)
    if (open?.kind === "text") return open
    const created: ResumedBlock = { kind: "text", text: "" }
    blocks.push(created)
    openById.set(id, created)
    return created
  }

  /** Records whatever the reasoning part carries for its open block — Anthropic
   * puts a redacted payload on a block's start and this transport puts a
   * signature on its end, so either part is read. */
  const recordReasoningMetadata = (id: string, part: LanguageModelV3StreamPart): void => {
    const metadata = reasoningMetadataOf(part)
    if (metadata === undefined) return
    const block = reasoningFor(id)
    block.metadata = { ...block.metadata, ...metadata }
  }

  for (const part of parts) {
    switch (part.type) {
      case "text-start":
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end":
        break
      case "text-delta":
        textFor(part.id).text += part.delta
        break
      case "text-end":
        openById.delete(part.id)
        break
      case "reasoning-start":
        recordReasoningMetadata(part.id, part)
        break
      case "reasoning-delta":
        reasoningFor(part.id).text += part.delta
        break
      case "reasoning-end":
        recordReasoningMetadata(part.id, part)
        openById.delete(part.id)
        break
      case "tool-call":
        blocks.push({
          kind: "tool-call",
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        })
        break
      default:
        throw unrepresentable(`a ${String((part as { type?: unknown }).type)} block`)
    }
  }

  // An empty text block carries nothing to replay; an empty *thinking* block
  // does (its signature), so only text is dropped here.
  return blocks.filter((block) => block.kind !== "text" || block.text.length > 0)
}

/**
 * The provider metadata a reasoning part may carry: Anthropic's `signature` on
 * a thinking block, or the encrypted `redactedData` of a block the provider's
 * safety system withheld. Both are read wherever they appear — the AI SDK's
 * Anthropic provider puts the payload on the block's start, this transport puts
 * a signature on its end, and a gateway may do either (issues #189, #194).
 */
function reasoningMetadataOf(part: LanguageModelV3StreamPart): ReasoningMetadata | undefined {
  const metadata = (part as { providerMetadata?: unknown }).providerMetadata
  if (!isRecord(metadata) || !isRecord(metadata.anthropic)) return undefined
  const signature = stringValue(metadata.anthropic.signature)
  const redactedData = stringValue(metadata.anthropic.redactedData)
  if (signature === undefined && redactedData === undefined) return undefined
  return {
    ...(signature !== undefined ? { signature } : {}),
    ...(redactedData !== undefined ? { redactedData } : {}),
  }
}

/**
 * The Anthropic assistant message: an ordered content array, exactly the shape
 * the provider streamed. A thinking block is replayed with the signature it was
 * given — the API requires one, and this plugin cannot derive it — a redacted
 * block with the payload it was given, verbatim, and tool call arguments are the
 * JSON object the wire expects.
 */
function anthropicMessage(blocks: readonly ResumedBlock[]): Record<string, unknown> {
  const content: unknown[] = []
  for (const block of blocks) {
    if (block.kind === "text") {
      content.push({ type: "text", text: block.text })
    } else if (block.kind === "reasoning") {
      const metadata = block.metadata ?? {}
      if (metadata.redactedData !== undefined) {
        // Encrypted reasoning: the payload *is* the block — it has no text, and
        // the API validates it on replay, so it goes back byte for byte (#194).
        content.push({ type: "redacted_thinking", data: metadata.redactedData })
      } else if (metadata.signature === undefined) {
        // No signature means the provider never signed the block (or the
        // gateway dropped the delta), so the API would reject the replay. A
        // resume that silently loses the model's reasoning is not a resume.
        throw unrepresentable("unsigned reasoning")
      } else {
        content.push({ type: "thinking", thinking: block.text, signature: metadata.signature })
      }
    } else {
      const call = encodedToolCall(block)
      if (!isRecord(call.input)) {
        throw unrepresentable("a tool call whose arguments are not a JSON object")
      }
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input })
    }
  }
  return { role: "assistant", content }
}

/**
 * The OpenAI assistant message: text as `content`, tool calls as `tool_calls`,
 * reasoning as `reasoning_content` — the field this transport's OpenAI codec
 * reads a reasoning delta back from. The dialect has no signature field and no
 * field for an encrypted payload either, and none of its streams carry one
 * (both are Anthropic's) — so a redacted block on this wire is refused rather
 * than dropped.
 */
function openAIMessage(blocks: readonly ResumedBlock[]): Record<string, unknown> {
  const text: string[] = []
  const reasoning: string[] = []
  const toolCalls: unknown[] = []
  for (const block of blocks) {
    if (block.kind === "text") text.push(block.text)
    else if (block.kind === "reasoning") {
      if (block.metadata?.redactedData !== undefined) {
        throw unrepresentable("encrypted reasoning this dialect cannot carry")
      }
      reasoning.push(block.text)
    } else {
      const call = encodedToolCall(block)
      toolCalls.push({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsJson },
      })
    }
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    // OpenAI wants null content on a message that is nothing but tool calls.
    content: text.length > 0 ? text.join("") : null,
  }
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("")
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return message
}

/**
 * A tool call's arguments, checked once: a call with no id or name cannot be
 * replayed (the results that follow would have nothing to line up with), and
 * arguments that are not JSON text are not a call this transport streamed.
 */
function encodedToolCall(block: Extract<ResumedBlock, { kind: "tool-call" }>): ResumedToolCall {
  if (block.id.length === 0 || block.name.length === 0) {
    throw unrepresentable("a tool call without an id or name")
  }
  let input: unknown
  try {
    input = JSON.parse(block.input)
  } catch {
    throw unrepresentable("a tool call whose arguments are not JSON")
  }
  // The raw argument text is what the OpenAI wire takes, verbatim: the codec
  // streamed a fragment string, and re-serialising it would rewrite the call's
  // own bytes.
  return { id: block.id, name: block.name, input, argumentsJson: block.input }
}

/**
 * The failure a paused turn this build cannot resume raises. Permanent for the
 * turn: re-sending the same request could only pause it again.
 */
function unrepresentable(shape: string): TransportFailureError {
  return new TransportFailureError(
    redactCommandCodeErrorText(
      `Command Code paused this turn with ${shape}, which cannot be carried into the continuation — the turn did not finish`,
    ),
    RESUME_UNSUPPORTED_FAILURE,
  )
}
