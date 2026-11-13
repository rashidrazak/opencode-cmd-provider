// src/rates-usage/usage-rpc.ts — the usage bridge between the plugin's own v2
// halves (ADR-0020, issue #243 amendment). The v2 Host keeps the connected
// account's credential in its own store: the provider payload no longer
// carries it and the TUI context has no connection service, so the TUI half
// cannot read it — but the *server* half can, through the same
// `ctx.integration.connection` seam `cmd_plan_summary` uses. This module is
// that seam's one sanctioned relay:
//
//   server half  `ctx.rpc.register` — a portable plugin-RPC port whose
//                handler resolves the Host's active connection credential
//                (host-credential getter passed by src/plugin/index.ts) and
//                runs the billing fetch with it. Only display data leaves: the
//                snapshot, the refreshed scope, the rung — plus, since #251,
//                one `progress` event per landing leg when the caller sends a
//                `callId` to correlate them;
//   TUI half     `ctx.client.rpc(definition)` — the same port, called with
//                the panel's cached scope, last-good snapshot and abort
//                signal, subscribed to `progress` while the call is in flight.
//                No credential resolution happens in the TUI process for v2,
//                and no fallback exists: when the server half has no connected
//                credential the answer is the notice, never another account.
//
// The same port and the same TUI-side loader serve the OpenCode Desktop GUI
// panel (src/rates-usage/gui/panel.tsx): a desktop window has no connection
// service either, so it calls the port through its own `ctx.client.rpc`, and
// the server half — the desktop app's own background server, which already
// loads the plugin — answers with the same fetch. The wire contract and its
// parsers live in `usage-rpc-protocol.ts` so neither client pulls the server's
// fetch path into its bundle.
//
// The module imports no runtime `@opencode/*` (the port's definition is a
// plain JSON-Schema object) and no TUI runtime.
import type { HostCredential } from "../provider/auth-key.js"
import { isRecord, stringValue } from "../provider/converters.js"
import type { V2RpcCallContext, V2RpcRegistration, V2SetupContext } from "../plugin/v2-types.js"
import type { UsageLoader } from "./usage-panel.js"
import {
  USAGE_RPC_DEFINITION,
  USAGE_RPC_PROGRESS,
  parseScope,
  parseSnapshot,
} from "./usage-rpc-protocol.js"
import { createUsageRpcLoader, type UsageRpcClient } from "./usage-rpc-client.js"
import {
  fetchUsageSnapshot,
  type FetchUsageOptions,
  type UsageCredentialSource,
  type UsageScope,
} from "./usage.js"

export {
  USAGE_RPC_DEFINITION,
  USAGE_RPC_ID,
  USAGE_RPC_METHOD,
  USAGE_RPC_PROGRESS,
} from "./usage-rpc-protocol.js"
export type { UsageRpcInput, UsageRpcOutcome } from "./usage-rpc-protocol.js"
export { createUsageRpcLoader, type UsageRpcClient } from "./usage-rpc-client.js"

/** Injection seams for the registration's tests (the transport is the host's). */
export interface UsageRpcRegistrationOptions {
  fetchOptions?: Omit<
    FetchUsageOptions,
    "apiKey" | "scope" | "onScope" | "onPartial" | "previous" | "signal"
  >
}

/**
 * Registers the usage port on the server half. The getter is the same
 * `hostCredentialFromV2(ctx)` the plan tool receives (ADR-0015): read per call,
 * stored credentials included, so a `/connect` mid-session is observed. The
 * registration's event channel (#251) carries one `progress` event per landing
 * leg for callers that sent a `callId`.
 */
export async function registerUsageRpc(
  ctx: V2SetupContext,
  hostCredential: () => Promise<HostCredential | undefined>,
  options: UsageRpcRegistrationOptions = {},
): Promise<void> {
  // The handler emits through the registration, which only exists after
  // `register` resolves — and the handler can only run after that.
  let registration: V2RpcRegistration | undefined
  const handler = async (input: unknown, context: V2RpcCallContext) => {
    const credential = await hostCredential()
    if (credential === undefined) return { result: { state: "no-credential" } }
    const request = isRecord(input) ? input : undefined
    const callId = stringValue(request?.callId)
    // The Host service distinguishes its env method from its store; both are
    // the Host's own resolution and collapse into the panel's host rung, with
    // the env method keeping its named rung.
    const provenance: UsageCredentialSource =
      credential.source === "environment" ? { kind: "environment" } : { kind: "host" }
    let scope = parseScope(request?.scope)
    const result = await fetchUsageSnapshot({
      ...options.fetchOptions,
      apiKey: credential.key,
      scope,
      previous: parseSnapshot(request?.previous),
      onScope: (updated) => {
        scope = updated
      },
      onPartial: (partial) => {
        if (callId === undefined) return
        // Deliver the merged view as the leg lands; a progress event must
        // never fail or delay the call itself.
        void registration?.events
          .emit(USAGE_RPC_PROGRESS, { callId, result: partial, provenance })
          .catch(() => {})
      },
      signal: context.signal,
    })
    return {
      result,
      ...(scope === undefined ? {} : { scope }),
      provenance,
    }
  }
  registration = await ctx.rpc.register(USAGE_RPC_DEFINITION, { usage: handler })
}
