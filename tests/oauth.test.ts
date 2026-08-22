// tests/oauth.test.ts — auth server + /connect browser flow (PLAN #10, port of
// pi's test-oauth.ts server flow + state handling)
import { startAuthServer } from "../src/plugin/auth-server.js"
import { runAuthFlow } from "../src/plugin/auth.js"
import { assert, assertEqual, run } from "./harness.js"

function post(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
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
      const result = await runAuthFlow({ startPort: 0, mirror: false })
      assertEqual(result.method, "auto")
      assert(result.url.includes("commandcode.ai"))
      assert(result.instructions.length > 0)
      const port = Number(
        new URL(result.url).searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1],
      )
      const response = await post(port, {
        apiKey: "user_abc",
        state: new URL(result.url).searchParams.get("state"),
        userId: "u",
        userName: "n",
        keyName: "k",
      })
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
])
