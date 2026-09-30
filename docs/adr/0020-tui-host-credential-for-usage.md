# ADR-0020: The TUI host resolves its usage credential

Status: accepted

The sidebar's live `Usage` segment (issue #241) reads the billing endpoints the
official CLI's `/usage` overlay reads, and those reads need the account's
credential. The TUI host is a third process (ADR-0010) — it loads the `./tui`
export, not the server plugin — so the ADR-0015 seam that hands a server tool
the Host's own credential is unreachable from it _directly_: there is no plugin
context, no `connection.active()`, no tool registration. Each TUI half
therefore gets the credential through the deepest read it can make (issue
#243): the v1 TUI reads the provider record its state already carries; the v2
TUI asks its own package's server half over the Host's plugin-RPC bridge.

## The decision

**v2 registers one plugin-RPC port from the server half — `registerUsageRpc` in
`src/rates-usage/usage-rpc.ts`, id `commandcode`, method `usage` — whose handler
resolves the Host's active connection credential through the same ADR-0015
seam the plan tool uses, runs the billing fetch itself, and returns only
display data: the snapshot, the refreshed scope, and the rung. The TUI half
calls it through its own client (`ctx.client.rpc(definition)`). No credential
is resolved in the TUI process for v2, and no fallback is consulted: the
bridge answers for the connected account or not at all. The v1 TUI keeps its
in-process resolution — the provider record, then the package ladder.**

### The v1 resolution

- **v1 TUI** reads the provider record the TUI state already holds
  (`api.state.provider`) with the structural `options.apiKey ?? key` read — the
  same public-but-untyped order ADR-0015 verified server-side, whose fields the
  v1 host serializes without stripping. When that record carries neither field
  at runtime, the resolver falls back to the TUI's own
  `api.client.provider.list()` — the payload read the server-side
  `hostCredentialFromV1` makes. Either path reports `host` provenance: the
  record's own `source` field cannot stand in for provenance (the final config
  re-apply stamps `"config"` on every config-declared provider), and the plan
  summary's env/store distinction is deliberately not carried — this panel's
  display rungs collapse the Host's own resolution into one.
- **Below the v1 rung**, the package ladder (`resolveApiKeyWithSource`):
  `COMMANDCODE_API_KEY`, then the legacy auth files, keeping the file label as
  provenance and the key out of the source. The ladder survives for v1 because
  it mirrors the transport's own last resort: when the v1 host resolved
  nothing, the provider factory reads those same places, so a ladder answer is
  what would actually stream.

### The v2 bridge

- **The port.** The definition is a plain JSON-Schema object (no runtime
  `@opencode/*` import), so both bundles load the module. The handler runs per
  call: `hostCredentialFromV2(ctx)` — stored credentials first, the env method
  when no credential row exists — then `fetchUsageSnapshot` with that key. A
  `/connect` mid-session is observed because the getter is never cached
  (ADR-0015's per-call rule).
- **Why the fetch moves server-side.** A port that _returned the key_ would
  expose credentials over a generic route (`POST /api/rpc/{rpcID}/{method}`,
  callable by any local HTTP client). Fetching server-side keeps the key where
  it already lives; only the numbers travel — and the TUI half parses even
  those defensively, as untrusted wire data.
- **No fallback.** When no connection resolves, the handler answers
  `no-credential` and the panel renders the notice. v2 never consults the
  package ladder: with a stored credential active the Host will not stream
  with env/legacy credentials, so those belong to a _different account by
  construction_ — never the answer.
- **Degradation.** An unreachable bridge (a host without `ctx.rpc`, a TUI-only
  install) is `unavailable`, exactly like a failed fetch; the panel keeps its
  last-good numbers, and nothing is guessed.

Three rules travel with the seam:

1. **Unreachable never means guessed.** A missing record, a failing client, an
   unset variable, a store-only credential, an unreachable bridge — each is the
   next rung where a rung exists (v1), or the notice/`unavailable` where none
   does (v2); callers make no billing request without a credential (ADR-0011,
   ADR-0015 rule 2).
2. **The key is never rendered — nor, on v2, transported.** `source` is display
   data only; no resolution path logs or renders key material, and the v2
   payload carries no credential at all.
3. **Read per call, never cached at plugin load.** The host's state is live
   (`/connect`, env changes, a provider re-registration): the v1 input thunk is
   read when the panel asks, and the v2 port's credential getter runs per RPC
   call.

## Verification

- **v1.18.30.** `Provider.toPublicInfo` strips neither `key` nor `options`
  (`provider/provider.ts`), and the TUI sync store seeds `state.provider` from
  `config.providers` → `toPublicInfo` (`packages/tui/src/context/sync.tsx`), so
  the state record carries both fields at runtime; `api.client` reaches the
  same `/provider` payload, so the fallback reads the identical shape.
- **v2.0.3 through 2.0.20.** The server context carries `rpc`
  (`RpcDomain.register`) in every release checked (`@opencode/plugin` 2.0.3,
  2.0.19, 2.0.20), and the TUI context carries `client: OpenCodeClient` — the
  `client.rpc(definition)` subclient factory — from 2.0.3 through 2.0.20. The
  cross-plugin call path is documented API (opencode v2 docs, _Plugin RPC_): a
  registered port "can be called over HTTP or from another plugin", and a TUI
  plugin builds the subclient from `context.client`. The wire route is
  `POST /api/rpc/:rpcID/:method` (`@opencode/protocol`'s `RpcGroup`).
- `tests/tui-credential.test.ts` pins the v1 rungs and the ladder;
  `tests/usage-rpc.test.ts` pins the port definition, the handler (host
  credential → fetch, key-free payload, no-credential → zero requests) and the
  loader's defensive parse; `tests/plugin-v2.test.ts` pins the entrypoint
  registering exactly one port.

## Consequences

- The v2 panel answers for the account the session streams with — the same
  credential `cmd_plan_summary` resolves. The "v2 limitation" this ADR first
  documented (a store-only credential rendering the notice, the mixed case
  rendering the env account labelled) is gone: both now render the connected
  account's real usage.
- The bridge is the package's first server↔TUI channel. `setupCommandCode`
  grew an `rpc` extension seam; deleting the Rates & usage slice removes the port with
  it, and `src/rates-usage/usage-rpc.ts` stays free of runtime host imports so both
  bundles can load it.
- `src/plugin/v2-tui-types.ts` no longer mirrors provider/integration payloads;
  it mirrors the client's RPC slice instead. The re-derivation obligation
  (ADR-0010) is unchanged.
- The v1 TUI is untouched by the bridge: its record already carries the
  host-resolved credential, and its ladder fallback stays — it is what the v1
  transport itself would fall back to.
