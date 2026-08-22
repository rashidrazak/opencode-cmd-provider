# opencode-cmd-provider

Plugin + provider package that lets OpenCode use Command Code as a model provider.

## Language

**Model catalog**:
The list of models Command Code offers (id, name, context length), as served by its provider API.
_Avoid_: models list, model endpoint, offerings

**Snapshot**:
A copy of the model catalog bundled inside the plugin package; the runtime source of truth for which Command Code models exist.
_Avoid_: embedded catalog, static catalog, shipped list

**Auto-registration**:
The plugin making the `commandcode` provider and its models available to OpenCode without the user declaring them in `opencode.json`.
_Avoid_: config injection, zero-config, self-registration

**Declared models**:
Models the user explicitly lists under `provider.commandcode.models` in `opencode.json`, taking precedence over snapshot models.
_Avoid_: user models, custom models, overrides

**Catalog refresh**:
Updating the snapshot to match the live model catalog; happens on plugin release, never at runtime.
_Avoid_: model sync, catalog update, live refresh

**Core**:
`provider.commandcode` auto-registration (snapshot → `provider.commandcode.models`), configurable display-name prefix (default `[CMD]`), `COMMANDCODE_API_KEY` auth, and `provider/*` streaming. Deals intelligence is not part of core.
_Avoid_: base provider, essential plugin

**Deals catalog**:
Per-model pricing intelligence scraped from the Command Code docs
(`pricing-limits`, `plans/goat`, `plans/pro`): tier (`Open Source`/`Premium`),
benchmarks (intelligence, tok/s), deal discounts (`was`/`now` rates), peak/off-peak
windows, and GOAT/Pro monthly allowances. Bundled in `src/deals/catalog.ts`
and regenerated via `npm run refresh:deals` (or offline from `tests/fixtures/*.html`).
The refresh **fails loudly (exit 1) when the scraped/fixture records lack a
snapshot model**, so a partial catalog can never be emitted silently — the
fixtures must stay in sync with the snapshot.
_Avoid_: pricing table, deal feed

**Deals intelligence**:
The deals catalog plus its enrichment (`model.options.cmd`, `context_over_200k` cost) and its surfaces: the TUI sidebar panel and the `cmd_plan_summary` tool. A single excisable slice — removing it leaves core byte-identical.
_Avoid_: deals feature, pricing UI

**Release**:
A versioned publication of the package: a git tag `vX.Y.Z` matching the `package.json` version, a GitHub Release, and an npm publish. The catalog snapshot is regenerated before every release — a release never ships a stale snapshot.
_Avoid_: publish, deploy, ship (when meaning the whole publication)

**Display name**:
The name shown for a model in OpenCode's picker: the raw catalog name with the configurable display prefix (default `[CMD]`, e.g. `[CMD] Claude Sonnet 5`; `provider.commandcode.options.display_prefix` overrides it, empty string disables).
_Avoid_: label, model name, pretty name
