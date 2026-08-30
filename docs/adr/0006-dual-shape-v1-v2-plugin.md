# ADR-0006: Dual-shape plugin module for OpenCode v1 + v2

Date: 2026-08-30
Status: Accepted
Related: #102, #71, #72; opencode v2 beta (verified against beta-18684)

## Context

OpenCode v2 (beta) changed the plugin contract. The v2 runtime validates the
default export against an Effect schema and rejects the v1 module shape
`{ id, server }` with `SchemaError: Missing key at ["default"]["effect"] /
["default"]["setup"]` — the plugin silently fails to load and neither
auto-registration nor `/connect` runs. Loading the npm package by name into
v2 therefore kills the whole integration.

The v2-native surface is richer than v1's hook bag:

- `setup(context)` receives domain objects; `catalog.transform` exposes a
  draft whose `provider.update(id, fn)` **upserts** providers and whose
  `models` map accepts `Model.Info` records — this replaces the v1
  config-hook auto-registration, including real reasoning-effort variants
  (`{ id, settings: { reasoningEffort } }`) which the runtime merges into
  the call's `providerOptions` (replacing the v1 config `variants` map).
- An integration domain (`integration.transform`) registers auth methods:
  `env` (names) and `oauth` (studio flow). The runtime resolves the active
  connection into the model call.
- Provider `package` values carrying the `aisdk:` prefix route model
  resolution through `aisdk.hook("language")` instead of npm SDK loading;
  the hook sets `input.language` to a `LanguageModelV3`. This is the only
  zero-install seam for a provider that is not in models.dev.
- Tools register via `tool.transform` with JSON-schema `input`/`output` and
  `options: { codemode: false }` for first-class tools (Code-Mode-only
  tools lose their results on current betas).

Meanwhile the v1 user base (1.18.x) still loads `{ id, server }` and is
verified to tolerate the extra `setup` key (real 1.18.25 binary: v1 fires
`server`, ignores `setup`).

## Decision

1. **One package, dual-shape default export** `{ id, server, setup }` —
   no separate v2 package, no entry-point splitting. Both surfaces call the
   same registration/enrichment core (`src/plugin/core.ts`) so the model
   catalog (display names, limits, variants, modalities, costs) stays
   identical across generations. `src/plugin/models.ts` is gone; there is
   no compatibility shim (the repo is young, see ADR-0004 culture).

2. **v2 auto-registration via `catalog.transform`.** Transforms replay on
   every catalog rebuild, so the pass is idempotent: `provider.update`
   gap-fills name/package/activation only when unset (user entries win),
   models are added only when no declared model claims the key, and
   declared models are never modified — the same merge semantics as v1's
   `autoRegister` (ADR-0001).

3. **v2 inference via the `aisdk:` package seam.** The provider's `package`
   is set to `aisdk:commandcode`; `aisdk.hook("language")` builds the
   bundled `CommandCodeLanguageModel` with the runtime-resolved credential.
   The wire protocol, retry/abort, redaction, cost, and plan-resolution
   logic are unchanged — the v1 transport is reused as-is.

4. **v2 auth via `integration.transform`.** An `env` method exposes
   `COMMANDCODE_API_KEY` and an `oauth` method wraps the existing studio
   callback flow (`runAuthFlow`). Credential mirroring (ADR-0002 era) is
   unchanged for v1; on v2 the credential flows through the integration.

5. **Known beta limitation, documented not fought.** On beta-18684 the
   `aisdk.hook` seam can fail to resolve after service restarts
   (`Unsupported package for commandcode/<model>` even with the plugin
   loaded and the catalog populated — reproducible across fresh HOMEs in
   both npm-package and plugin-file install forms, and non-deterministic
   across boots of the same HOME). When the seam wires correctly, models
   register, the env credential flows into `options.apiKey`, variants
   reach `providerOptions`, and inference streams end-to-end (verified
   live with a probe plugin and with the real transport). This is an
   upstream v2 beta bug; the plugin keeps the contract-correct surface and
   the limitation is tracked in the CHANGELOG rather than papered over
   with a workaround.

## Consequences

- v2 users install the same package; models appear in `/models` with zero
  config, reasoning effort cycling works via real variants, and auth works
  through both env var and studio OAuth.
- The contract test now pins the dual-shape export so neither surface can
  silently regress.
- When v2 stabilizes, `server` can be dropped in a major release; the core
  is already generation-agnostic.
