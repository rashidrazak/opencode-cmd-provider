# ADR-0001: Auto-registration via bundled model snapshot

Status: accepted

> **Status note (issue #135).** The membership half of this decision is
> **superseded by [ADR-0008](0008-models-md-primary-catalog.md)**: the
> Snapshot's membership comes from the npm package models.md table (every
> row ships), not the provider listing API. The mechanism halves stand
> unchanged — config-hook injection, declared-model merge semantics (user
> entries win and survive, including retired models), the `[CMD]` display
> prefix, and the `COMMANDCODE_API_KEY` env declaration. This ADR keeps
> its original text so the decision history stays readable.

> **Status note (issue #152).** The registered `npm` value is now
> **version-pinned** — the package's own name plus the exact version from the
> shipped `package.json` — see
> [ADR-0009](0009-version-pinned-provider-specifier.md) for why: opencode's
> package cache is keyed by the exact specifier and never refreshed, so the
> bare name let the runtime provider drift away from the plugin that
> registered it. The mechanism halves of this ADR stand unchanged.

OpenCode only fires a plugin's `provider.models` hook for providers present in its
models.dev catalog, and `commandcode` is not in that catalog — so users had to declare
every model by hand in `opencode.json`, which was the plugin's biggest UX wart. We decided
to bundle a snapshot of the Command Code model catalog in the package and have the plugin
inject the whole `provider.commandcode` entry (npm, name, models) into OpenCode's config
during the `config` hook, which OpenCode runs before it parses `config.provider`
(verified against OpenCode 1.18.18 source). Users no longer declare anything.

## Considered Options

- **Live catalog fetch on plugin load (pi's approach)** — would delay every OpenCode
  startup, needs a cache, and fails cold. Rejected for simplicity; git history keeps the
  fetch/cache code if live refresh ever returns.
- **models.dev PR** — would make the `provider.models` hook fire natively, but the
  catalog is not in our control and acceptance is unbounded. Revisit later if it ever
  lands; no code needed then.
- **OpenCode v2 catalog-transform API** — can create providers from scratch, but is wired
  to the new app, not the CLI provider path in 1.18.18. Not usable today.

## Consequences

- Snapshot is refreshed at every release (plus on-demand PRs); models Command Code adds
  between releases are invisible until the next release — the accepted staleness trade-off.
- The network machinery (`loadCommandCodeModels`, cache file, `provider.models` hook,
  `catalogToOpenCodeModels`) is deleted; the snapshot is the only model source.
- Auto-registration merges with user declarations: user entries and provider-level keys
  win, snapshot fills only what's missing; `whitelist`/`blacklist` still filter snapshot
  models.
- Model display names use a configurable prefix (default `[CMD]`; `options.display_prefix` on the declared entry overrides it, empty string disables).
- The registered entry declares `env: ["COMMANDCODE_API_KEY"]`, so setting the env var
  marks the provider connected in `/models`.
- With no opt-out, users control picker clutter via `whitelist`/`blacklist` on a declared
  `provider.commandcode` entry.
- First-run default model is deterministically `commandcode/gpt-5.6-terra` (OpenCode's
  hardcoded priority list + id-desc sort); no provider-scoped default mechanism exists.
