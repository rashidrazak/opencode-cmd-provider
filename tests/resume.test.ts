// tests/resume.test.ts — the paused assistant turn a Provider API continuation
// re-sends (issues #188, #189).
//
// The transport hands this module the stream parts the paused response emitted
// and expects back the assistant message the continuation appends — in the
// dialect's own shape, or a loud failure for a turn it cannot represent.
import { resumedAssistantMessage } from "../src/provider/resume.js"
import type { LanguageModelV3StreamPart } from "../src/provider/aisdk-types.js"
import { assert, assertEqual, run, throws } from "./harness.js"

const parts = (...list: unknown[]): LanguageModelV3StreamPart[] =>
  list as unknown as LanguageModelV3StreamPart[]

const text = (id: string, delta: string): unknown[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta },
  { type: "text-end", id },
]

run([
  [
    "a paused response with no content appends nothing (issue #188)",
    () => {
      assertEqual(resumedAssistantMessage([], "anthropic"), undefined)
      assertEqual(resumedAssistantMessage([], "openai"), undefined)
      // Lifecycles alone are not content: an opened-and-closed empty block has
      // nothing to replay.
      assertEqual(
        resumedAssistantMessage(
          parts({ type: "text-start", id: "t" }, { type: "text-end", id: "t" }),
          "anthropic",
        ),
        undefined,
      )
    },
  ],

  [
    "text resumes as the dialect's own assistant message (issue #188)",
    () => {
      const streamed = parts(...text("t", "first "), ...text("t", "second"))
      assertEqual(resumedAssistantMessage(streamed, "openai"), {
        role: "assistant",
        content: "first second",
      })
      assertEqual(resumedAssistantMessage(streamed, "anthropic"), {
        role: "assistant",
        content: [{ type: "text", text: "first second" }],
      })
    },
  ],

  [
    "tool calls resume with their ids, names and arguments (issue #189)",
    () => {
      // The OpenAI codec streams the call's arguments as raw JSON text and the
      // final `tool-call` carries them verbatim; the Anthropic wire wants the
      // parsed object. Both keep the call's own id, which is what the tool
      // results that follow name.
      const streamed = parts(
        ...text("t", "let me look"),
        { type: "tool-input-start", id: "call_1", toolName: "read" },
        { type: "tool-input-delta", id: "call_1", delta: '{"path":"a.ts"}' },
        { type: "tool-input-end", id: "call_1" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read",
          input: '{"path":"a.ts"}',
        },
      )
      assertEqual(resumedAssistantMessage(streamed, "openai"), {
        role: "assistant",
        content: "let me look",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a.ts"}' },
          },
        ],
      })
      assertEqual(resumedAssistantMessage(streamed, "anthropic"), {
        role: "assistant",
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", id: "call_1", name: "read", input: { path: "a.ts" } },
        ],
      })
    },
  ],

  [
    "signed reasoning resumes intact, and unsigned reasoning fails loudly (issue #189)",
    () => {
      // Anthropic's signature arrives on the thinking block's `reasoning-end`
      // provider metadata, and a replayed thinking block must carry it: the
      // plugin cannot derive one, so the shape without it is refused rather
      // than silently dropped.
      const signed = parts(
        { type: "reasoning-start", id: "thinking-0" },
        { type: "reasoning-delta", id: "thinking-0", delta: "hmm" },
        {
          type: "reasoning-end",
          id: "thinking-0",
          providerMetadata: { anthropic: { signature: "sig-1" } },
        },
      )
      assertEqual(resumedAssistantMessage(signed, "anthropic"), {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm", signature: "sig-1" }],
      })
      // The OpenAI dialect has no signature field; the reasoning rides as the
      // `reasoning_content` its own codec reads back.
      assertEqual(resumedAssistantMessage(signed, "openai"), {
        role: "assistant",
        content: null,
        reasoning_content: "hmm",
      })
      const unsigned = parts(
        { type: "reasoning-start", id: "thinking-0" },
        { type: "reasoning-delta", id: "thinking-0", delta: "hmm" },
        { type: "reasoning-end", id: "thinking-0" },
      )
      throws(
        () => resumedAssistantMessage(unsigned, "anthropic"),
        /unsigned reasoning.*cannot be carried/,
      )
      // …but an unsigned reasoning block is representable on the OpenAI wire,
      // which asks for no signature.
      assertEqual(resumedAssistantMessage(unsigned, "openai"), {
        role: "assistant",
        content: null,
        reasoning_content: "hmm",
      })
    },
  ],

  [
    "a tool call the wire cannot take fails loudly (issue #189)",
    () => {
      const call = (toolCallId: string, toolName: string, input: string): unknown[] => [
        { type: "tool-call", toolCallId, toolName, input },
      ]
      // No id or name: the call's results could never line up with it.
      throws(
        () => resumedAssistantMessage(parts(...call("", "read", "{}")), "openai"),
        /without an id or name/,
      )
      throws(
        () => resumedAssistantMessage(parts(...call("call_1", "", "{}")), "openai"),
        /without an id or name/,
      )
      // Arguments that are not JSON at all.
      throws(
        () => resumedAssistantMessage(parts(...call("call_1", "read", "{nope")), "openai"),
        /arguments are not JSON/,
      )
      throws(
        () => resumedAssistantMessage(parts(...call("call_1", "read", "{nope")), "anthropic"),
        /arguments are not JSON/,
      )
      // Valid JSON that is not an object is fine for OpenAI's argument string
      // and impossible for Anthropic's `input`.
      assertEqual(resumedAssistantMessage(parts(...call("call_1", "read", '"a"')), "openai"), {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read", arguments: '"a"' } },
        ],
      })
      throws(
        () => resumedAssistantMessage(parts(...call("call_1", "read", '"a"')), "anthropic"),
        /not a JSON object/,
      )
    },
  ],

  [
    "a part the resume does not model fails loudly rather than being dropped (issues #188, #189)",
    () => {
      // The refusal is the safety net: a future codec emitting a part this
      // module does not know must not have it silently dropped from the
      // continuation.
      throws(
        () => resumedAssistantMessage(parts({ type: "source", id: "src-1" }), "openai"),
        /a source block.*cannot be carried/,
      )
    },
  ],
])
