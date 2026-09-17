// src/provider/resume.ts — the paused assistant turn a continuation re-sends
// (issues #188, #189)
//
// On the Provider API a paused turn is continued by re-sending the request with
// the paused assistant turn appended: that is how upstream `command-code@1.54.x`
// resumes it (`withResumedAssistantTurn`, its AI-SDK path appends
// `{ role: "assistant", content: assistantParts(partial) }` to the messages).
// The legacy `/alpha/generate` transport never asks here — upstream re-POSTs the
// same body there, and so does this plugin (issue #172).
//
// The turn is read off the stream parts the paused response emitted, so a shape
// this module cannot put back on the wire faithfully must fail the turn rather
// than be silently dropped: a resume that loses part of the model's turn is
// worse than a visible failure.
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { redactCommandCodeErrorText } from "./redact.js"
import { RESUME_UNSUPPORTED_FAILURE, TransportFailureError } from "./retry.js"

/** The wire dialect the continuation request is built for. */
export type ResumeDialect = "anthropic" | "openai"

/** The assistant message a continuation appends, or undefined when the paused
 * response produced no content at all (nothing to append — the request is
 * re-sent as it was). Throws when the turn carries a shape this module cannot
 * represent. */
export function resumedAssistantMessage(
  parts: readonly LanguageModelV3StreamPart[],
  dialect: ResumeDialect,
): Record<string, unknown> | undefined {
  const text = resumedText(parts)
  if (text === undefined) return undefined
  return dialect === "anthropic"
    ? { role: "assistant", content: [{ type: "text", text }] }
    : { role: "assistant", content: text }
}

/**
 * The text the paused response produced: every `text-delta` it emitted, in
 * order. A paused turn's text blocks are one continuous answer to the same
 * turn, so they are joined rather than kept apart.
 *
 * Tool calls and reasoning blocks are refused for now (issue #188): the
 * continuation cannot carry them yet, and resuming with only the text would
 * hand the model a turn it never made.
 */
function resumedText(parts: readonly LanguageModelV3StreamPart[]): string | undefined {
  let text = ""
  for (const part of parts) {
    switch (part.type) {
      case "text-delta":
        text += part.delta
        break
      case "text-start":
      case "text-end":
        break
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end":
      case "tool-call":
        throw unrepresentable("tool calls")
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end":
        throw unrepresentable("reasoning blocks")
      default:
        throw unrepresentable(`a ${String((part as { type?: unknown }).type)} block`)
    }
  }
  return text.length > 0 ? text : undefined
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
