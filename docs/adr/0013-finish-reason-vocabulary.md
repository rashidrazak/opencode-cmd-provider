# ADR-0013: A turn that ended is never reported with `unified: "other"`

Status: accepted

OpenCode v2's generic AI-SDK adapter normalises a stream's finish reason before
anything downstream sees it:

```js
function jn(e) {
  return e.unified === "other" ? "unknown" : e.unified
}
```

The session then treats a step whose finish is `unknown` as an
`incomplete-stream` failure and retries the turn — _"The provider response ended
with an unknown finish reason."_ OpenCode v1 completes the same turn quietly, so
the failure only ever appeared on v2 (reported on plugin 2.1.0 + OpenCode 2.0.x,
issue #184). The plugin's contract with the Host is therefore: **a finish part
for a turn that ended carries a unified reason other than `other`.**

## The decision

`mapFinishReason` (`src/provider/stream.ts`) matches the reason the wire sent
against the vocabulary the wire can actually produce, case-insensitively the way
upstream `command-code@1.54.1` normalises (its `normalizeStopReason` /
`normalizeStopReason2` lowercase the reason first):

- tool spellings → `tool-calls`: `tool_use`, `tool_calls`, `tool-calls`,
  `function_call` (OpenAI's older spelling of the same thing);
- the length family → `length`: `length`, `max_tokens`, `max_output_tokens`,
  `model_context_window_exceeded`;
- `error` → `error`, the unified reason the transport already uses for provider
  failures;
- **everything else → `stop`**: a completed turn.

The last rule is the decision. Upstream's normaliser maps every reason it does
not recognise to `end_turn` and never fails a turn on an unknown reason, so the
plugin follows it: a reason from a legacy/provider variant (`max_turn_requests`,
`cancelled`), a future Anthropic addition, a proxy rewrite, or a misspelt
variant completes the turn instead of failing it on v2. `unified: "other"` is
unreachable from the vocabulary — a stream can only fail to end by never
producing a finish part, which is the truncation case the legacy finish guards
own (#187), never by ending `other`.

## Why `refusal` / `content_filter` complete the turn

The AI SDK has a `content-filter` unified reason, and v2's own Anthropic route
maps Anthropic's `refusal` to it. The plugin does not: `refusal` and
`content_filter` (in either spelling) are **completed turns**, because the
plugin's contract is CLI parity — upstream's normaliser completes them, and the
model's refusal text is the answer the user is meant to read — while v2's own
route is a statement about v2's provider, not about this one. Labelling a
refusal `content-filter` would ask the Host to treat as blocked a turn the CLI
presents as finished. Nothing is lost by the choice: the refusal text still
reaches the Host as ordinary content, and the reason stays visible in the
finish part's `raw` field.

## Consequences

- A turn that ends any way the wire can express completes on both hosts.
- `pause_turn` maps to a completed turn like every other reason the vocabulary
  does not know; the transport intercepts it by the **raw** reason before any
  finish is emitted (issue #172), so this change is invisible to the pause loop.
- `doGenerate`'s no-finish-part default became `{ unified: "stop", raw:
"unknown" }`: it describes a completed generation (a stream ended by the
  legacy `abort` terminal), so it must not report `other` either.
- `tests/stream.test.ts` holds the vocabulary table (both dialects, mixed
  casing, the legacy variants) and an invariant test that no stream the
  Anthropic, OpenAI-shaped or legacy codec can produce ends with a finish part
  whose unified reason is `other`. That invariant test is the CI stand-in for a
  live v2 stream leg, which `npm run test:e2e:v2` cannot provide while
  `opencode run` hangs upstream (see `AGENTS.md`).
