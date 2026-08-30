// src/plugin/auth.ts — opencode /connect auth flow (PLAN #10)
//
// Wraps the local callback server in the opencode AuthOAuthResult shape:
// the studio URL is opened in the browser, the studio POSTs the API key to
// the local /callback endpoint, and callback() resolves with the key.
// On success the credential is also mirrored under "command-code" (see
// auth-mirror.ts) so ecosystem consumers such as OpenChamber's quota
// provider can find it.
import { randomBytes } from "node:crypto"
import { startAuthServer } from "./auth-server.js"
import { mirrorCredential, type MirrorOptions } from "./auth-mirror.js"
import type { AuthOAuthResult } from "@opencode-ai/plugin"

const STUDIO_BASE_URL = "https://commandcode.ai"
const DEFAULT_AUTH_TIMEOUT_MS = 15_000

function generateStateToken(): string {
  return randomBytes(32).toString("base64url")
}

export interface RunAuthFlowOptions {
  startPort?: number
  timeoutMs?: number
  /** Credential mirroring targets; pass `false` to disable mirroring. */
  mirror?: MirrorOptions | false
}

/** The flow always returns the `method: "auto"` variant of the opencode auth
 * result; the narrowed alias lets callers invoke `callback()` without
 * discriminating the union (the `method: "code"` variant requires an
 * argument). */
export type AutoAuthFlowResult = Extract<AuthOAuthResult, { method: "auto" }>

export async function runAuthFlow(options: RunAuthFlowOptions = {}): Promise<AutoAuthFlowResult> {
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
        if (options.mirror !== false) {
          try {
            mirrorCredential(callback.apiKey, options.mirror ?? {})
          } catch {
            // Mirroring is best-effort; it must never fail the login itself.
          }
        }
        return { type: "success", key: callback.apiKey }
      } catch {
        authServer.server.close()
        return { type: "failed" }
      }
    },
  }
}
