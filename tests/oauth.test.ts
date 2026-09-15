// tests/oauth.test.ts — auth server + /connect browser flow (PLAN #10, port of
// pi's test-oauth.ts server flow + state handling)
import { startAuthServer } from "../src/plugin/auth-server.js"
import { DEFAULT_AUTH_TIMEOUT_MS, runAuthFlow } from "../src/plugin/auth.js"
import { assert, assertEqual, run } from "./harness.js"

function post(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Arms a flow and returns the callback URL's port and the issued state token. */
async function arm(options: Parameters<typeof runAuthFlow>[0] = {}) {
  const result = await runAuthFlow({ startPort: 0, mirror: false, ...options })
  const url = new URL(result.url)
  const port = Number(url.searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1])
  return { result, port, state: url.searchParams.get("state") }
}

/** A key POST shaped the way the studio sends it. */
function postKey(port: number, state: string | null, apiKey: string): Promise<Response> {
  return post(port, { apiKey, state, userId: "u", userName: "n", keyName: "k" })
}

/**
 * Count of armed timers — the probe for the never-cleared callback budget
 * (issue #145). A budget timer left armed after a successful login keeps the
 * event loop alive for whatever remains of it.
 */
function armedTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length
}

run([
  [
    "auth server receives the key POST",
    async () => {
      const authServer = await startAuthServer({ startPort: 0 })
      try {
        const response = await post(authServer.port, {
          apiKey: "user_abc",
          state: "st",
          userId: "u",
          userName: "n",
          keyName: "k",
        })
        assertEqual(response.status, 200)
        const callback = await authServer.waitForCallback
        assertEqual(callback.apiKey, "user_abc")
        assertEqual(callback.state, "st")
      } finally {
        authServer.server.close()
      }
    },
  ],

  [
    "auth server rejects missing fields",
    async () => {
      const authServer = await startAuthServer({ startPort: 0 })
      try {
        const response = await post(authServer.port, { apiKey: "user_abc" })
        assertEqual(response.status, 400)
      } finally {
        authServer.server.close()
      }
    },
  ],

  [
    "runAuthFlow returns AuthOAuthResult with working callback",
    async () => {
      const { result, port, state } = await arm()
      assertEqual(result.method, "auto")
      assert(result.url.includes("commandcode.ai"))
      assert(result.instructions.length > 0)
      const response = await postKey(port, state, "user_abc")
      assertEqual(response.status, 200)
      const outcome = await result.callback()
      assertEqual(outcome.type, "success")
      if (outcome.type === "success") assertEqual(outcome.key, "user_abc")
    },
  ],

  [
    "runAuthFlow times out to failed",
    async () => {
      const result = await runAuthFlow({ startPort: 0, timeoutMs: 30 })
      const outcome = await result.callback()
      assertEqual(outcome.type, "failed")
    },
  ],

  // --- issue #145: the callback budget gave up mid-login ---------------------

  [
    "the callback budget is human scale, and under the host's own ceiling (#145)",
    () => {
      // 15 s expired while the user was still signing in, so the server closed
      // before the studio could POST the key. OpenChamber in turn allows 15 min
      // for this exact route, so the plugin must stay the shorter of the two.
      assert(
        DEFAULT_AUTH_TIMEOUT_MS >= 300_000,
        `callback budget is not human scale: ${DEFAULT_AUTH_TIMEOUT_MS}ms`,
      )
      assert(
        DEFAULT_AUTH_TIMEOUT_MS < 15 * 60 * 1000,
        `callback budget outlives the host's route budget: ${DEFAULT_AUTH_TIMEOUT_MS}ms`,
      )
    },
  ],

  [
    "a POST arriving after the old 15 s budget still lands (#145)",
    async () => {
      const { result, port, state } = await arm()
      const callback = result.callback()
      // Deliberately longer than the budget that used to expire here: this is
      // the regression itself — the server has to still be listening when a
      // slow-but-normal login finally posts its key.
      await new Promise((resolve) => setTimeout(resolve, 16_000))
      const response = await postKey(port, state, "user_late")
      assertEqual(response.status, 200)
      const outcome = await callback
      assertEqual(outcome.type, "success")
      if (outcome.type === "success") assertEqual(outcome.key, "user_late")
    },
  ],

  [
    "a completed callback disarms the budget timer (#145)",
    async () => {
      const before = armedTimers()
      const { result, port, state } = await arm({ timeoutMs: 60_000 })
      await postKey(port, state, "user_timer")
      const outcome = await result.callback()
      assertEqual(outcome.type, "success")
      // An armed timer that outlived the login held the event loop open for the
      // rest of the budget — a five-minute hang on every successful connect.
      assertEqual(armedTimers(), before)
    },
  ],

  [
    "the v1 auth hook offers the API key method beside the browser flow (#145)",
    async () => {
      const entry = (await import("../src/plugin/index.js")) as { default: any }
      const hooks = await entry.default.server()
      const methods = hooks.auth.methods as Array<Record<string, unknown>>
      // Positional: hosts address methods by index, and the browser flow has to
      // stay the one a returning user lands on.
      assertEqual(methods[0]?.type, "oauth")
      assertEqual(typeof methods[0]?.authorize, "function")
      const api = methods.find((method) => method.type === "api")
      assert(api !== undefined, "no `api` method: hosts render no key prompt without one")
      assert(typeof api.label === "string" && api.label.length > 0)
      // Core returns early from `authorize` for non-oauth methods and the host
      // stores a pasted key through `auth.set` itself, so this would be dead.
      assertEqual(api.authorize, undefined)
    },
  ],
])
