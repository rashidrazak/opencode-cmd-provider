// tests/provider-retry.test.ts — the transport's retry ladder and its failure
// classification (issue #171), pinned at the LanguageModel seam.
//
// The defect: the transport did zero retries by default, and once `maxRetries`
// was switched on the ladder was positional — it replayed everything it could
// reach (400/401/403/404/422 included) while never replaying the failure the
// server itself flagged as retryable. These tests pin the causal rule instead:
//
//   - network failures, 408/429/5xx are replayed within a short budget;
//   - 400/401/403/404/422 and usage-window 429s are never replayed;
//   - a server error event is replayed only when its own rule says so
//     (flag, reported status, or default-retryable without a terminal marker);
//   - Retry-After is a wait gate, and a delay beyond the cap fails the request
//     instead of being thrown into a generic retry;
//   - headers are rebuilt per attempt, so a rotated credential is picked up.
import { createCommandCode, type CommandCodeModelOptions } from "../src/provider/index.js"
import {
  anthropicContentBlockDelta,
  anthropicMessageDelta,
  eventsEnd,
  headersToRecord,
  openAIChunk,
  openAIFinishChunk,
} from "./helpers/mock-cc.js"
import type { LanguageModelV3Prompt } from "../src/provider/aisdk-types.js"
import { assert, assertEqual, run, withEnvVars } from "./harness.js"

type Model = ReturnType<ReturnType<typeof createCommandCode>["languageModel"]>

interface SpyCall {
  url: string
  headers: Record<string, string>
}

/** Fetch spy: every attempt is recorded, and the handler decides the response. */
function spyFetch(handler: (call: SpyCall, index: number) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: SpyCall[]
} {
  const calls: SpyCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: SpyCall = {
      url: typeof input === "string" ? input : (input as URL).toString(),
      headers: headersToRecord(init?.headers),
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return { fetch: fetchImpl, calls }
}

const inferenceCalls = (calls: SpyCall[], endpoint: string): SpyCall[] =>
  calls.filter((call) => call.url.includes(endpoint))

/**
 * The provider every case starts from: the Provider API route (an explicit
 * `goat` pin, so neither env nor a plan lookup is involved), instant replays
 * (`maxRetryDelayMs: 0` — the ladder's waits are not what these cases measure),
 * a stub credential, and a base URL only the stubbed fetch ever sees. A case
 * overrides just the field it is about; `{ plan: "go" }` reaches the legacy
 * transport and `{ apiKey: undefined }` reads the credential from the
 * environment.
 */
function providerFor(fetch: typeof fetch, overrides: Partial<CommandCodeModelOptions> = {}) {
  return createCommandCode({
    apiKey: "k",
    baseURL: "https://x",
    plan: "goat",
    maxRetryDelayMs: 0,
    fetch,
    ...overrides,
  })
}

/** A closed SSE response carrying the given events. */
function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function errorResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

const openAISuccess = (): Array<Record<string, unknown>> => [openAIChunk("hi"), openAIFinishChunk()]

async function collect(model: Model): Promise<Array<Record<string, unknown>>> {
  const prompt: LanguageModelV3Prompt = [{ role: "user", content: "hi" }]
  const result = await model.doStream({ prompt, mode: { type: "regular" }, maxOutputTokens: 1000 })
  const parts: Array<Record<string, unknown>> = []
  const reader = result.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as unknown as Record<string, unknown>)
  }
  return parts
}

const errorPartOf = (parts: Array<Record<string, unknown>>): Error & { status?: number } => {
  const part = parts.find((p) => p.type === "error") as { error?: Error } | undefined
  assert(part?.error, "an error part ends the stream")
  return part.error as Error & { status?: number }
}

/** Sets/clears env vars for the duration of fn, restoring them after. */
const PROVIDER_MODEL = "gpt-5.6-terra"
const CHAT = "/provider/v1/chat/completions"

run([
  [
    "retry: a transient 503 is replayed with no configuration — the default ladder is non-zero (issue #171)",
    async () => {
      const { fetch, calls } = spyFetch((_call, index) =>
        index === 0
          ? errorResponse(503, { error: { message: "Service temporarily unavailable" } })
          : sseResponse(openAISuccess()),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 2, "503 replayed once")
      assert(
        parts.some((p) => p.type === "finish"),
        "the replay's answer reached the consumer",
      )
    },
  ],

  [
    "retry: the default budget is exactly two replays, and a spent budget surfaces the last failure",
    async () => {
      const { fetch, calls } = spyFetch(() =>
        errorResponse(503, { error: { message: "Service temporarily unavailable" } }),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 3, "three attempts at most")
      const failure = errorPartOf(parts)
      assert(failure.message.includes("Command Code API error 503"), failure.message)
    },
  ],

  [
    "retry: no fatal 4xx is ever replayed (400/401/403/404/422)",
    async () => {
      for (const status of [400, 401, 403, 404, 422]) {
        const { fetch, calls } = spyFetch(() =>
          errorResponse(status, { error: { message: `mock error ${status}` } }),
        )
        const provider = providerFor(fetch)
        const parts = await collect(provider.languageModel(PROVIDER_MODEL))
        assertEqual(inferenceCalls(calls, CHAT).length, 1, `status ${status}: exactly one request`)
        const failure = errorPartOf(parts)
        assert(failure.message.includes(`Command Code API error ${status}`), failure.message)
      }
    },
  ],

  [
    "retry: a 408 is transient and is replayed",
    async () => {
      const { fetch, calls } = spyFetch((_call, index) =>
        index === 0
          ? errorResponse(408, { error: { message: "request timeout" } })
          : sseResponse(openAISuccess()),
      )
      const provider = providerFor(fetch)
      await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 2, "408 replayed once")
    },
  ],

  [
    "retry: a usage-window 429 is never replayed, whatever Retry-After it carries",
    async () => {
      // Upstream's parseWindowLimitError: RATE_LIMITED or 429 plus a window
      // label is a plan limit, not a burst. Retrying it burns the ladder (and
      // the host's) against a window that resets on its own schedule.
      const { fetch, calls } = spyFetch(() =>
        errorResponse(
          429,
          {
            error: {
              code: "RATE_LIMITED",
              message: "You've reached your weekly usage limit for your plan. Resets Monday.",
            },
          },
          { "retry-after": "1" },
        ),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 1, "window limit: exactly one request")
      const failure = errorPartOf(parts)
      assert(failure.message.includes("Command Code API error 429"), failure.message)
      assert(failure.message.includes("weekly usage limit"), failure.message)
    },
  ],

  [
    "retry: a rejected fetch is a network failure and recovers within the budget",
    async () => {
      const { fetch, calls } = spyFetch((_call, index) => {
        if (index === 0) throw new TypeError("fetch failed")
        return sseResponse(openAISuccess())
      })
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 2, "network failure replayed")
      assert(
        parts.some((p) => p.type === "finish"),
        "the replay's answer reached the consumer",
      )
    },
  ],

  [
    "retry: a per-attempt timeout is a network failure and is replayed",
    async () => {
      const seen: string[] = []
      const hangingOnceFetch: typeof fetch = (input, init) => {
        seen.push(typeof input === "string" ? input : (input as URL).toString())
        if (seen.length === 1) {
          // Hang until the per-attempt timeout aborts this request.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            )
          })
        }
        return Promise.resolve(sseResponse(openAISuccess()))
      }
      const provider = providerFor(hangingOnceFetch, { timeout: 20 })
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(seen.length, 2, "timed-out attempt replayed")
      assert(
        parts.some((p) => p.type === "finish"),
        "the replay's answer reached the consumer",
      )
    },
  ],

  [
    "retry: a timeout that outlives the budget surfaces the timeout's own wording",
    async () => {
      const hangingFetch: typeof fetch = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          )
        })
      const provider = providerFor(hangingFetch, { timeout: 20 })
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      const failure = errorPartOf(parts)
      assertEqual(failure.message, "Command Code API request timed out after 20ms")
    },
  ],

  [
    "retry: a replay starts from a fresh parser — no part lifecycle or finish reason crosses attempts (issue #171)",
    async () => {
      // The first attempt ends on a synthesized finish (a finish_reason chunk
      // whose usage chunk never arrived) with nothing visible, so the ladder
      // replays it. The second attempt is a normal two-delta stream: the first
      // attempt's remembered finish reason must not close the text part after
      // the first delta, which would emit a second text-start/text-end pair for
      // the same id and a premature zeroed finish.
      const { fetch, calls } = spyFetch((_call, index) =>
        index === 0
          ? sseResponse([{ id: "chatcmpl-test", choices: [{ delta: {}, finish_reason: "stop" }] }])
          : sseResponse([openAIChunk("one"), openAIChunk("two"), openAIFinishChunk()]),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 2, "usage-less finish replayed")
      assertEqual(
        parts.map((p) => p.type),
        ["text-start", "text-delta", "text-delta", "text-end", "finish"],
        "one part lifecycle, one finish",
      )
      const deltas = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta: string }).delta)
      assertEqual(deltas, ["one", "two"])
    },
  ],

  [
    "retry: an Anthropic replay builds its parts from its own stream (issue #171)",
    async () => {
      // The first attempt ends on a bare `message_stop` — a synthesized finish
      // with nothing visible, so it is replayed. The replay's own block
      // lifecycle and `message_delta` usage must come through untouched; the
      // codec's per-stream state is rebuilt per attempt like the OpenAI
      // parser's remembered finish reason (pinned above).
      const { fetch, calls } = spyFetch((_call, index) =>
        index === 0
          ? sseResponse([{ type: "message_stop" }])
          : sseResponse([
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              anthropicContentBlockDelta("hi"),
              { type: "content_block_stop", index: 0 },
              anthropicMessageDelta({ input_tokens: 10, output_tokens: 4 }),
            ]),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel("claude-sonnet-5"))
      assertEqual(inferenceCalls(calls, "/provider/v1/messages").length, 2, "replayed")
      assertEqual(
        parts.map((p) => p.type),
        ["text-start", "text-delta", "text-end", "finish"],
      )
      const finish = parts[3] as { usage: { outputTokens: { total: number } } }
      assertEqual(finish.usage.outputTokens.total, 4, "the replay's usage survived")
    },
  ],

  [
    "retry: a body that dies after a usage-bearing finish completes the turn instead of discarding it (issue #171)",
    async () => {
      // The evidence table's "read error after the finish part" row: the
      // terminal already declared the turn complete with its usage report, so
      // the socket reset that follows cannot change the answer — the held
      // finish is emitted and the stream ends cleanly, no error part, no
      // replay.
      const dyingAfterFinish = (events: Array<Record<string, unknown>>): Response => {
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              }
            },
            pull(controller) {
              controller.error(new Error("socket reset"))
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      }
      // Provider API (OpenAI shape)
      {
        const { fetch, calls } = spyFetch(() =>
          dyingAfterFinish([openAIChunk("answer"), openAIFinishChunk()]),
        )
        const provider = providerFor(fetch)
        const parts = await collect(provider.languageModel(PROVIDER_MODEL))
        assertEqual(inferenceCalls(calls, CHAT).length, 1, "no replay after a settled turn")
        assertEqual(
          parts.map((p) => p.type),
          ["text-start", "text-delta", "text-end", "finish"],
        )
        const finish = parts[3] as { usage: { inputTokens: { total: number } } }
        assertEqual(finish.usage.inputTokens.total, 10, "the reported usage survived")
      }
      // Legacy /alpha/generate (CC shape)
      {
        const { fetch, calls } = spyFetch(() =>
          dyingAfterFinish([
            { type: "text-delta", text: "answer" },
            {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 7, outputTokens: 3 },
            },
          ]),
        )
        const provider = providerFor(fetch, { plan: "go" })
        const parts = await collect(provider.languageModel("claude-sonnet-5"))
        assertEqual(inferenceCalls(calls, "/alpha/generate").length, 1, "no replay")
        assertEqual(
          parts.map((p) => p.type),
          ["text-delta", "finish"],
        )
      }
    },
  ],

  [
    "retry: a body that dies after a finish-less terminal still ends the turn cleanly",
    async () => {
      // The legacy `{"type":"abort"}` terminal ends the read, so the dying body
      // is never read — the turn completes with the parts the server closed and
      // no invented finish (issue #170).
      const encoder = new TextEncoder()
      const { fetch, calls } = spyFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "text-delta", text: "half" })}\n\n`,
                  ),
                )
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "abort" })}\n\n`))
              },
              pull(controller) {
                controller.error(new Error("socket reset"))
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      )
      const provider = providerFor(fetch, { plan: "go" })
      const parts = await collect(provider.languageModel("claude-sonnet-5"))
      assertEqual(inferenceCalls(calls, "/alpha/generate").length, 1, "no replay")
      assertEqual(
        parts.map((p) => p.type),
        ["text-delta"],
      )
    },
  ],

  [
    "retry: a read failure with nothing visible is replayed; after visible content it is not (issue #170)",
    async () => {
      // Nothing visible yet: the body dies, the replay replaces it.
      {
        const { fetch, calls } = spyFetch((_call, index) => {
          if (index === 0) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error("socket reset"))
                },
              }),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            )
          }
          return sseResponse(openAISuccess())
        })
        const provider = providerFor(fetch)
        const parts = await collect(provider.languageModel(PROVIDER_MODEL))
        assertEqual(inferenceCalls(calls, CHAT).length, 2, "read failure replayed")
        assert(
          parts.some((p) => p.type === "finish"),
          "the replay's answer reached the consumer",
        )
      }
      // Visible content: a replay would duplicate what the consumer saw.
      {
        const { fetch, calls } = spyFetch(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(openAIChunk("FIRST"))}\n\n`),
                  )
                },
                pull(controller) {
                  controller.error(new Error("socket reset"))
                },
              }),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            ),
        )
        const provider = providerFor(fetch)
        const parts = await collect(provider.languageModel(PROVIDER_MODEL))
        assertEqual(inferenceCalls(calls, CHAT).length, 1, "no replay once content is visible")
        assertEqual(
          parts.filter((p) => p.type === "text-delta").length,
          1,
          "the visible text is not duplicated",
        )
      }
    },
  ],

  [
    "retry: a server error event that flags itself retryable enters the ladder (issue #171 evidence)",
    async () => {
      // The live probe's exact shape: a 200 SSE body whose first event is the
      // gateway's own failure, flagged retryable. Before the fix it was mapped
      // straight to an error part and never replayed at any maxRetries.
      const probeEvent = {
        type: "error",
        error: {
          type: "server_error",
          message: "Invalid error response format: Gateway request failed",
          statusCode: 520,
          isRetryable: true,
        },
      }
      const { fetch, calls } = spyFetch((_call, index) =>
        index === 0 ? sseResponse([probeEvent]) : sseResponse(openAISuccess()),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 2, "flagged error event replayed")
      assert(
        parts.some((p) => p.type === "finish"),
        "the replay's answer reached the consumer",
      )
      assert(!parts.some((p) => p.type === "error"), "no error part for a recovered turn")
    },
  ],

  [
    "retry: a server error event with a terminal marker is never replayed",
    async () => {
      for (const marker of [
        "premium_credits_exhausted",
        "model_not_in_plan",
        "insufficient credits",
      ]) {
        const { fetch, calls } = spyFetch(() =>
          sseResponse([
            { type: "error", error: { type: "invalid_request_error", message: marker } },
          ]),
        )
        const provider = providerFor(fetch)
        const parts = await collect(provider.languageModel(PROVIDER_MODEL))
        assertEqual(inferenceCalls(calls, CHAT).length, 1, `${marker}: exactly one request`)
        assert(errorPartOf(parts).message.includes(marker), `${marker} surfaced`)
      }
    },
  ],

  [
    "retry: a server error event reporting a fatal status is not replayed",
    async () => {
      // A reported status outranks the default-retryable rule (upstream's
      // isStreamErrorRetryable): an event that says 400 describes a permanent
      // request problem, not a blip.
      const { fetch, calls } = spyFetch(() =>
        sseResponse([
          {
            type: "error",
            error: { type: "invalid_request_error", message: "bad tool schema", statusCode: 400 },
          },
        ]),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 1, "reported fatal status: one request")
      assert(errorPartOf(parts).message.includes("bad tool schema"), "message surfaced")
    },
  ],

  [
    "retry: Retry-After above the cap fails the request instead of being replayed blindly",
    async () => {
      const { fetch, calls } = spyFetch(() =>
        errorResponse(
          503,
          { error: { message: "Service temporarily unavailable" } },
          { "retry-after": "120" },
        ),
      )
      const provider = providerFor(fetch, { maxRetryDelayMs: 1000 })
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 1, "no blind replay of a capped delay")
      const failure = errorPartOf(parts)
      assert(failure.message.includes("Retry-After delay exceeds max retry delay"), failure.message)
    },
  ],

  [
    "retry: an honoured Retry-After is the attempt's wait, not the ladder's backoff",
    async () => {
      // A fractional header keeps the test fast while staying observable: the
      // 50 ms wait is below the ladder's 1 s first backoff, so an elapsed time
      // under it proves the header's own delay was used.
      const { fetch, calls } = spyFetch((_call, index) =>
        index === 0
          ? errorResponse(429, { error: { message: "rate limited" } }, { "retry-after": "0.05" })
          : sseResponse(openAISuccess()),
      )
      const provider = providerFor(fetch, { maxRetryDelayMs: 1000 })
      const started = Date.now()
      await collect(provider.languageModel(PROVIDER_MODEL))
      const elapsed = Date.now() - started
      assertEqual(inferenceCalls(calls, CHAT).length, 2, "429 replayed")
      assert(elapsed >= 40, `waited for the header (${elapsed}ms)`)
      assert(elapsed < 900, `used the header's wait, not the 1s backoff (${elapsed}ms)`)
    },
  ],

  [
    "retry: request headers are rebuilt for every attempt, so a rotated credential is picked up",
    async () => {
      // Deliberately not key-shaped values: the subject is which credential the
      // attempt read, not what credential material looks like (the secretlint
      // gate scans the tree for Command Code key shapes).
      await withEnvVars({ COMMANDCODE_API_KEY: "attempt-one-credential" }, async () => {
        const { fetch, calls } = spyFetch((_call, index) => {
          if (index === 0) {
            // Rotated between attempts: the replay must read it back.
            process.env.COMMANDCODE_API_KEY = "attempt-two-credential"
            return errorResponse(503, { error: { message: "Service temporarily unavailable" } })
          }
          return sseResponse(openAISuccess())
        })
        // No apiKey option: the credential comes from the environment, which is
        // exactly what can change under a running session.
        const provider = providerFor(fetch, { apiKey: undefined })
        await collect(provider.languageModel(PROVIDER_MODEL))
        const inference = inferenceCalls(calls, CHAT)
        assertEqual(inference.length, 2, "503 replayed once")
        assertEqual(inference[0]!.headers["authorization"], "Bearer attempt-one-credential")
        assertEqual(
          inference[1]!.headers["authorization"],
          "Bearer attempt-two-credential",
          "the replay carried the rotated credential",
        )
      })
    },
  ],

  [
    "retry: an OpenAI finish without its usage chunk is replayed while nothing is visible (issue #171)",
    async () => {
      // The finish_reason chunk arrived, the trailing usage-only chunk never
      // did. Nothing visible was emitted, so the replay is safe — and the
      // answer that follows carries a real usage report.
      const { fetch, calls } = spyFetch((_call, index) =>
        index === 0
          ? sseResponse([{ id: "chatcmpl-test", choices: [{ delta: {}, finish_reason: "stop" }] }])
          : sseResponse(openAISuccess()),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(inferenceCalls(calls, CHAT).length, 2, "usage-less finish replayed")
      const finish = parts.find((p) => p.type === "finish") as
        { usage: { inputTokens: { total: number } } } | undefined
      assert(finish, "the replay reported a finish")
      assert((finish.usage.inputTokens.total ?? 0) > 0, "with the provider's usage, not zeros")
    },
  ],

  [
    "retry: an Anthropic terminal that never reports usage fails the turn instead of zeroing it (issue #171)",
    async () => {
      // No message_delta ever arrived, only the bare message_stop: the wire
      // never reported the turn's usage, so the synthesized finish must not be
      // surfaced as a complete, zero-cost answer.
      const { fetch } = spyFetch(() =>
        sseResponse([
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          anthropicContentBlockDelta("partial"),
          { type: "message_stop" },
        ]),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel("claude-sonnet-5"))
      assertEqual(
        parts.map((p) => p.type),
        ["text-start", "text-delta", "text-end", "error"],
      )
      const failure = errorPartOf(parts)
      assertEqual(failure.name, "MissingUsageError")
      assertEqual(failure.status, 502)
    },
  ],

  [
    "retry: a usage-bearing Anthropic message_delta is still emitted after the body ends (issue #171)",
    async () => {
      const { fetch } = spyFetch(() =>
        sseResponse([
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          anthropicContentBlockDelta("hi"),
          { type: "content_block_stop", index: 0 },
          anthropicMessageDelta({ input_tokens: 10, output_tokens: 4 }),
        ]),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel("claude-sonnet-5"))
      assertEqual(
        parts.map((p) => p.type),
        ["text-start", "text-delta", "text-end", "finish"],
      )
    },
  ],

  [
    "retry: the legacy /alpha/generate transport classifies the same way",
    async () => {
      // A window-limit 429 is fatal on the legacy endpoint too.
      {
        const { fetch, calls } = spyFetch(() =>
          errorResponse(
            429,
            { error: { message: "You've reached your weekly usage limit for your plan" } },
            { "retry-after": "1" },
          ),
        )
        const provider = providerFor(fetch, { plan: "go" })
        const parts = await collect(provider.languageModel("claude-sonnet-5"))
        assertEqual(inferenceCalls(calls, "/alpha/generate").length, 1, "window limit: one request")
        assert(errorPartOf(parts).message.includes("weekly usage limit"), "message surfaced")
      }
      // A transient 503 is replayed, and the flagged legacy error event too.
      {
        const { fetch, calls } = spyFetch((_call, index) =>
          index === 0
            ? errorResponse(503, { error: { message: "Service temporarily unavailable" } })
            : sseResponse([
                { type: "text-delta", text: "recovered" },
                {
                  type: "finish",
                  finishReason: "stop",
                  totalUsage: { inputTokens: 3, outputTokens: 2 },
                },
              ]),
        )
        const provider = providerFor(fetch, { plan: "go" })
        const parts = await collect(provider.languageModel("claude-sonnet-5"))
        assertEqual(inferenceCalls(calls, "/alpha/generate").length, 2, "503 replayed")
        assert(
          parts.some((p) => p.type === "finish"),
          "legacy finish surfaced",
        )
      }
      {
        const { fetch, calls } = spyFetch((_call, index) =>
          index === 0
            ? sseResponse([
                {
                  type: "error",
                  error: { message: "gateway failed", statusCode: 520, isRetryable: true },
                },
                eventsEnd,
              ])
            : sseResponse([
                { type: "text-delta", text: "recovered" },
                {
                  type: "finish",
                  finishReason: "stop",
                  totalUsage: { inputTokens: 3, outputTokens: 2 },
                },
              ]),
        )
        const provider = providerFor(fetch, { plan: "go" })
        await collect(provider.languageModel("claude-sonnet-5"))
        assertEqual(
          inferenceCalls(calls, "/alpha/generate").length,
          2,
          "flagged legacy error event replayed",
        )
      }
      // A fatal 4xx is not replayed.
      {
        const { fetch, calls } = spyFetch(() =>
          errorResponse(401, { error: { message: "unauthorized" } }),
        )
        const provider = providerFor(fetch, { plan: "go" })
        await collect(provider.languageModel("claude-sonnet-5"))
        assertEqual(inferenceCalls(calls, "/alpha/generate").length, 1, "401 not replayed")
      }
    },
  ],
])
