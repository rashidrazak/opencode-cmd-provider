# ADR-0018: A usage report is not by itself a terminal on the OpenAI dialect

Status: accepted

The OpenAI dialect (`POST /provider/v1/chat/completions`, every non-`claude-*`
model) reports usage on the terminal chunk. The parser treated **any** chunk
carrying a `usage` object as that terminal: it closed the open reasoning and
text parts, flushed tool calls, and emitted a `finish` part. That is correct for
the dialect as OpenAI documents it — usage rides on a `finish_reason` chunk, or
on a trailing usage-only chunk with `choices: []` — but it is wrong for a
provider that reports usage on **every** chunk.

Command Code's GLM-5.3 does exactly that: its Z.ai upstream attaches a
cumulative `usage` object to each SSE event (live capture, 2026-09-19 — 12
chunks, usage on all 12, `finish_reason` only on the last). Each token closed
the part it belonged to and reopened a new one, so one turn arrived as hundreds
of one-token reasoning/text parts. The Host renders each part on its own line —
the reported symptom is an answer "one word per line" — and stores one part per
token. The model's content and its finish were correct; only the part boundaries
were.

## The decision

**A `usage` report ends the turn only on a chunk that carries no choices.** A
chunk with choices ends the turn only through a `finish_reason`, which the
parser's sticky `lastFinishReason` keeps for a trailing usage-only chunk. Usage
on a content-bearing chunk is read as what it is on this wire — a running
report — and changes nothing about the open parts.

The two OpenAI terminal shapes are unchanged:

- `finish_reason` on a content chunk (with or without usage) — terminal;
- a trailing usage-only chunk (`choices: []`, or no `choices`) — terminal, and
  it replaces the held finish with the usage-bearing one (`lastFinishReason`
  keeps the real reason, issue #171).

The practical difference is the failure mode for a stream that never sends a
`finish_reason` at all: it is now a truncation (`TruncatedStreamError`,
retryable while nothing is visible), not a completed turn synthesized off the
first usage report. That is the contract the legacy finish guards already state
(issue #187): a turn ends when the wire says it ended. No observed provider
relies on usage-as-terminal; OpenAI and Command Code both send `finish_reason`.

## Consequences

- One part lifecycle per block, whatever the provider's usage cadence: the Host
  sees one reasoning part and one text part for a GLM-5.3 turn, as it does for
  GLM-5.3 Flash (whose stream carries usage only on the terminal chunk).
- Tool calls on the same wire were corrupted the same way: the per-chunk
  terminal flushed and deleted the half-built call at every chunk, so the
  consumer received a `tool-call` per fragment with truncated arguments. The
  call now completes once, when its accumulated arguments parse, or fails the
  turn with the rest of it — `tests/stream.test.ts` pins both the tool-call
  lifecycle and the reasoning one.
- Cost reporting is unchanged: the terminal chunk that ends a GLM-5.3 turn
  carries usage itself, and `MissingUsageError` still fails a finish synthesized
  from a `finish_reason` whose usage never arrived (issue #171).
- A mid-stream read failure on a per-chunk-usage stream no longer "settles" the
  turn at the first chunk: the accepted-terminal shortcut (issue #171) now
  applies only after the wire declared an ending, exactly as it does for every
  standard OpenAI stream.
- `tests/stream.test.ts` pins the parser's part sequence on a per-chunk-usage
  stream, and `tests/provider-transport.test.ts` pins the same shape end to end
  through the transport (one `reasoning-start`/`reasoning-end`, deltas joined,
  terminal usage honored). The split-terminal test (#171) pins the preserved
  OpenAI shape.
