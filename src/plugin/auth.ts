// src/plugin/auth.ts — opencode /connect auth flow (PLAN #10)
//
// Wraps the local callback server in the opencode AuthOAuthResult shape:
// the studio URL is opened in the browser, the studio POSTs the API key to
// the local /callback endpoint, and callback() resolves with the key.
import { randomBytes } from "node:crypto"
import { startAuthServer } from "./auth-server.js"
import type { AuthOAuthResult } from "@opencode-ai/plugin"

const STUDIO_BASE_URL = "https://commandcode.ai"
const DEFAULT_AUTH_TIMEOUT_MS = 15_000

function generateStateToken(): string {
  return randomBytes(32).toString("base64url")
}

export interface RunAuthFlowOptions {
  startPort?: number
  timeoutMs?: number
}

export async function runAuthFlow(options: RunAuthFlowOptions = {}): Promise<AuthOAuthResult> {
  const authServer = await startAuthServer({ startPort: options.startPort })
  const stateToken = generateStateToken()
  const callbackUrl = `http://localhost:${authServer.port}/callback`
  const url = `${STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS

  return {
    url,
    instructions:
      "Complete the flow in your browser. If automatic transfer fails, set COMMANDCODE_API_KEY to the API key shown by Command Code.",
    method: "auto",
    callback: async () => {
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        )
        const callback = await Promise.race([authServer.waitForCallback, timeout])
        authServer.server.close()
        if (callback.state !== stateToken) return { type: "failed" }
        return { type: "success", key: callback.apiKey }
      } catch {
        authServer.server.close()
        return { type: "failed" }
      }
    },
  }
}
