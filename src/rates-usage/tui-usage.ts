// src/rates-usage/tui-usage.ts — the v1 TUI half of the sidebar panel's usage
// controller (issues #244, #245): the credential resolution and billing fetch
// that run inside the TUI process, plus the v1 loader over them.
//
// The controller itself — mount chain, throttle, countdown clock, backoff,
// last-good seeding — is host-agnostic and lives in `usage-panel.ts`, which
// this module re-exports so the TUI halves keep one import. The v2 TUI half and
// the desktop GUI half both load through the plugin-RPC bridge instead
// (`createUsageRpcLoader` in `usage-rpc.ts`): neither process can resolve the
// Host's credential, so the server half fetches with it (ADR-0020).
//
// The v1 chain, in this process: resolve the credential from the host state the
// input thunk reads *now*, then run the billing fetch with it. A missing
// credential answers the notice without a request; a failing client is the next
// rung, never an error (ADR-0015).
import { fetchUsageSnapshot, type FetchUsageOptions, type UsageScope } from "./usage.js"
import {
  resolveTuiCredential,
  type TuiCredentialOptions,
  type TuiCredentialV1Input,
} from "./tui-credential.js"
import type { UsageLoader } from "./usage-panel.js"

export type {
  UsageLoader,
  UsageLoadOutcome,
  UsageLoadRequest,
  UsagePanel,
  UsagePanelCache,
  UsagePanelClock,
  UsagePanelOptions,
  UsagePanelState,
} from "./usage-panel.js"
export { createUsagePanel } from "./usage-panel.js"

export interface V1UsageLoaderOptions {
  /** Credential-resolver inputs (env, auth-path and home overrides). */
  credential?: TuiCredentialOptions
  /** Fetch inputs (baseURL, fetch, env, catalog); the key/scope/signal/clock come from the load. */
  fetchOptions?: Omit<FetchUsageOptions, "apiKey" | "scope" | "onScope" | "signal" | "now">
}

/**
 * The v1 half's loader: the panel's own chain, in this process. It runs the
 * billing fetch with the credential the host state resolves at call time, so a
 * `/connect` or a provider re-registration between chains is observed.
 */
export function v1UsageLoader(
  input: () => TuiCredentialV1Input,
  options: V1UsageLoaderOptions = {},
): UsageLoader {
  return async (request) => {
    const credential = await resolveTuiCredential(input(), options.credential ?? {})
    if (credential === undefined) return { result: { state: "no-credential" } }
    let scope: UsageScope | undefined = request.scope
    const result = await fetchUsageSnapshot({
      ...options.fetchOptions,
      apiKey: credential.key,
      scope,
      previous: request.previous,
      onScope: (updated) => {
        scope = updated
      },
      onPartial: (partial) => {
        request.onPartial?.({ result: partial, provenance: credential.source })
      },
      signal: request.signal,
      now: request.now,
    })
    return {
      result,
      ...(scope === undefined ? {} : { scope }),
      provenance: credential.source,
    }
  }
}
