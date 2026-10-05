# ADR-0023: HTTP failures surface as AI SDK `APICallError`s

Status: accepted

OpenCode v2's generic AI-SDK adapter classifies a provider failure from the
surfaced error object. Only `APICallError` instances get the HTTP facts passed
to its classifier — every other error becomes an unknown provider failure:

```js
function toFailure(error) {
  if (APICallError.isInstance(error))
    return classify({ status: error.statusCode, body: error.responseBody, message: error.message })
  return unknownProviderError(error) // retryable
}
```

The consequences on v2 (issue #273, observed in #267):

- a fatal 400/401/403/422 is filed as an unknown failure and retried by the
  host's ladder (~84 s before the session shows anything);
- context-overflow recovery never fires: compaction requires the failure to
  classify as `InvalidRequest` + `context-overflow`, which is computed from the
  status and the body; and
- the plugin's own ladder is correct — it never replays a fatal 4xx — but the
  host cannot see why.

OpenCode v1 reads the same fields: `ProviderError.parseAPICallError` turns an
`APICallError` into the session `APIError` (`statusCode`, `responseBody`,
`isRetryable`, `responseHeaders`, `url`) and `SessionRetry.retryable` gates on
`isRetryable`, a status ≥ 500, and the message/body text. A plain error becomes
`NamedError.Unknown`, judged on its message alone.

## The decision

Every error the transport raises **from an HTTP response** is surfaced as an AI
SDK `APICallError`:

- `HttpTransportFailureError` (`src/provider/retry.ts`) extends `APICallError`
  and keeps the transport's own markers: `transportError`, `failure`, `status`.
  The ladder reads `failure` before anything is surfaced, so which failures are
  replayed here does not change; `isRetryable` restates that decision for the
  host.
- The response facts ride along: `statusCode`, the request `url`,
  `responseHeaders`, and `responseBody` — the full body after
  `redactCommandCodeErrorText`, because the host classifier scans it and the
  message's 500-char plain-text bound could truncate a late overflow pattern.
  Dropping the redaction is a security regression, not a simplification; the
  message itself keeps its existing wording and bound.
- `requestBodyValues` is `{}`: no classifier reads it, and the request body can
  be hundreds of thousands of tokens.
- This covers every throw raised from a non-OK response: the classified HTTP
  failure, the version-gate 403 (whose rebuilt message is unchanged), and the
  plan-gate flip signal (`UpgradeRequiredError` — host-classifiable for the
  pathological case where it surfaces after visible content).

Failures that are **not** an HTTP response — fetch rejections, per-attempt
timeouts, truncation, mid-stream server `error` events, the pause/resume bounds
— stay plain `TransportFailureError`s / codec errors. Their `status` numbers
are the transport's own vocabulary, not response facts, and giving them the
`APICallError` shape would make v1 retry truncations it currently leaves alone
(v1 replaying a turn has no partial-output guard here).

## Consequences

- v2 classifies a fatal 4xx as a deterministic rejection and 429/5xx per the
  existing status classification. v1's policy reads the same fields, and its
  `isRetryable`/status gates are unchanged for the fatal set; v1 additionally
  scans the offered body with its own broad retryable-text heuristic
  (`/429|500|502|503|504|524/`, "rate limit", …) — a heuristic that already
  scanned the message, which embeds the extracted body detail. The body is
  offered because overflow recovery needs it; a body that reads retryable can
  still be retried by v1's own policy, and that remains v1's call.
- An overflow body (`context_length_exceeded` or the `isContextOverflow`
  patterns) reaches both hosts' recovery paths: v1's `ContextOverflowError`,
  v2's compact-and-retry.
- The surfaced message text and redaction are unchanged; the error only gains
  the host-readable fields.
- `tests/provider-http-failure.test.ts` pins the host-visible contract
  (status, url, headers, redacted body, `isRetryable`) and that the internal
  `failure` classification still rides on the instance.
