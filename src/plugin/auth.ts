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
/**
 * How long the browser flow may take before `callback()` gives up (issue #145).
 *
 * A real login — page load, sign-in, org/context pick, approve, key transfer —
 * is a human-scale operation, so the budget has to be too: at 15 s the timer
 * fired mid-login and closed the callback server before the studio could POST
 * the key, which surfaced as "The automatic transfer failed" in the studio and
 * as `ProviderAuthOauthCallbackFailed` in every host. Five minutes sits well
 * under OpenChamber's own 15-minute ceiling for this route, so the host never
 * times out first.
 */
export const DEFAULT_AUTH_TIMEOUT_MS = 300_000

function generateStateToken(): string {
  return randomBytes(32).toString("base64url")
}

export interface RunAuthFlowOptions {
  startPort?: number
  timeoutMs?: number
  /** Credential mirroring targets; pass `false` to disable mirroring. */
  mirror?: MirrorOptions | false
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
      "Complete the flow in your browser. If the automatic transfer fails, choose the API key method and paste the key Command Code shows, or set COMMANDCODE_API_KEY.",
    method: "auto",
    callback: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
        })
        const callback = await Promise.race([authServer.waitForCallback, timeout])
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
        return { type: "failed" }
      } finally {
        // Both exits release the listener *and* the budget timer. Leaving the
        // timer armed after a successful login held the event loop open for
        // whatever remained of the budget (issue #145) — invisible at 15 s,
        // a five-minute hang at the current one.
        clearTimeout(timer)
        authServer.server.close()
      }
    },
  }
}
