# ADR-0020: The TUI host resolves its own usage credential

Status: accepted

The sidebar's live `Usage` segment (issue #241) reads the billing endpoints the
official CLI's `/usage` overlay reads, and those reads need the account's
credential. The TUI host is a third process (ADR-0010) — it loads the `./tui`
export, not the server plugin — so the ADR-0015 seam that hands a server tool
the Host's own credential is unreachable from it: there is no plugin context,
no `connection.active()`, no tool registration. The panel therefore resolves
the credential itself, per TUI half, from the client-local state that half
already holds (issue #243).

## The decision

**One resolver serves both TUI halves — `resolveTuiCredential` in
`src/deals/tui-credential.ts` — returning `{ key, source }`, where `source` is
display-only provenance limited to the usage module's three rungs (Host
connection / `COMMANDCODE_API_KEY` / a legacy file's label). The host's own
rung comes first, the package ladder below it; when nothing resolves the
resolver is `undefined`, callers render the one-line notice, and no request is
made.**

The per-host rungs:

- **v1 TUI** reads the provider record the TUI state already holds
  (`api.state.provider`) with the structural `options.apiKey ?? key` read — the
  same public-but-untyped order ADR-0015 verified server-side. When that record
  carries neither field at runtime, the resolver falls back to the TUI's own
  client (`api.client.provider.list()`), the payload read the server-side
  `hostCredentialFromV1` makes. Either path reports `host` provenance: the
  record's own `source` field cannot stand in for provenance (the final config
  re-apply stamps `"config"` on every config-declared provider), and the plan
  summary's env/store distinction is deliberately not carried — this panel's
  three display rungs collapse the Host's own resolution into one.
- **v2 TUI** reads the `commandcode` provider's `integrationID` → the
  client-local integration record (`ctx.data.location.integration`) → its
  active connection. The Host projects `connections` in its own resolution
  order — stored credentials first, then the env methods whose variable is
  actually set — and `connection.active()` is `[0]`, so only the first
  connection is the one the session streams with. The reachable branch is the
  env one: the resolver reads `process.env[name]` for the connection's own
  `name`, the same read the Host's `connection.resolve()` performs.
- **Below both**, the package ladder (`resolveApiKeyWithSource`):
  `COMMANDCODE_API_KEY`, then the legacy auth files, keeping the file label as
  provenance and the key out of the source.

Three rules travel with the seam:

1. **Unreachable never means guessed.** A credential-type connection, a missing
   record, a failing client, an unset variable — each is the next rung, and
   then `undefined`; callers make no request (ADR-0011, ADR-0015 rule 2).
2. **The key is never rendered.** `source` is display data only; no resolution
   path logs or renders key material, and the file rung's label names the
   store, not the account.
3. **Read per call, never cached at plugin load.** The host's state is live
   (`/connect`, env changes, a provider re-registration), so the resolver
   consults it when the panel asks, not when the module loads.

## The v2 limitation

A credential stored only in OpenCode's v2 credential store is unreachable from
the TUI host: the store's value travels from `connection.resolve()` into the
provider SDK only, and the client-local data exposes the connection's identity
(`{ type: "credential", id, label }`) but never its value. When that connection
is active, the v2 rung therefore yields `undefined` and a store-only account
renders the documented notice — `Usage needs COMMANDCODE_API_KEY — set it to
see live limits` — rather than a guessed account's numbers.

The mixed case (a stored credential _and_ a live `COMMANDCODE_API_KEY`) is
handled by the same ordering the Host applies: the stored credential is active,
so the v2 rung yields nothing, and the package ladder below answers with the
environment rung — the panel then shows the env account's figures explicitly
labeled `via COMMANDCODE_API_KEY`. That is the ADR-0017 trade applied one level
down: a fallback answer is visible and named, never silent, and the notice is
reserved for the case where nothing resolves. Making the v2 store reachable is
explicitly out of scope (#241).

## Verification

- **v1.18.30.** `Provider.toPublicInfo` strips neither `key` nor `options`
  (`provider/provider.ts`), and the TUI sync store seeds `state.provider` from
  `config.providers` → `toPublicInfo` (`packages/tui/src/context/sync.tsx`), so
  the state record carries both fields at runtime; `api.client` reaches the
  same `/provider` payload, so the fallback reads the identical shape.
- **v2.0.3 through 2.0.18.** `Integration.Info` carries
  `connections: ConnectionInfo[]` with `ConnectionEnvInfo = { type: "env"; name }`
  and `ConnectionCredentialInfo = { type: "credential"; id; label }`, and
  `Provider.Info.integrationID` links a provider to its integration
  (`@opencode/client` types; `2.0.18` adds an unused `method` field to the
  credential arm, so only members common to the line are mirrored in
  `src/plugin/v2-tui-types.ts`). The Host's `resolveConnections`
  (`packages/core/src/integration.ts` at v2.0.3) builds `connections` as
  credentials-then-live-env and `active()` returns `[0]`, which is the ordering
  this resolver mirrors.
- `tests/tui-credential.test.ts` pins every rung with mock inputs — v1
  `options.apiKey` / `key` / neither plus the client fallback, the v2 env
  connection (including a non-`COMMANDCODE_API_KEY` name), the credential-type
  and mixed cases, the environment and file rungs, structural degradation, and
  the key-free source requirement — with no network and no TUI runtime.

## Consequences

- The panel answers for the credential the TUI half can actually see: the v1
  state record, or the v2 host's active env connection; otherwise it says which
  fallback rung answered, or asks for `COMMANDCODE_API_KEY` (ADR-0017's
  wrong-account-visibility rule, one surface down).
- `src/plugin/v2-tui-types.ts` grows the `provider` / `integration` location
  slices and their connection types; the mirror keeps the same re-derivation
  obligation as the rest of the v2 context (ADR-0010).
- The resolver is TUI-only and host-agnostic: it imports no `solid-js` and no
  runtime `@opencode-ai/*`/`@opencode/*` module, so it stays out of the server
  bundle and is exercised by plain `tsx` tests.
