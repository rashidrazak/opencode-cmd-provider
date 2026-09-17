# ADR-0014: A resumed turn never silently drops a block the stream did not model

Status: accepted

A Provider API turn the provider pauses (`pause_turn`) is continued by re-sending
the request with the paused assistant turn appended. That append is built from the
stream parts the response emitted — the only record of what the turn has produced
so far. The Anthropic parser has always dropped content-block types it does not
model — a decision recorded in the parser's own comments and in
`docs/TECHNICAL.md`
([#72](https://github.com/rashidrazak/opencode-cmd-provider/issues/72)): a block
it cannot name opens no part, so its stop closes none. That is invisible for a
turn that ends, and a lie for a turn that continues: the continuation would
present the model with a turn in which its own block never happened.

## The decision

**A pause whose response carried content the stream never turned into a part is
refused, not continued.** The Anthropic parser reports the block types it did not
model (`StreamEventParser.unmodelledBlocks`), and the transport fails the turn
before sending the continuation — a `resume-unsupported` failure naming the
types, never replayed, because the same request would hand back the same block.

There are exactly two ways for a block to stop being a hazard, and both are
deliberate:

- **Model it**, so it appears in the continuation like every other part.
  Anthropic's `redacted_thinking` — reasoning the provider's safety system
  encrypted — is the reachable case and is modelled (issues #193, #194): it
  streams as a reasoning part with its payload in
  `providerMetadata.anthropic.redactedData` (the shape the AI SDK's own Anthropic
  provider emits) and is replayed verbatim, because the payload cannot be
  re-derived.
- **Leave it unmodelled** and let the refusal catch a pause that carried it.

A turn that _ends_ with an unmodelled block is unchanged: no part, no failure —
exactly the #72 contract. This rule governs continuations, not the stream, and it
is the same promise #188 and #189 make one level up: a resume must never silently
drop part of a turn it cannot represent faithfully.

## Deferred: provider-executed (server tool) blocks

`server_tool_use`, `server_tool_result` and `compaction` are not modelled. The
plugin never asks for a server tool — the `tools` it sends are the host's own
function tools — so the Provider API cannot emit one today, while modelling them
means a provider-executed tool lifecycle end to end (parts, ordering, host
rendering) for a shape no request can currently produce. The refusal covers the
interim loudly rather than pretending.

**Trigger to revisit:** any request this plugin sends that can produce a server
tool block, or a report of one arriving on the wire. The same applies to the
OpenAI dialect's legacy `delta.function_call` spelling, which the OpenAI codec
does not read (it handles `tool_calls` only) and which has not been observed on
this wire.

## Consequences

- "A resume must never silently drop part of a turn" holds for every block type,
  including ones this build has never seen: they fail loudly instead.
- The failure is user-visible on a paused turn that carried such a block. That is
  the intended trade — a resume that quietly loses the model's content is worse
  than a turn that fails and can be retried.
- Adding a block type to the stream is now the _only_ way to make it resumable,
  so the parser's block vocabulary and the resume's block vocabulary stay in
  step by construction: `tests/stream.test.ts` pins what the parser reports as
  unmodelled, and `tests/provider-transport.test.ts` pins that a pause carrying
  one is refused.
