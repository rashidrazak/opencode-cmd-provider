// tests/provider-http-failure.test.ts — issue #273: HTTP failures surface as
// AI SDK `APICallError`s.
//
// OpenCode v2 classifies a provider failure from the surfaced error's
// `statusCode` / `responseBody` / `isRetryable` (its `Cl`/`ti` classifier).
// A plain Error reaches it as an unknown shape, which its retry policy treats
// as retryable — fatal 4xx included, ~10 host retries before the session shows
// anything — and a context-overflow body can never trigger compaction. OpenCode
// v1 reads the same fields (`ProviderError.parseAPICallError` →
// `SessionRetry.retryable`, which gates on `isRetryable`, status ≥ 500, and
// message/body patterns), so the surfaced shape is pinned here while the
// plugin's own ladder keeps classifying from `.failure` before the host sees
// anything:
//
//   - a fatal 4xx surfaces an APICallError with status, url, headers, the
//     redacted body, and `isRetryable: false`, and the ladder never replays it;
//   - a 5xx that outlives the ladder surfaces `isRetryable: true`;
//   - an overflow body survives redaction and the status stays 4xx, so the
//     host's compact-and-retry can classify it;
//   - a usage-window 429 stays fatal for the ladder and surfaces
//     `isRetryable: false` even though its status is retryable-looking;
//   - a version-gate 403 carries the same response facts;
//   - the internal `transportError` / `failure` markers stay on the instance.
import { APICallError } from "@ai-sdk/provider"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCommandCode, type CommandCodeModelOptions } from "../src/provider/index.js"
import { headersToRecord, versionGateBody } from "./helpers/mock-cc.js"
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

/**
 * The provider every case starts from: the Provider API route (explicit `goat`
 * pin), instant replays, a stub credential, and a base URL only the stubbed
 * fetch sees. A case overrides just the field it is about.
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

const PROVIDER_MODEL = "gpt-5.6-terra"

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

/** The surfaced error: the AI SDK facts the hosts classify from plus the
 * transport's own markers. */
type SurfacedError = APICallError & {
  transportError?: boolean
  status?: number
  failure?: { kind: string; retryable: boolean }
}

function surfacedErrorOf(parts: Array<Record<string, unknown>>): SurfacedError {
  const part = parts.find((p) => p.type === "error") as { error?: Error } | undefined
  assert(part?.error, "an error part ends the stream")
  return part.error as SurfacedError
}

run([
  [
    "http: a fatal 400 surfaces an APICallError with status, url, headers, redacted body — and the ladder never replays it (issue #273)",
    async () => {
      const { fetch, calls } = spyFetch(() =>
        errorResponse(
          400,
          {
            error: {
              code: "invalid_request_error",
              message: "invalid request error trace_id: 65a715e992e7b714bfc7eae1f34e978a",
            },
          },
          { "x-request-id": "req-1" },
        ),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(calls.length, 1, "a fatal 400 is not replayed")
      const error = surfacedErrorOf(parts)
      // The host-visible shape: v2 classifies HTTP status 400 as a
      // deterministic InvalidRequest (not retryable); v1's SessionRetry sees
      // `isRetryable: false` with no ≥500 status and no retryable message.
      assert(APICallError.isInstance(error), "surfaced as an AI SDK APICallError")
      assertEqual(error.statusCode, 400)
      assertEqual(error.isRetryable, false)
      assertEqual(error.url, "https://x/provider/v1/chat/completions")
      assertEqual(error.responseHeaders?.["x-request-id"], "req-1")
      assert(
        error.responseBody?.includes("invalid request error trace_id"),
        `response body surfaced: ${error.responseBody}`,
      )
      assert(error.message.includes("Command Code API error 400"), error.message)
      assert(
        error.message.includes("(POST https://x/provider/v1/chat/completions)"),
        `message names the request URL (issue #326): ${error.message}`,
      )
      assert(
        !error.message.includes("credential:"),
        `a non-auth failure names no credential (issue #327): ${error.message}`,
      )
      assert(
        error.message.includes("invalid request error trace_id"),
        `message unchanged in wording: ${error.message}`,
      )
      // The ladder's own classification still rides on the instance.
      assertEqual(error.transportError, true)
      assertEqual(error.status, 400)
      assertEqual(error.failure?.kind, "fatal-status")
      assertEqual(error.failure?.retryable, false)
    },
  ],

  [
    "http: a 503 that outlives the ladder surfaces retryable — the last failure carries the classification",
    async () => {
      const { fetch, calls } = spyFetch(() =>
        errorResponse(503, { error: { message: "Service temporarily unavailable" } }),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(calls.length, 3, "the ladder spent its two replays first")
      const error = surfacedErrorOf(parts)
      assert(APICallError.isInstance(error))
      assertEqual(error.statusCode, 503)
      assertEqual(error.isRetryable, true)
      assertEqual(error.failure?.kind, "retryable-status")
      assertEqual(error.failure?.retryable, true)
    },
  ],

  [
    "http: an overflow body survives as status 4xx — the host's compact-and-retry reads exactly those inputs, even past the message's 500-char bound",
    async () => {
      // The overflow code sits past the message's 500-char plain-text bound:
      // `responseBody` must carry the whole redacted body, or a late
      // `context_length_exceeded` would never reach the host classifier.
      const padding = "x".repeat(600)
      const { fetch, calls } = spyFetch(() =>
        errorResponse(400, {
          error: {
            message: `This model's maximum context length is 200000 tokens. ${padding}`,
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        }),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(calls.length, 1, "an overflow body is not blind-retried")
      const error = surfacedErrorOf(parts)
      assert(APICallError.isInstance(error))
      assertEqual(error.statusCode, 400)
      assertEqual(error.isRetryable, false)
      assert(
        error.responseBody?.includes("context_length_exceeded"),
        `the overflow code must reach the classifier: ${error.responseBody}`,
      )
      assert(
        (error.responseBody?.length ?? 0) > 500,
        `the classified body is not truncated to the message bound: ${error.responseBody?.length}`,
      )
      assert(
        error.message.includes("context_length_exceeded"),
        `the overflow code must be in the message too: ${error.message}`,
      )
    },
  ],

  [
    "http: a usage-window 429 stays fatal for the ladder and surfaces isRetryable: false",
    async () => {
      const { fetch, calls } = spyFetch(() =>
        errorResponse(429, {
          error: {
            code: "RATE_LIMITED",
            message: "You've reached your weekly usage limit for your plan. Resets Monday.",
          },
        }),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      assertEqual(calls.length, 1, "a plan window limit is never a burst retry")
      const error = surfacedErrorOf(parts)
      assert(APICallError.isInstance(error))
      assertEqual(error.statusCode, 429)
      assertEqual(error.isRetryable, false)
      assertEqual(error.failure?.kind, "window-limit")
    },
  ],

  [
    "http: the surfaced message and body stay redacted",
    async () => {
      const secret = "user_abcdefgh1234"
      const { fetch } = spyFetch(() =>
        errorResponse(401, {
          error: { code: "invalid_api_key", message: `Incorrect API key provided: ${secret}.` },
        }),
      )
      const provider = providerFor(fetch)
      const parts = await collect(provider.languageModel(PROVIDER_MODEL))
      const error = surfacedErrorOf(parts)
      assert(!error.message.includes(secret), `message leaked the secret: ${error.message}`)
      assert(error.message.includes("[redacted]"), `message not redacted: ${error.message}`)
      assert(
        !error.responseBody?.includes(secret),
        `response body leaked the secret: ${error.responseBody}`,
      )
      assert(
        error.responseBody?.includes("[redacted]"),
        `response body not redacted: ${error.responseBody}`,
      )
    },
  ],

  [
    "http: a version-gate 403 carries the same response facts",
    async () => {
      const { fetch, calls } = spyFetch(() =>
        errorResponse(403, versionGateBody(), { "x-request-id": "vg-1" }),
      )
      const provider = providerFor(fetch, { plan: "go" })
      const parts = await collect(provider.languageModel("claude-sonnet-5"))
      assertEqual(calls.length, 1, "a version gate is permanent for this build")
      const error = surfacedErrorOf(parts)
      assert(APICallError.isInstance(error), "version gate surfaces as an APICallError")
      assertEqual(error.statusCode, 403)
      assertEqual(error.isRetryable, false)
      assertEqual(error.url, "https://x/alpha/generate")
      assertEqual(error.responseHeaders?.["x-request-id"], "vg-1")
      assert(
        error.responseBody?.includes("out of date"),
        `upstream body surfaced: ${error.responseBody}`,
      )
      assert(error.message.includes("opencode-cmd-provider"), error.message)
      assertEqual(error.failure?.kind, "fatal-status")
    },
  ],

  [
    "http: a 401 names the host credential, never the key (issue #327)",
    async () => {
      const sentinel = "host-key-sentinel"
      const { fetch } = spyFetch(() => errorResponse(401, { error: { message: "unauthorized" } }))
      const provider = providerFor(fetch, { apiKey: sentinel })
      const error = surfacedErrorOf(await collect(provider.languageModel(PROVIDER_MODEL)))
      assert(
        error.message.includes(
          "(POST https://x/provider/v1/chat/completions, credential: Host connection)",
        ),
        error.message,
      )
      assert(!error.message.includes(sentinel), `message leaked the key: ${error.message}`)
    },
  ],

  [
    "http: a 401 from the env var names COMMANDCODE_API_KEY (issue #327)",
    async () => {
      const sentinel = "env-key-sentinel"
      const { fetch } = spyFetch(() => errorResponse(401, { error: { message: "unauthorized" } }))
      await withEnvVars({ COMMANDCODE_API_KEY: sentinel }, async () => {
        const provider = createCommandCode({
          baseURL: "https://x",
          plan: "goat",
          maxRetryDelayMs: 0,
          fetch,
          authPaths: [],
        })
        const error = surfacedErrorOf(await collect(provider.languageModel(PROVIDER_MODEL)))
        assert(error.message.includes("credential: COMMANDCODE_API_KEY"), error.message)
        assert(!error.message.includes(sentinel), `message leaked the key: ${error.message}`)
      })
    },
  ],

  [
    "http: a 401 on the legacy transport names a legacy-file credential (issue #327)",
    async () => {
      const sentinel = "file-key-sentinel"
      const dir = await mkdtemp(join(tmpdir(), "cc-cred-"))
      try {
        const authPath = join(dir, "auth.json")
        await writeFile(authPath, JSON.stringify({ apiKey: sentinel }))
        const { fetch } = spyFetch(() => errorResponse(401, { error: { message: "unauthorized" } }))
        const provider = createCommandCode({
          baseURL: "https://x",
          plan: "go",
          maxRetryDelayMs: 0,
          fetch,
          authPaths: [authPath],
        })
        const error = surfacedErrorOf(await collect(provider.languageModel("claude-sonnet-5")))
        assert(
          error.message.includes(
            `(POST https://x/alpha/generate, credential: legacy file ${authPath})`,
          ),
          error.message,
        )
        assert(!error.message.includes(sentinel), `message leaked the key: ${error.message}`)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "http: a 401 on the Provider API names a legacy-file credential (issue #327)",
    async () => {
      const sentinel = "file-key-sentinel"
      const dir = await mkdtemp(join(tmpdir(), "cc-cred-"))
      try {
        const authPath = join(dir, "auth.json")
        await writeFile(authPath, JSON.stringify({ apiKey: sentinel }))
        const { fetch } = spyFetch(() => errorResponse(401, { error: { message: "unauthorized" } }))
        const provider = createCommandCode({
          baseURL: "https://x",
          plan: "goat",
          maxRetryDelayMs: 0,
          fetch,
          authPaths: [authPath],
        })
        const error = surfacedErrorOf(await collect(provider.languageModel(PROVIDER_MODEL)))
        assert(
          error.message.includes(
            `(POST https://x/provider/v1/chat/completions, credential: legacy file ${authPath})`,
          ),
          error.message,
        )
        assert(!error.message.includes(sentinel), `message leaked the key: ${error.message}`)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "http: a 401 on the legacy transport names COMMANDCODE_API_KEY (issue #327)",
    async () => {
      const sentinel = "env-key-sentinel"
      const { fetch } = spyFetch(() => errorResponse(401, { error: { message: "unauthorized" } }))
      await withEnvVars({ COMMANDCODE_API_KEY: sentinel }, async () => {
        const provider = createCommandCode({
          baseURL: "https://x",
          plan: "go",
          maxRetryDelayMs: 0,
          fetch,
          authPaths: [],
        })
        const error = surfacedErrorOf(await collect(provider.languageModel("claude-sonnet-5")))
        assert(
          error.message.includes(
            "(POST https://x/alpha/generate, credential: COMMANDCODE_API_KEY)",
          ),
          error.message,
        )
        assert(!error.message.includes(sentinel), `message leaked the key: ${error.message}`)
      })
    },
  ],

  [
    "http: a caller Authorization overlay suppresses the credential label (issue #327)",
    async () => {
      // The ladder header is overridden, so naming its rung would be a lie.
      const { fetch } = spyFetch(() => errorResponse(401, { error: { message: "unauthorized" } }))
      const provider = providerFor(fetch, { headers: { Authorization: "Bearer other-key" } })
      const error = surfacedErrorOf(await collect(provider.languageModel(PROVIDER_MODEL)))
      assert(
        !error.message.includes("credential:"),
        `overridden auth names no rung: ${error.message}`,
      )
      assert(error.message.includes("(POST https://x/provider/v1/chat/completions)"), error.message)
    },
  ],
])
