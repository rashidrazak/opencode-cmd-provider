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
// than a visible failure. What the stream does not carry, this module cannot see
// either: an Anthropic block the parser does not model (`redacted_thinking`, a
// server tool block) emits no part today (#72), so it cannot appear in a
// continuation — closing that gap means modelling those blocks in the stream
// first.
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { isRecord, stringValue } from "./converters.js"
import { redactCommandCodeErrorText } from "./redact.js"
import { RESUME_UNSUPPORTED_FAILURE, TransportFailureError } from "./retry.js"

/** The wire dialect the continuation request is built for. */
export type ResumeDialect = "anthropic" | "openai"

/** One content block of the paused assistant turn, in the order the response
 * streamed it. */
type ResumedBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; signature?: string }
  | { kind: "tool-call"; id: string; name: string; input: string }

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
  const openById = new Map<string, ResumedBlock>()

  const reasoningFor = (id: string): Extract<ResumedBlock, { kind: "reasoning" }> => {
    const open = openById.get(id)
    if (open?.kind === "reasoning") return open
    const created: ResumedBlock = { kind: "reasoning", text: "" }
    blocks.push(created)
    openById.set(id, created)
    return created
  }

  for (const part of parts) {
    switch (part.type) {
      case "text-start":
      case "text-end":
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end":
        break
      case "text-delta": {
        const open = openById.get(part.id)
        if (open?.kind === "text") open.text += part.delta
        else {
          const created: ResumedBlock = { kind: "text", text: part.delta }
          blocks.push(created)
          openById.set(part.id, created)
        }
        break
      }
      case "reasoning-start":
        reasoningFor(part.id)
        break
      case "reasoning-delta":
        reasoningFor(part.id).text += part.delta
        break
      case "reasoning-end": {
        const signature = signatureOf(part)
        if (signature !== undefined) reasoningFor(part.id).signature = signature
        break
      }
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

/** The signature Anthropic put on a thinking block, if this part carries one. */
function signatureOf(part: LanguageModelV3StreamPart): string | undefined {
  const metadata = (part as { providerMetadata?: unknown }).providerMetadata
  if (!isRecord(metadata)) return undefined
  return isRecord(metadata.anthropic) ? stringValue(metadata.anthropic.signature) : undefined
}

/**
 * The Anthropic assistant message: an ordered content array, exactly the shape
 * the provider streamed. A thinking block is replayed with the signature it was
 * given — the API requires one, and this plugin cannot derive it — and tool call
 * arguments are the JSON object the wire expects.
 */
function anthropicMessage(blocks: readonly ResumedBlock[]): Record<string, unknown> {
  const content: unknown[] = []
  for (const block of blocks) {
    if (block.kind === "text") {
      content.push({ type: "text", text: block.text })
    } else if (block.kind === "reasoning") {
      if (block.signature === undefined) {
        // No signature means the provider never signed the block (or the
        // gateway dropped the delta), so the API would reject the replay. A
        // resume that silently loses the model's reasoning is not a resume.
        throw unrepresentable("unsigned reasoning")
      }
      content.push({ type: "thinking", thinking: block.text, signature: block.signature })
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
 * reads a reasoning delta back from. The dialect has no signature field, and
 * none of its streams carry one (signatures are Anthropic's).
 */
function openAIMessage(blocks: readonly ResumedBlock[]): Record<string, unknown> {
  const text: string[] = []
  const reasoning: string[] = []
  const toolCalls: unknown[] = []
  for (const block of blocks) {
    if (block.kind === "text") text.push(block.text)
    else if (block.kind === "reasoning") reasoning.push(block.text)
    else {
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
