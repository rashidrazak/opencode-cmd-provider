// tests/provider-upgrade-fallback.test.ts — issue #56 safety net:
// a Provider API plan-gate `403` flips the session to the legacy
// /alpha/generate transport and retries the same call once there.
//
// Both endpoint envelopes are covered (issue #175): the documented
// `error.code: upgrade_required` and the live `/provider/v1/messages` shape
// (`type: permission_error` with the plan phrasing and no code).
//
// Verified at the LanguageModel seam (doStream/doGenerate) with fetch spies:
//   1. Provider 403 upgrade_required → same call retried via POST /alpha/generate
//      with the legacy CLI wire format, and it succeeds.
//   2. The flip is sticky: later turns on the same model instance hit only
//      legacy — no second Provider API call, no second 403.
//   3. Non-403 errors (401/422/429/500) and 403 without the plan-gate body never
//      flip — they flow through the existing error/redaction pipeline. A
//      stale-client version gate (minVersion / "out of date") is one of them.
//   4. Usage/cost surfaced is the retried legacy response's — no double-counting.
import { createCommandCode } from "../src/provider/index.js"
import {
  finishEvent,
  textDelta,
  upgradeRequiredBody,
  liveMessagesUpgradeBody,
  liveChatUpgradeBody,
  versionGateBody,
  headersToRecord,
} from "./helpers/mock-cc.js"
import type { LanguageModelV3Prompt } from "../src/provider/aisdk-types.js"
import { assert, assertEqual, run } from "./harness.js"
import { calculateCommandCodeCost, costUsageFromAiSdkUsage } from "../src/provider/cost.js"

type Model = ReturnType<ReturnType<typeof createCommandCode>["languageModel"]>

interface SpyCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
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

function errorResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Documented Provider API 403 upgrade_required body (https://commandcode.ai/docs/provider). */
const UPGRADE_BODY = upgradeRequiredBody()
/** The live `/provider/v1/messages` 403: plan phrasing, no `error.code` (issue #175). */
const LIVE_MESSAGES_BODY = liveMessagesUpgradeBody()
/** The live `/provider/v1/chat/completions` 403: the same message plus `code` (issue #175). */
const LIVE_CHAT_BODY = liveChatUpgradeBody()
/** The version-gate 403: the plan gate's `code` plus `minVersion` (issue #175). */
const VERSION_GATE_BODY = versionGateBody()

const LEGACY_EVENTS: Array<Record<string, unknown> | "end"> = [
  textDelta("legacy answer"),
  finishEvent({ totalUsage: { inputTokens: 10, outputTokens: 4 } }),
]

/** Fetch spy: the Provider API endpoints answer 403 with the given bodies
 * (both default to the documented one); legacy succeeds. */
function upgradeSpy(bodies: { chat?: unknown; messages?: unknown } = {}): {
  fetch: typeof fetch
  calls: SpyCall[]
} {
  const chatBody = bodies.chat ?? UPGRADE_BODY
  const messagesBody = bodies.messages ?? chatBody
  const calls: SpyCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString()
    const call: SpyCall = {
      url,
      method: (init?.method ?? "GET") as string,
      headers: headersToRecord(init?.headers),
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
    if (url.includes("/provider/v1/messages")) return errorResponse(403, messagesBody)
    if (url.includes("/provider/v1/")) return errorResponse(403, chatBody)
    if (url.includes("/alpha/generate")) return sseResponse(LEGACY_EVENTS)
    return new Response("not found", { status: 404 })
  }
  return { fetch: fetchImpl, calls }
}

/** Fetch spy: every inference endpoint answers the given error, legacy never served. */
function errorSpy(status: number, body: unknown): { fetch: typeof fetch; calls: SpyCall[] } {
  const calls: SpyCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString()
    const call: SpyCall = {
      url,
      method: (init?.method ?? "GET") as string,
      headers: headersToRecord(init?.headers),
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
    return errorResponse(status, body)
  }
  return { fetch: fetchImpl, calls }
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

const providerCalls = (calls: SpyCall[]) => calls.filter((c) => c.url.includes("/provider/v1/"))
const legacyCalls = (calls: SpyCall[]) => calls.filter((c) => c.url.includes("/alpha/generate"))
const planLookupCalls = (calls: SpyCall[]) =>
  calls.filter((c) => c.url.includes("/alpha/whoami") || c.url.includes("/alpha/billing/"))

run([
  [
    "safety net: Provider 403 upgrade_required flips the same doStream call to /alpha/generate (OpenAI route)",
    async () => {
      const { fetch, calls } = upgradeSpy()
      const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "goat" })
      const parts = await collect(provider.languageModel("gpt-5.6-terra"))
      // Provider attempt 403'd, then the same call retried once on legacy.
      assertEqual(providerCalls(calls).length, 1, "one Provider API attempt")
      assertEqual(
        providerCalls(calls)[0].url,
        "https://x/provider/v1/chat/completions",
        "OpenAI-route model hits chat/completions",
      )
      assertEqual(legacyCalls(calls).length, 1, "one legacy retry")
      assertEqual(legacyCalls(calls)[0].url, "https://x/alpha/generate")
      assertEqual(planLookupCalls(calls).length, 0, "an explicit pin makes no plan lookup")
      // The retry uses the legacy CLI wire format.
      const legacyBody = legacyCalls(calls)[0].body as {
        params: { model: string; stream: boolean }
        threadId: string
      }
      assertEqual(legacyBody.params.model, "gpt-5.6-terra")
      assertEqual(legacyBody.params.stream, true)
      assert(legacyBody.threadId, "legacy threadId present")
      const legacyHeaders = legacyCalls(calls)[0].headers
      assertEqual(legacyHeaders["x-command-code-version"], "1.15.1")
      assertEqual(legacyHeaders["authorization"], "Bearer k")
      // The legacy response is the one surfaced — content and usage, no error.
      const deltas = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta: string }).delta)
      assertEqual(deltas, ["legacy answer"])
      // Acceptance 4: the cost hook fires exactly once — on the retried legacy
      // finish. The failed Provider attempt emitted no parts (the 403 lands
      // before any SSE), so exactly one finish part whose usage is the legacy
      // one is the observable no-double-counting guarantee.
      const finishes = parts.filter((p) => p.type === "finish")
      assertEqual(finishes.length, 1, "exactly one finish — no double-counting")
      const usage = (finishes[0] as { usage: never }).usage
      assertEqual(usage, {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 4, text: 4, reasoning: 0 },
      })
      assert(
        !parts.some((p) => p.type === "error"),
        "no error part — the retried legacy call succeeded",
      )
      // Cost from the retried legacy response (issue #56 acceptance 4).
      const cu = costUsageFromAiSdkUsage(usage)
      calculateCommandCodeCost({ cost: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 1 } }, cu)
      assert(cu.cost.total > 0, "cost calculated from the legacy usage")
    },
  ],
  [
    "safety net: 403 on the Anthropic endpoint flips to legacy too",
    async () => {
      const { fetch, calls } = upgradeSpy()
      const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "goat" })
      const parts = await collect(provider.languageModel("claude-sonnet-5"))
      assertEqual(
        providerCalls(calls)[0].url,
        "https://x/provider/v1/messages",
        "claude-* model hits /provider/v1/messages first",
      )
      assertEqual(legacyCalls(calls).length, 1)
      assertEqual(providerCalls(calls).length, 1)
      const deltas = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta: string }).delta)
      assertEqual(deltas, ["legacy answer"])
    },
  ],
  [
    "safety net: the live Provider API 403 shapes flip — /messages (no code) and /chat/completions (code) (issue #175)",
    async () => {
      const { fetch, calls } = upgradeSpy({ chat: LIVE_CHAT_BODY, messages: LIVE_MESSAGES_BODY })
      const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "goat" })
      // Anthropic route: the live /messages envelope carries `permission_error`
      // and the plan phrasing, but no `error.code` at all.
      const claudeParts = await collect(provider.languageModel("claude-sonnet-5"))
      // OpenAI route: the live chat/completions envelope carries the same
      // message plus `"code":"upgrade_required"`.
      const openAIParts = await collect(provider.languageModel("gpt-5.6-terra"))
      assertEqual(
        providerCalls(calls).map((c) => c.url),
        ["https://x/provider/v1/messages", "https://x/provider/v1/chat/completions"],
        "each route's own endpoint was tried once",
      )
      assertEqual(legacyCalls(calls).length, 2, "each route retried once on legacy")
      for (const [route, parts] of [
        ["messages", claudeParts],
        ["chat/completions", openAIParts],
      ] as const) {
        const deltas = parts
          .filter((p) => p.type === "text-delta")
          .map((p) => (p as { delta: string }).delta)
        assertEqual(deltas, ["legacy answer"], `${route}: the legacy answer is served`)
        assert(!parts.some((p) => p.type === "error"), `${route}: no error part`)
      }
    },
  ],
  [
    "safety net: the flip is sticky — second turn on the same instance hits only legacy",
    async () => {
      const { fetch, calls } = upgradeSpy()
      const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "goat" })
      const model = provider.languageModel("gpt-5.6-terra")
      await collect(model)
      await collect(model)
      // First turn: Provider 403 then legacy. Second turn: legacy only —
      // no second Provider API call, no second 403.
      assertEqual(providerCalls(calls).length, 1, "Provider API hit exactly once across turns")
      assertEqual(legacyCalls(calls).length, 2, "both turns served by legacy")
      const order = calls.map((c) => c.url)
      assertEqual(order, [
        "https://x/provider/v1/chat/completions",
        "https://x/alpha/generate",
        "https://x/alpha/generate",
      ])
    },
  ],
  [
    "safety net: doGenerate flips and returns the legacy content/usage",
    async () => {
      const { fetch, calls } = upgradeSpy()
      const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "goat" })
      const result = await provider.languageModel("gpt-5.6-terra").doGenerate({
        prompt: [{ role: "user", content: "hi" }],
        mode: { type: "regular" },
      } as never)
      assertEqual(providerCalls(calls).length, 1)
      assertEqual(legacyCalls(calls).length, 1)
      const text = (
        result.content.find((c) => (c as { type: string }).type === "text") as
          { text?: string } | undefined
      )?.text
      assertEqual(text, "legacy answer")
      assertEqual(result.usage, {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 4, text: 4, reasoning: 0 },
      })
    },
  ],
  [
    "safety net: 422 cmd_zdr_no_providers does NOT flip — error flows through unchanged",
    async () => {
      const { fetch, calls } = errorSpy(422, {
        error: {
          code: "cmd_zdr_no_providers",
          message:
            "x-cmd-zdr: 1 was set but the model has no zero-data-retention upstream. Remove the header or pick a different model.",
        },
      })
      const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "goat" })
      const model = provider.languageModel("gpt-5.6-terra")
      const parts = await collect(model)
      const err = parts.find((p) => p.type === "error") as { error?: Error }
      assert(err, "error part surfaced")
      // The documented 422 flows through the existing error pipeline
      // (commandCodeErrorMessage → redaction) — message and code both surface.
      assert(
        err.error!.message.includes("Command Code API error 422"),
        `422 status in message, got: ${err.error!.message}`,
      )
      assert(err.error!.message.includes("cmd_zdr_no_providers"), "422 code surfaced")
      assert(err.error!.message.includes("x-cmd-zdr: 1 was set"), "422 message surfaced")
      assertEqual(providerCalls(calls).length, 1)
      assertEqual(legacyCalls(calls).length, 0, "no legacy retry")
      // Still not flipped: a second turn hits the Provider API again.
      await collect(model)
      assertEqual(providerCalls(calls).length, 2)
      assertEqual(legacyCalls(calls).length, 0)
    },
  ],
  [
    "safety net: non-403 statuses (401/429/500) never flip",
    async () => {
      for (const status of [401, 429, 500]) {
        const { fetch, calls } = errorSpy(status, {
          error: { code: "server_error", message: `mock error ${status}` },
        })
        const provider = createCommandCode({
          apiKey: "k",
          baseURL: "https://x",
          fetch,
          plan: "goat",
          // The subject here is the flip, not the ladder: 429/500 are transient
          // and the default ladder replays them (issue #171), so the budget is
          // pinned off to count provider calls exactly.
          maxRetries: 0,
        })
        const parts = await collect(provider.languageModel("gpt-5.6-terra"))
        const err = parts.find((p) => p.type === "error") as { error?: Error }
        assert(err, `error part for ${status}`)
        assert(
          err.error!.message.includes(`Command Code API error ${status}`),
          `message mentions ${status}`,
        )
        assertEqual(providerCalls(calls).length, 1, `status ${status}: one provider call`)
        assertEqual(legacyCalls(calls).length, 0, `status ${status}: no legacy retry`)
      }
    },
  ],
  [
    "safety net: 403 without the upgrade_required body does not flip",
    async () => {
      const { fetch, calls } = errorSpy(403, { error: { message: "forbidden" } })
      const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "goat" })
      const parts = await collect(provider.languageModel("gpt-5.6-terra"))
      const err = parts.find((p) => p.type === "error") as { error?: Error }
      assert(err, "error part surfaced")
      assertEqual(err.error!.message, "Command Code API error 403: forbidden")
      assertEqual(providerCalls(calls).length, 1)
      assertEqual(legacyCalls(calls).length, 0, "plain 403 is not a flip signal")
    },
  ],
  [
    "safety net: a stale-client version-gate 403 never flips — the version guard wins (issue #175)",
    async () => {
      // The guard keeps a version-gate body out of the flip even though it
      // carries the plan gate's `upgrade_required` code: the `minVersion`
      // field / "out of date" wording decides first (issue #175).
      for (const modelId of ["claude-sonnet-5", "gpt-5.6-terra"]) {
        const { fetch, calls } = errorSpy(403, VERSION_GATE_BODY)
        const provider = createCommandCode({
          apiKey: "k",
          baseURL: "https://x",
          fetch,
          plan: "goat",
        })
        const model = provider.languageModel(modelId)
        const parts = await collect(model)
        const err = parts.find((p) => p.type === "error") as { error?: Error }
        assert(err, `${modelId}: error part surfaced`)
        assert(
          err.error!.message.includes("Command Code API error 403"),
          `${modelId}: 403 status in message, got: ${err.error!.message}`,
        )
        assert(
          err.error!.message.includes("out of date"),
          `${modelId}: version-gate wording surfaced, got: ${err.error!.message}`,
        )
        assertEqual(providerCalls(calls).length, 1, `${modelId}: one Provider API attempt`)
        assertEqual(legacyCalls(calls).length, 0, `${modelId}: no legacy retry`)
        // Still not flipped: a second turn hits the Provider API again.
        await collect(model)
        assertEqual(providerCalls(calls).length, 2, `${modelId}: still not flipped`)
        assertEqual(legacyCalls(calls).length, 0, `${modelId}: legacy never reached`)
      }
    },
  ],
  [
    "safety net: the flip is immediate — maxRetries never re-hits the Provider API",
    async () => {
      const { fetch, calls } = upgradeSpy()
      const provider = createCommandCode({
        apiKey: "k",
        baseURL: "https://x",
        fetch,
        plan: "goat",
        maxRetries: 3,
      })
      const parts = await collect(provider.languageModel("gpt-5.6-terra"))
      // 403 upgrade_required is a transport flip, not a retryable status: the
      // provider endpoint is hit exactly once even with maxRetries configured.
      assertEqual(providerCalls(calls).length, 1)
      assertEqual(legacyCalls(calls).length, 1)
      const deltas = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta: string }).delta)
      assertEqual(deltas, ["legacy answer"])
    },
  ],
  [
    "safety net: a 403 on the legacy retry does not re-enter the fallback — retries once, then errors",
    async () => {
      // Provider 403 upgrade_required flips; the legacy retry itself also 403s
      // with an upgrade-like body. The retry must be bounded to one: the
      // legacy error surfaces through the normal error pipeline instead of
      // recursively re-running the fallback.
      const calls: SpyCall[] = []
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input as URL).toString()
        const call: SpyCall = {
          url,
          method: (init?.method ?? "GET") as string,
          headers: headersToRecord(init?.headers),
          body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
        }
        calls.push(call)
        if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
        return errorResponse(403, UPGRADE_BODY)
      }
      const provider = createCommandCode({
        apiKey: "k",
        baseURL: "https://x",
        fetch: fetchImpl,
        plan: "goat",
      })
      const parts = await collect(provider.languageModel("gpt-5.6-terra"))
      assertEqual(providerCalls(calls).length, 1, "one Provider API attempt")
      assertEqual(legacyCalls(calls).length, 1, "exactly one legacy retry — no recursion")
      const err = parts.find((p) => p.type === "error") as { error?: Error }
      assert(err, "legacy 403 surfaced as an error part")
      assert(
        err.error!.message.includes("Command Code API error 403"),
        `legacy error message, got: ${err.error!.message}`,
      )
    },
  ],
])
