# ADR-0015: The plan summary uses the Host's credential, not a legacy file

Status: accepted

`cmd_plan_summary` has to answer for the account the session actually streams
with. It resolved its credential with `resolveApiKey()`, whose ladder
(`options.apiKey` → `COMMANDCODE_API_KEY` → the legacy auth files
`~/.commandcode/auth.json`, `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json`)
predates the v2 credential store and knows nothing about either Host's own
credential. On a machine with more than one Command Code account the tool
therefore answered for whichever account a legacy file happened to hold — a
different plan, a different billing subscription, and no sign that anything was
wrong (issue #201).

## Where each Host keeps the credential

- **v2.** The Host's store (`credential` table) is authoritative.
  `ModelResolver.load` resolves the provider's `integrationID` through
  `integration.connection.active()` → `connection.resolve()`, merges the value
  into the runtime model's settings, and hands it to the plugin only through
  `ctx.aisdk.hook("sdk")` → `event.options`. A tool is registered with
  `(input, context)` and never sees it. `connection.active()` prefers a stored
  credential over the env method, and `resolve()` reads the named environment
  variable itself for an `env` connection.
- **v1.** The resolved credential lands on the provider record as `key`, with
  the auth store outranking `COMMANDCODE_API_KEY`, and a config
  `options.apiKey` outranking both at model init (`options.apiKey ??= key`).
  The plugin's `PluginInput.client` reaches it: `GET /provider` serializes
  `key` and `options` unchanged. `source` is not provenance — the final config
  re-apply stamps `"config"` on every config-declared provider.

## Decision

**Both tool builders take an optional async host-credential getter, consulted
after an explicit `apiKey` and before the environment and the legacy files.**

```ts
planSummaryTool({ hostCredential }) // v1 — wired in a follow-up ticket
planSummaryV2Tool({ hostCredential }) // v2 — `hostCredentialFromV2(ctx)`
```

The seam is `PlanSummaryOptions.hostCredential` in the Deals slice; the type it
returns, `HostCredential { key, source }`, lives in Core
(`src/provider/auth-key.ts`) so that Core can produce it without importing the
slice (ADR-0004). The v2 producer is `hostCredentialFromV2` in
`src/plugin/v2.ts`: `connection.active(PROVIDER_ID)` → `connection.resolve()`,
per call rather than at registration, so a `/connect` mid-session is picked up.
The v1 producer will read `client.provider.list()` and take
`options.apiKey ?? key`, the same order the v1 Host applies at model init.

Four rules travel with the seam:

1. **Below the new rung the ladder is unchanged.** It mirrors
   `createCommandCode`'s own fallback, which is what the transport uses once a
   Host resolves no credential — so the tool and the transport agree in every
   case, not only when a credential exists.
2. **A Host that cannot answer costs nothing.** `undefined` and a rejection are
   the next rung, never an error and never a guessed account (ADR-0011).
3. **A pinned plan never asks.** The `plan` argument and `COMMANDCODE_PLAN`
   short-circuit before the getter, keeping a pinned summary free of both the
   network and the Host round-trip (ADR-0011 §2).
4. **The key is never rendered.** `source` is display provenance — `"host"`,
   `"environment"` or `"config"` — and the summary's output stays key-free.

## Consequences

- The reported plan now follows the credential the provider SDK receives: on
  v2, the very key `connection.active()` → `resolve()` yields for
  `ModelResolver`; on v1, `options.apiKey ?? key` from the Host's own record.
- The v2 mirror gains `IntegrationDomain.connection` (`v2-types.ts`, ADR-0010).
  It has been byte-identical from `2.0.0` through `2.0.8`; a host without it
  degrades through rule 2 rather than failing the tool.
- The v1 seam is a public-but-untyped field: the SDK's generated `/provider`
  response type omits `key` and `options` even though the runtime payload
  carries them, so the read is structural and must degrade if upstream ever
  tightens it — to the documented ladder, not to a crash.
- Rendering the account identity and the credential source is a separate
  decision (ticket #205); this ADR only fixes which credential is asked.
