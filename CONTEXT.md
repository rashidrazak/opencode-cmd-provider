# opencode-cmd-provider

Plugin + provider package that lets OpenCode use Command Code as a model provider.

## Language

**Model catalog**:
The list of models Command Code offers, as published in the command-code npm package's bundled models.md table (id, name, Context, Efforts, price) — the sole membership authority; every row ships.
_Avoid_: models list, model endpoint, offerings

**Snapshot**:
A copy of the Model catalog's membership bundled inside the plugin package, each row carrying its ship-bar fields (id, name, context length, costs, efforts); the runtime source of truth for which Command Code models exist.
_Avoid_: embedded catalog, static catalog, shipped list

**Auto-registration**:
The plugin making the `commandcode` provider and its models available to OpenCode without the user declaring them in `opencode.json`.
_Avoid_: config injection, zero-config, self-registration

**Provider specifier**:
The npm specifier Auto-registration registers for the `commandcode` provider
(`provider.commandcode.npm`): this package's own name plus the exact version of
the running plugin (e.g. `opencode-cmd-provider@1.7.4`), so OpenCode's
specifier-keyed package cache can never install a runtime provider from a
different release than the plugin that registered it. The bare package name is
the fallback when the version cannot be read; a user-declared value always
wins. On OpenCode v2 the same specifier is registered as the provider's
`package`, carrying v2's `aisdk:` prefix — v2's marker that a plugin supplies
the runtime SDK. See ADR-0009 and ADR-0010.
_Avoid_: npm field, provider package, version pin

**Host**:
An OpenCode process that loads the plugin: **v1** (the 1.18.x line, which calls
the default export's `server()` and consumes the returned hook map) or **v2**
(the 2.0.x line, which calls `setup(context)` and registers transforms). One
default export serves both; each Host reads only its own key, and the two
halves are independent implementations of the same capabilities rather than one
translating the other. The **TUI Host** is neither — it loads the `./tui` export
— and it splits the same way: v1 reads `{ id, tui(api) }` and renders the
snake_case `sidebar_content` slot, v2 reads `{ id, setup(context) }` and claims
the dot-separated `"sidebar.content"` path, reading the Deals payload from
`settings.cmd` rather than `options.cmd`. See ADR-0010.
_Avoid_: version, runtime, platform, shim

**Declared models**:
Models the user explicitly lists under `provider.commandcode.models` in `opencode.json` (v2: `providers.commandcode.models`), taking precedence over snapshot models.
_Avoid_: user models, custom models, overrides

**Catalog refresh**:
Updating the snapshot to match the Model catalog's membership (the models.md table); a package-table row removal prunes the snapshot immediately. Happens on plugin release, never at runtime.
_Avoid_: model sync, catalog update, live refresh

**Core**:
`provider.commandcode` auto-registration (v1: snapshot → `provider.commandcode.models`; v2: the same Snapshot → catalog `Model.Info` records), configurable display-name prefix (default `[CMD]`), `COMMANDCODE_API_KEY` auth, and `provider/*` streaming. Deals intelligence is not part of core.
_Avoid_: base provider, essential plugin

**Deals catalog**:
Per-model pricing intelligence extracted from the Command Code docs' React
Server Components (RSC) stream (`pricing-limits`, `plans/goat`, `plans/pro`
pages with an `rsc: 1` header): tier (`Open Source`/`Premium`),
benchmarks (intelligence, tok/s), deal discounts (`was`/`now` rates), peak/off-peak
windows, and GOAT/Pro monthly allowances. Bundled in `src/deals/catalog.ts`
and regenerated via `npm run refresh:deals` (live, with 5xx/network fallback
to the committed `tests/fixtures/rsc-*.txt` fixtures and loud 4xx failure;
offline via `-- --fixtures`).
Deals are a **subset of membership** (issue #132): a snapshot model with no
RSC/deals record ships core-only — enrichment skipped, a `deals pending —`
report logged, never an exit-1. The fixtures are re-captured on every
`npm run refresh` and by the daily catalog-refresh cron so they stay in sync
with the snapshot.
_Avoid_: pricing table, deal feed

**Deals intelligence**:
The deals catalog plus its enrichment (v1: `model.options.cmd`, `context_over_200k` cost; v2: `settings.cmd`, a 200k context cost tier) and its surfaces: the TUI sidebar panel and the `cmd_plan_summary` tool. A single excisable slice — removing it leaves core byte-identical.
_Avoid_: deals feature, pricing UI

**Plan identity**:
The Command Code plan an account holds (Go, GOAT, Pro, Pro (legacy), Max 10×,
Max 20×, Team Pro, Provider), resolved from an explicit pin (the `plan` tool
argument,
`COMMANDCODE_PLAN`, a per-call provider option) or from the account's billing
subscription, and **unknown** when neither resolves — never a default. Pro is
two SKUs: the current `individual-pro-v1` renders as Pro, while the
grandfathered, pre-reprice `individual-pro` renders as Pro (legacy) with its own
price, credits and windows (issue #162). The
vocabulary and alias table live in Core (`src/catalog/plans.ts`); transport
selection reads only the explicit pin, so a Go account reaches the legacy
endpoint through the plan-gate `403` fallback — the documented
`upgrade_required` envelope or the live `/messages` plan phrasing without a
code — and a stale-client version gate never counts as one (ADR-0011). A plan
summary also renders its **provenance**: the account the lookup answered for and
the credential rung behind it (Host connection, `COMMANDCODE_API_KEY`, legacy
file, or the pin), so a wrong-account answer is visible (ADR-0017).
_Avoid_: plan detection default, detected-guess plan

**Classification**:
The per-model reasoning capability (reasoning-capable or not, and whether
with explicit efforts), derived any-true-wins across the models.md efforts
entry, the `reasoning` flag on the docs' RSC slug records, and the models
page Caps Reasoning bit, and generated into `src/catalog/classification.ts`;
the runtime's reasoning metadata derives from it. Models with no evidence
anywhere ship in the visible `classification pending` bucket and behave as
non-reasoning until evidence arrives. Human input is limited to the
classification override map — used only when upstream's own surfaces
contradict each other, every entry carrying a written justification,
rendered into the refresh PR body. See ADR-0006 and ADR-0008.
_Avoid_: reasoning set, hand classification, capability set

**Capability facts**:
The generated per-model capability data for the Snapshot rows — reasoning
efforts and per-1M-token rates parsed from the models.md table (missing
cells resolved through the ordered enrichment ladders, each row carrying
its provenance), plus input modalities parsed from the command-code CLI
bundle — bundled in `src/catalog/facts.ts` and regenerated via
`npm run refresh:snapshot`. Classification is deliberately not a
capability fact: it is derived any-true-wins across three evidence
channels (see Classification), not parsed from the npm package alone.
_Avoid_: model metadata, feature flags, model config

**Enrichment source**:
The provider listing API, the docs' RSC slug records, the CLI bundle, and
the Command Code models page: supportive data that fills gaps and confirms
facts but never decides Snapshot membership, never wins a ship-bar field,
and never gates the refresh. Missing enrichment degrades to a visible
pending fallback (never a failure); a shipped row always traces to one
row of the source-authority table (see ADR-0008).
_Avoid_: fallback source, secondary catalog, metadata feed

**Release**:
A versioned publication of the package: a git tag `vX.Y.Z` matching the `package.json` version, a GitHub Release, and an npm publish. The catalog snapshot is regenerated before every release — a release never ships a stale snapshot.
_Avoid_: publish, deploy, ship (when meaning the whole publication)

**Display name**:
The name shown for a model in OpenCode's picker: the raw catalog name with the configurable display prefix (default `[CMD]`, e.g. `[CMD] Claude Sonnet 5`; `provider.commandcode.options.display_prefix` overrides it, empty string disables).
_Avoid_: label, model name, pretty name
