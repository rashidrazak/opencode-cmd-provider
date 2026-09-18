# ADR-0015: The OpenAI dialect replays assistant reasoning in history

Status: accepted

## Context

The Provider API's OpenAI dialect (`POST /provider/v1/chat/completions`) serves
every non-claude model, and the reasoning models on it emit their chain of
thought as `reasoning_content` — the stream parser already reads it
(`delta.reasoning` / `delta.reasoning_content`). The request codec, however,
dropped every reasoning part from assistant history: only text and completed
tool calls went back as context. In any tool-use continuation the model was
shown its own previous turn with the thinking erased.

Upstream contracts run the other way:

- **DeepSeek V4.x** (thinking mode): when the request carries `tools`, every
  later request must replay the full prior `reasoning_content`, even for turns
  that made no tool call — the official Thinking Mode guide documents an HTTP
  400 without it. (Without tools the field is ignored, so replaying it is
  harmless.)
- **GLM-5.3**: thinking is always on, and "thinking blocks should be explicitly
  preserved and returned together with the tool results"; preserved thinking
  also improves cache hit rates. Qualification: Z.ai documents preserved
  thinking as default-on on its Coding Plan endpoint; the standard API endpoint
  defaults to stripping it unless the caller passes `clear_thinking: false`.
  Which behavior Command Code's Provider API applies server-side is not
  published; replaying the field is the conservative choice on either.
- **Qwen 3.8 Max**: preserved thinking is on by default; "include the
  assistant's `reasoning_content` when sending tool results back. Omitting it
  degrades accuracy."

The drop predated these models and matched the Anthropic dialect, where the
rule is real: a replayed `thinking` block must carry the provider's
cryptographic signature, which ordinary history parts do not carry — only the
pause-resume path has signatures (issues #189, #193, #194, ADR-0014). The same
documented rule was extended to a wire where it has no basis.

## The decision

**On the OpenAI dialect, an assistant turn's reasoning replays as
`reasoning_content` on that turn's assistant message — gated on the current
model being reasoning-capable.**

- The gate is `isReasoningModel(modelId)` — the same catalog-derived
  classification (`ADR-0006`) the `reasoning_effort` field uses. A
  non-reasoning model's request stays byte-identical to before.
- The shape matches what the pause-resume path already emits for this dialect
  (`resume.ts` `openAIMessage`): one `reasoning_content` string, segments
  joined in stream order. The wire dialect has no signature and no encrypted
  payload; nothing else is replayed.
- A reasoning-only assistant turn (think → tool call, no prose) now produces an
  assistant message with `content: null` plus its tool calls, instead of
  vanishing with its reasoning.
- The Anthropic dialect is unchanged: history still carries no thinking block,
  for the signature reason above.

The reasoning reaches history the ordinary way: the stream parser emits
`reasoning` parts, the host stores them in the assistant message, and the next
request reads them back. No prompt instructions are injected and no
provider-specific request fields are added (`preserve_thinking` is Qwen's
non-standard opt-in whose default is already "on"; it is deliberately not
sent).

## Consequences

- Tool-calling continuations on DeepSeek V4.x, GLM-5.3, and Qwen 3.8 Max carry
  the reasoning history their APIs document, instead of relying on those APIs
  tolerating its absence.
- Requests for models without reasoning capability are unchanged, so no
  unexpected field reaches a model that never emits reasoning.
- History token counts rise by the size of retained reasoning for
  reasoning-model sessions — that is the documented cost of the preserved
  thinking these vendors enable by default.
- A vendor that rejected unknown assistant fields would surface it
  immediately; the field is the one these dialects read, and vendors that
  ignore it document ignoring it (DeepSeek, no-tools case).
- `tests/provider-codecs.test.ts` pins the codec shapes (replay, gate,
  Anthropic unchanged); `tests/provider-transport.test.ts` pins the field on
  the outgoing wire through the mock server.
