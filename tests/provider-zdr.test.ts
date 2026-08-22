// tests/provider-zdr.test.ts — issue #57: minimal ZDR passthrough.
//
// When CMD_ZDR=1 is set (the CLI's own opt-in, per Provider docs), every
// Provider API request in the session carries `x-cmd-zdr: 1`; otherwise no
// header is sent. The legacy /alpha/generate transport never sends it. A
// documented `422 cmd_zdr_no_providers` (model has no ZDR-capable upstream)
// is not handled specially — it flows through commandCodeErrorMessage →
// redactCommandCodeErrorText like any other API error.
//
// Verified at the LanguageModel seam (doStream/doGenerate) with fetch spies
// and the in-process mock Command Code server.
import { createCommandCode } from "../src/provider/index.js"
import {
  startMockCc,
  openAIChunk,
  openAIFinishChunk,
  anthropicContentBlockDelta,
  anthropicMessageDelta,
  textDelta,
  finishEvent,
  upgradeRequiredBody,
  zdrNoProvidersBody,
  headersToRecord,
} from "./helpers/mock-cc.js"
import type { LanguageModelV3Prompt } from "../src/provider/aisdk-types.js"
import { assert, assertEqual, run } from "./harness.js"

type Model = ReturnType<ReturnType<typeof createCommandCode>["languageModel"]>

interface SpyCall {
  url: string
  method: string
  headers: Record<string, string>
}

/** Sets/clears CMD_ZDR for the duration of fn, restoring after. */
function withZdr(value: string | undefined, fn: () => Promise<void> | void): Promise<void> {
  const prev = process.env.CMD_ZDR
  if (value === undefined) delete process.env.CMD_ZDR
  else process.env.CMD_ZDR = value

  const p = Promise.resolve().then(() => fn() as unknown as Promise<void>)
  return p.finally(() => {
    if (prev === undefined) delete process.env.CMD_ZDR
    else process.env.CMD_ZDR = prev
  })
}

function sseResponse(events: Array<Record<string, unknown> | "end">): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        if (evt === "end") break
        controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } })
}

async function collect(
  model: Model,
  prompt: LanguageModelV3Prompt = [{ role: "user", content: "hi" }],
): Promise<Array<Record<string, unknown>>> {
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

const OPENAI_EVENTS: Array<Record<string, unknown> | "end"> = [
  openAIChunk("hi"),
  openAIFinishChunk(),
]
const ANTHROPIC_EVENTS: Array<Record<string, unknown> | "end"> = [
  anthropicContentBlockDelta("hi"),
  anthropicMessageDelta(),
]
const LEGACY_EVENTS: Array<Record<string, unknown> | "end"> = [textDelta("legacy"), finishEvent()]

run([
  [
    "CMD_ZDR=1 → Provider OpenAI chat/completions carries x-cmd-zdr: 1 (doStream + doGenerate)",
    async () => {
      await withZdr("1", async () => {
        const calls: SpyCall[] = []
        const fetchImpl: typeof fetch = async (input, init) => {
          const url = typeof input === "string" ? input : (input as URL).toString()
          calls.push({
            url,
            method: (init?.method ?? "GET") as string,
            headers: headersToRecord(init?.headers),
          })
          if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
          if (url.includes("/chat/completions")) return sseResponse(OPENAI_EVENTS)
          return new Response("not found", { status: 404 })
        }
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch: fetchImpl })
        const model = provider.languageModel("gpt-5.6-terra")
        await collect(model)
        await model.doGenerate({
          prompt: [{ role: "user", content: "hi" }],
          mode: { type: "regular" },
        } as never)
        const providerCalls = calls.filter((c) => c.url.includes("/chat/completions"))
        assertEqual(providerCalls.length, 2, "two Provider calls (stream + generate)")
        for (const c of providerCalls) {
          assertEqual(c.headers["x-cmd-zdr"], "1", "x-cmd-zdr: 1 on Provider request")
        }
        assert(!calls.some((c) => c.url.includes("/alpha/generate")), "no legacy traffic")
      })
    },
  ],
  [
    "CMD_ZDR=1 → Provider Anthropic messages carries x-cmd-zdr: 1 (doStream + doGenerate)",
    async () => {
      await withZdr("1", async () => {
        const calls: SpyCall[] = []
        const fetchImpl: typeof fetch = async (input, init) => {
          const url = typeof input === "string" ? input : (input as URL).toString()
          calls.push({
            url,
            method: (init?.method ?? "GET") as string,
            headers: headersToRecord(init?.headers),
          })
          if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
          if (url.includes("/messages")) return sseResponse(ANTHROPIC_EVENTS)
          return new Response("not found", { status: 404 })
        }
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch: fetchImpl })
        const model = provider.languageModel("claude-sonnet-5")
        await collect(model)
        await model.doGenerate({
          prompt: [{ role: "user", content: "hi" }],
          mode: { type: "regular" },
        } as never)
        const providerCalls = calls.filter((c) => c.url.includes("/messages"))
        assertEqual(providerCalls.length, 2, "two messages calls (stream + generate)")
        assertEqual(providerCalls[0].url, "https://x/provider/v1/messages")
        for (const c of providerCalls) {
          assertEqual(c.headers["x-cmd-zdr"], "1", "x-cmd-zdr: 1 on messages request")
        }
      })
    },
  ],
  [
    "no CMD_ZDR (unset/empty/0/other) → no x-cmd-zdr header on any request (both endpoints, both methods)",
    async () => {
      const values: Array<string | undefined> = [undefined, "", "0", "true", "2", "yes"]
      for (const value of values) {
        await withZdr(value, async () => {
          const calls: SpyCall[] = []
          const fetchImpl: typeof fetch = async (input, init) => {
            const url = typeof input === "string" ? input : (input as URL).toString()
            calls.push({
              url,
              method: (init?.method ?? "GET") as string,
              headers: headersToRecord(init?.headers),
            })
            if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
            if (url.includes("/chat/completions")) return sseResponse(OPENAI_EVENTS)
            if (url.includes("/messages")) return sseResponse(ANTHROPIC_EVENTS)
            return new Response("not found", { status: 404 })
          }
          const provider = createCommandCode({
            apiKey: "k",
            baseURL: "https://x",
            fetch: fetchImpl,
          })
          const oa = provider.languageModel("gpt-5.6-terra")
          await collect(oa)
          await oa.doGenerate({
            prompt: [{ role: "user", content: "hi" }],
            mode: { type: "regular" },
          } as never)
          await collect(provider.languageModel("claude-sonnet-5"))
          const providerCalls = calls.filter((c) => c.url.includes("/provider/v1/"))
          assert(
            providerCalls.length >= 3,
            `three provider calls expected for CMD_ZDR=${String(value)}`,
          )
          for (const c of providerCalls) {
            assertEqual(
              c.headers["x-cmd-zdr"],
              undefined,
              `no x-cmd-zdr for CMD_ZDR=${String(value)}`,
            )
          }
        })
      }
    },
  ],
  [
    "CMD_ZDR=1 → legacy /alpha/generate never sends x-cmd-zdr",
    async () => {
      await withZdr("1", async () => {
        const calls: SpyCall[] = []
        const fetchImpl: typeof fetch = async (input, init) => {
          const url = typeof input === "string" ? input : (input as URL).toString()
          calls.push({
            url,
            method: (init?.method ?? "GET") as string,
            headers: headersToRecord(init?.headers),
          })
          if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
          if (url.includes("/alpha/generate")) return sseResponse(LEGACY_EVENTS)
          return new Response("not found", { status: 404 })
        }
        const provider = createCommandCode({
          apiKey: "k",
          baseURL: "https://x",
          fetch: fetchImpl,
          plan: "go",
        })
        await collect(provider.languageModel("claude-sonnet-5"))
        const legacyCalls = calls.filter((c) => c.url.includes("/alpha/generate"))
        assertEqual(legacyCalls.length, 1)
        assertEqual(legacyCalls[0].headers["x-cmd-zdr"], undefined, "legacy never sends ZDR")
        assertEqual(legacyCalls[0].url, "https://x/alpha/generate")
      })
    },
  ],
  [
    "CMD_ZDR=1 via mock server — both Provider endpoints carry the header (OpenAI + Anthropic)",
    async () => {
      await withZdr("1", async () => {
        // OpenAI path
        let oa: Record<string, string> | undefined
        const mockOa = await startMockCc({
          chatCompletionsStream: OPENAI_EVENTS,
          onChatCompletions: (_b, h) => {
            oa = h
          },
        })
        try {
          await collect(
            createCommandCode({ apiKey: "k", baseURL: mockOa.url }).languageModel("gpt-5.6-terra"),
          )
          assertEqual(oa!["x-cmd-zdr"], "1")
        } finally {
          await mockOa.close()
        }
        // Anthropic path
        let ant: Record<string, string> | undefined
        const mockAnt = await startMockCc({
          messagesStream: ANTHROPIC_EVENTS,
          onMessages: (_b, h) => {
            ant = h
          },
        })
        try {
          await collect(
            createCommandCode({ apiKey: "k", baseURL: mockAnt.url }).languageModel(
              "claude-sonnet-5",
            ),
          )
          assertEqual(ant!["x-cmd-zdr"], "1")
        } finally {
          await mockAnt.close()
        }
      })
    },
  ],
  [
    "422 cmd_zdr_no_providers with CMD_ZDR=1 → header sent, error surfaces redacted (no special handling)",
    async () => {
      await withZdr("1", async () => {
        const calls: SpyCall[] = []
        const secret = "sk-zdr-secret-1234567890abcdef"
        // The documented 422 body (zdrNoProvidersBody), with a credential
        // appended to the `message` so the test also proves the redaction
        // pipeline ran on the surfaced error.
        const documented = JSON.parse(zdrNoProvidersBody()) as {
          error: { message: string }
        }
        documented.error.message = `${documented.error.message} api_key=${secret}`
        const body = JSON.stringify(documented)
        const fetchImpl: typeof fetch = async (input, init) => {
          const url = typeof input === "string" ? input : (input as URL).toString()
          calls.push({
            url,
            method: (init?.method ?? "GET") as string,
            headers: headersToRecord(init?.headers),
          })
          if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
          return errorResponse(422, body)
        }
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch: fetchImpl })
        const parts = await collect(provider.languageModel("gpt-5.6-terra"))
        const err = parts.find((p) => p.type === "error") as { error?: Error }
        assert(err, "error part surfaced")
        // The failing request carried the ZDR header (docs: the 422 answers
        // requests with x-cmd-zdr: 1 when no upstream is ZDR-capable).
        const providerCall = calls.find((c) => c.url.includes("/chat/completions"))
        assertEqual(providerCall?.headers["x-cmd-zdr"], "1")
        // Normal redacted API error: status + code + message surface, secret redacted.
        assert(err.error!.message.includes("Command Code API error 422"), "422 status surfaced")
        assert(err.error!.message.includes("cmd_zdr_no_providers"), "422 code surfaced")
        assert(err.error!.message.includes("x-cmd-zdr: 1 was set"), "422 message surfaced")
        assert(err.error!.message.includes("[redacted]"), "credential redacted")
        assert(!err.error!.message.includes(secret), "raw secret never surfaces")
        // No flip, no retry to another transport — normal error pipeline.
        assertEqual(calls.filter((c) => c.url.includes("/chat/completions")).length, 1)
        assert(!calls.some((c) => c.url.includes("/alpha/generate")), "no legacy fallback")
      })
    },
  ],
  [
    "CMD_ZDR=1 → 403 upgrade_required flip: Provider attempt carries x-cmd-zdr, legacy retry omits it",
    async () => {
      await withZdr("1", async () => {
        const captured: Array<{ url: "chat" | "generate"; headers: Record<string, string> }> = []
        const mock = await startMockCc({
          chatCompletionsStatus: 403,
          chatCompletionsErrorBody: upgradeRequiredBody(),
          stream: [textDelta("retried"), finishEvent()],
          onChatCompletions: (_b, h) => {
            captured.push({ url: "chat", headers: h })
          },
          onGenerate: (_b, h) => {
            captured.push({ url: "generate", headers: h })
          },
        })
        try {
          const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"))
          assertEqual(mock.hits.chatCompletions, 1, "one Provider attempt")
          assertEqual(mock.hits.generate, 1, "one legacy retry")
          // The Provider attempt that 403'd carried the ZDR header...
          assertEqual(captured[0].url, "chat")
          assertEqual(captured[0].headers["x-cmd-zdr"], "1")
          // ...but the legacy retry must never send it (issue #57 acceptance).
          assertEqual(captured[1].url, "generate")
          assertEqual(captured[1].headers["x-cmd-zdr"], undefined, "legacy retry omits x-cmd-zdr")
          const deltas = parts
            .filter((p) => p.type === "text-delta")
            .map((p) => (p as { delta?: string }).delta)
          assertEqual(deltas, ["retried"])
          assert(!parts.some((p) => p.type === "error"), "no error part")
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "mock: 429 with Retry-After retries on all three endpoints (harness hardening)",
    async () => {
      await withZdr("1", async () => {
        // legacy /alpha/generate
        {
          const mock = await startMockCc({
            status: 429,
            retryAfter: 0,
            errorBody: JSON.stringify({ error: { message: "rate limited" } }),
            generateErrorCount: 1,
            stream: [textDelta("legacy ok"), finishEvent()],
          })
          try {
            const provider = createCommandCode({
              apiKey: "k",
              baseURL: mock.url,
              plan: "go",
              maxRetries: 1,
            })
            const parts = await collect(provider.languageModel("claude-sonnet-5"))
            assertEqual(mock.hits.generate, 2, "legacy retried once after Retry-After")
            assert(
              parts.some((p) => p.type === "finish"),
              "legacy finished after retry",
            )
          } finally {
            await mock.close()
          }
        }
        // provider OpenAI
        {
          const seen: Array<Record<string, string>> = []
          const mock = await startMockCc({
            chatCompletionsStatus: 429,
            chatCompletionsRetryAfter: 0,
            chatCompletionsErrorCount: 1,
            chatCompletionsErrorBody: JSON.stringify({ error: { message: "rate limited" } }),
            chatCompletionsStream: OPENAI_EVENTS,
            onChatCompletions: (_b, h) => {
              seen.push(h)
            },
          })
          try {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url, maxRetries: 1 })
            const parts = await collect(provider.languageModel("gpt-5.6-terra"))
            assertEqual(mock.hits.chatCompletions, 2, "OpenAI retried once after Retry-After")
            assert(
              parts.some((p) => p.type === "finish"),
              "OpenAI finished after retry",
            )
            // Both attempts (the 429 and the retry) carried the ZDR header.
            assertEqual(seen.length, 2)
            for (const h of seen) assertEqual(h["x-cmd-zdr"], "1", "every attempt carries ZDR")
          } finally {
            await mock.close()
          }
        }
        // provider Anthropic
        {
          const mock = await startMockCc({
            messagesStatus: 429,
            messagesRetryAfter: 0,
            messagesErrorCount: 1,
            messagesErrorBody: JSON.stringify({ error: { message: "rate limited" } }),
            messagesStream: ANTHROPIC_EVENTS,
          })
          try {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url, maxRetries: 1 })
            const parts = await collect(provider.languageModel("claude-sonnet-5"))
            assertEqual(mock.hits.messages, 2, "Anthropic retried once after Retry-After")
            assert(
              parts.some((p) => p.type === "finish"),
              "Anthropic finished after retry",
            )
          } finally {
            await mock.close()
          }
        }
      })
    },
  ],
])
