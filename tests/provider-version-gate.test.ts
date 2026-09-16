// tests/provider-version-gate.test.ts — issue #173, the legacy version gate.
//
// The legacy `/alpha/generate` gateway version-gates its
// `x-command-code-version` header: an absent, unparseable or too-old value
// answers `403 upgrade_required` with a `minVersion` (0.18.10 when probed
// live). The server's own wording blames "the Command Code CLI" — a binary a
// plugin user is not running — so the transport replaces it, and the tests
// below pin both halves of the acceptance:
//   1. a version-gate 403 produces a message naming the plugin, never the CLI,
//      quoting the server's minimum when it named one, for both legacy and
//      Provider API endpoints;
//   2. the reported version never sits below the server's floor.
import { createCommandCode } from "../src/provider/index.js"
import { COMMAND_CODE_CLI_VERSION } from "../src/provider/command-code-model.js"
import { headersToRecord, versionGateBody } from "./helpers/mock-cc.js"
import { assert, assertEqual, run } from "./harness.js"

type Model = ReturnType<ReturnType<typeof createCommandCode>["languageModel"]>

interface SpyCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Fetch spy: every inference endpoint (legacy included) answers the given error. */
function errorSpy(status: number, body: unknown): { fetch: typeof fetch; calls: SpyCall[] } {
  const calls: SpyCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString()
    calls.push({
      url,
      method: (init?.method ?? "GET") as string,
      headers: headersToRecord(init?.headers),
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    })
    if (url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
    return errorResponse(status, body)
  }
  return { fetch: fetchImpl, calls }
}

async function collect(
  model: Model,
  prompt: Array<{ role: string; content: string }> = [{ role: "user", content: "hi" }],
): Promise<Array<Record<string, unknown>>> {
  const result = await model.doStream({
    prompt,
    mode: { type: "regular" },
  } as never)
  const parts: Array<Record<string, unknown>> = []
  const reader = result.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as unknown as Record<string, unknown>)
  }
  return parts
}

function errorMessageOf(parts: Array<Record<string, unknown>>): string {
  const err = parts.find((p) => p.type === "error") as { error?: Error }
  assert(err, "error part surfaced")
  return err.error!.message
}

const VERSION_GATE_MESSAGE = /out of date/
const inferenceCalls = (calls: SpyCall[]) => calls.filter((c) => c.method === "POST")

/** `1.2.3` < `1.10.0`: numeric field-by-field, so a string compare can't lie. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * The floor the live probe recorded. `versionGateBody()` is the verbatim 403
 * the gateway answered for `0.9.0` (issue #173) — absent/`unknown`/
 * `not-a-version` also 403'd, `1.0.0` upward answered 200 — so the minimum it
 * names is the last floor we can point at. Deriving it from the fixture keeps
 * the guard mechanical: there is no second hand-typed upstream version to
 * retype the day the server moves.
 */
function recordedFloor(): string {
  const body = JSON.parse(versionGateBody()) as { error: { minVersion: string } }
  return body.error.minVersion
}

run([
  [
    "the reported legacy version clears the floor the live gate recorded (issue #173)",
    () => {
      // A static backstop, deliberately: the floor is server state, observable
      // only through a live 403, so CI checks the reported version against the
      // last recorded one. A floor the server raises beyond the reported
      // version surfaces in production as the plugin-named message below.
      const floor = recordedFloor()
      assert(/^\d+\.\d+\.\d+$/.test(floor), `floor is a plain version, got: ${floor}`)
      assert(
        compareVersions(COMMAND_CODE_CLI_VERSION, floor) >= 0,
        `wire version ${COMMAND_CODE_CLI_VERSION} is below the recorded floor ${floor}`,
      )
    },
  ],
  [
    "legacy version-gate 403: the message names the plugin, not the CLI (minVersion quoted)",
    async () => {
      const { fetch, calls } = errorSpy(403, versionGateBody())
      const provider = createCommandCode({
        apiKey: "k",
        baseURL: "https://x",
        fetch,
        plan: "go",
        // A version gate is permanent for this build: even a configured ladder
        // must not replay it.
        maxRetries: 3,
      })
      const message = errorMessageOf(await collect(provider.languageModel("claude-sonnet-5")))
      assert(message.includes("opencode-cmd-provider"), `names the plugin: ${message}`)
      assert(message.includes("0.18.10"), `quotes the server's minimum: ${message}`)
      assert(message.includes(COMMAND_CODE_CLI_VERSION), `quotes the reported version: ${message}`)
      assert(!message.includes("CLI"), `does not blame a CLI: ${message}`)
      assert(VERSION_GATE_MESSAGE.test(message), `says out of date: ${message}`)
      // Fatal, not retried: exactly one request, and no fallback anywhere.
      assertEqual(inferenceCalls(calls).length, 1, "no replay after the version gate")
      assertEqual(
        calls.every((c) => c.url.includes("/alpha/generate")),
        true,
        "legacy only — nothing flips to another endpoint",
      )
    },
  ],
  [
    "legacy version-gate 403 without a minVersion still names the plugin",
    async () => {
      // The other observed wording: "out of date" with no floor named.
      const { fetch } = errorSpy(403, {
        error: { code: "upgrade_required", message: "Your Command Code CLI is out of date." },
      })
      const provider = createCommandCode({
        apiKey: "k",
        baseURL: "https://x",
        fetch,
        plan: "go",
      })
      const message = errorMessageOf(await collect(provider.languageModel("gpt-5.6-terra")))
      assert(message.includes("opencode-cmd-provider"), `names the plugin: ${message}`)
      assert(!message.includes("CLI"), `does not blame a CLI: ${message}`)
      assert(!message.includes("server minimum"), `no invented floor: ${message}`)
    },
  ],
  [
    "Provider API version-gate 403: the same plugin-named message, still no flip",
    async () => {
      // `/provider/v1/*` is not version-gated, but the guard is shared: if the
      // server ever gates it, the message must be the same one and the session
      // must not flip to the legacy transport.
      const { fetch, calls } = errorSpy(403, versionGateBody())
      const provider = createCommandCode({
        apiKey: "k",
        baseURL: "https://x",
        fetch,
        plan: "goat",
      })
      const message = errorMessageOf(await collect(provider.languageModel("gpt-5.6-terra")))
      assert(message.includes("opencode-cmd-provider"), `names the plugin: ${message}`)
      assert(message.includes("0.18.10"), `quotes the server's minimum: ${message}`)
      assert(!message.includes("CLI"), `does not blame a CLI: ${message}`)
      assertEqual(inferenceCalls(calls).length, 1, "one attempt, no legacy retry")
      assertEqual(
        calls.filter((c) => c.url.includes("/alpha/generate")).length,
        0,
        "a version gate never flips the transport",
      )
    },
  ],
  [
    "a plan-gate 403 on the legacy transport still flows through unchanged",
    async () => {
      // Regression guard for the version-gate check: it must only swallow the
      // gate it names. A plan-gate body on the legacy endpoint keeps the
      // generic API-error wording (the legacy descriptor never flips).
      const { fetch, calls } = errorSpy(403, {
        error: {
          code: "upgrade_required",
          message: "You're on the Go plan, the only plan without API access.",
        },
      })
      const provider = createCommandCode({
        apiKey: "k",
        baseURL: "https://x",
        fetch,
        plan: "go",
      })
      const message = errorMessageOf(await collect(provider.languageModel("claude-sonnet-5")))
      assert(message.includes("Command Code API error 403"), `generic wording: ${message}`)
      assert(!message.includes("opencode-cmd-provider"), `not a version gate: ${message}`)
      assertEqual(inferenceCalls(calls).length, 1, "no legacy retry from legacy")
    },
  ],
  [
    "the legacy request reports the snapshot's command-code build (issue #173)",
    async () => {
      // The header half of the acceptance: whatever the golden says, the live
      // request carries the same version the floor check above clears.
      const { fetch, calls } = errorSpy(403, versionGateBody())
      const provider = createCommandCode({
        apiKey: "k",
        baseURL: "https://x",
        fetch,
        plan: "go",
      })
      await collect(provider.languageModel("claude-sonnet-5"))
      const legacy = calls.find((c) => c.url.includes("/alpha/generate"))
      assert(legacy, "legacy request made")
      assertEqual(legacy!.headers["x-command-code-version"], COMMAND_CODE_CLI_VERSION)
      assertEqual("x-co-flag" in legacy!.headers, false, "x-co-flag is gone (issue #173)")
    },
  ],
])
