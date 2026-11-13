// src/rates-usage/usage-rpc-client.ts — the client half of the usage bridge
// (ADR-0020): the loader a host that cannot resolve the credential calls the
// plugin's own server half through. It is split from the registration
// (`usage-rpc.ts`) so a window bundle — the OpenCode Desktop GUI panel — can
// include it without the server's registration and fetch path.
//
// No credential resolution and no fallback exists here: the server half answers
// with the connected account or the notice, never another account's numbers.
// The wire contract and its parsers live in `usage-rpc-protocol.ts`.
import type { UsageLoadOutcome, UsageLoader, UsageLoadRequest } from "./usage-panel.js"
import {
  USAGE_RPC_DEFINITION,
  USAGE_RPC_PROGRESS,
  parseProgressEvent,
  parseUsageOutcome,
  type UsageRpcInput,
} from "./usage-rpc-protocol.js"

/** The RPC subclient slice a loader drives — the TUI's and the desktop GUI's. */
export interface UsageRpcClient {
  rpc(definition: unknown): {
    usage(input: unknown, callOptions?: { readonly signal?: AbortSignal }): Promise<unknown>
    events: {
      on(
        name: string,
        handler: (event: unknown) => void,
        options?: { readonly signal?: AbortSignal },
      ): () => void
    }
  }
}

/** The id prefix of one loader's `callId`s; per process, so events never cross. */
const CALL_ID_RUN = Math.random().toString(36).slice(2, 10)

/** The loader's call counter: unique within the process. */
let callSeq = 0

function nextCallId(): string {
  callSeq += 1
  return `${CALL_ID_RUN}-${callSeq}`
}

/**
 * The non-server halves' loader: one port call per chain, the request's cached
 * scope, last-good snapshot and `callId` in, the refreshed scope out, the
 * caller's abort signal joined to the RPC's own cancellation. While the call is
 * in flight a `progress` subscription (#251) forwards each landing leg's merged
 * view to `request.onPartial`. A host without the bridge, or a codec-mangled
 * answer, degrades to `unavailable` — never to a guessed account.
 */
export function createUsageRpcLoader(client: UsageRpcClient): UsageLoader {
  return async (request: UsageLoadRequest): Promise<UsageLoadOutcome> => {
    const port = client.rpc(USAGE_RPC_DEFINITION)
    const callId = request.onPartial === undefined ? undefined : nextCallId()
    /** Late progress must not overwrite the settled outcome. */
    let settled = false
    let unsubscribe: (() => void) | undefined
    if (callId !== undefined && typeof port.events?.on === "function") {
      unsubscribe = port.events.on(
        USAGE_RPC_PROGRESS,
        (event) => {
          if (settled) return
          const partial = parseProgressEvent(event, callId)
          if (partial !== undefined) request.onPartial?.(partial)
        },
        { signal: request.signal },
      )
    }
    try {
      const input: UsageRpcInput = {
        ...(request.scope === undefined ? {} : { scope: request.scope }),
        ...(request.previous === undefined ? {} : { previous: request.previous }),
        ...(callId === undefined ? {} : { callId }),
      }
      const output = await port.usage(input, { signal: request.signal })
      settled = true
      return parseUsageOutcome(output)
    } finally {
      settled = true
      unsubscribe?.()
    }
  }
}
