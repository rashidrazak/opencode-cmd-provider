# Changelog

## 1.6.1 - 2026-08-29

Patch release. Catalog refresh to `command-code@1.38.1`, one catalog
classification re-pin, and two CI fixes for the daily catalog-refresh cron.

- **Catalog refresh** — snapshot + capability facts + RSC fixtures refreshed
  to `command-code@1.38.1` (was 1.37.0). Net: 30 → 31 effort entries;
  `tencent/hy4-preview` is the new row (Efforts column now lists
  `low, medium, high`, was empty in 1.37.0). The 62 cost rows are unchanged.
  The deals catalog is unaffected (the new model already had its RSC
  availability + deal info in 1.37.0 fixtures). A follow-up 2026-08-29 cron
  re-captured the RSC fixtures and refreshed `src/catalog/facts.ts` to
  upstream's new values.
- **Catalog classification** — `tencent/hy4-preview` re-pinned to
  `EFFORTS_MODELS` in `src/catalog/facts.ts`; the prior
  `REASONING_MODELS` classification was a labelling error in 1.6.0 (upstream
  advertises it as an effort-controlled model, not a reasoning model). The
  matching unit-test pin was updated in lockstep.
- **CI: catalog-refresh heredoc** — `realpath` the relative `.ts` path
  before the `npx tsx -e` heredoc in `.github/workflows/catalog-refresh.yml`.
  The `after` loop passed a bare-relative path (e.g. `src/catalog/snapshot.ts`)
  to the heredoc, which Node's ESM resolver parsed as a package name and
  rejected with `ERR_MODULE_NOT_FOUND`. The `before` loop was unaffected
  because it used `/tmp/...` absolute paths. Locked down with
  `tests/catalog-refresh-extract.test.ts`.
- **CI: catalog-refresh push** — force-push the `catalog-refresh/${date}`
  branch in `.github/workflows/catalog-refresh.yml`. Two consecutive cron
  runs on the same day land sibling commits on `main`'s HEAD; `git push -u`
  then rejects as non-fast-forward, leaving the cron stuck. `-fu` handles
  both the partial-failure rerun and the fresh-branch case; the branch is
  owned only by this workflow, so there's no clobber risk. The
  `Open PR` step's `gh pr list --head X` already copes correctly with a
  force-pushed tip. Locked down with
  `tests/catalog-refresh-push.test.ts`.
- **Test fix for the push test** — `tests/catalog-refresh-push.test.ts`'s
  verification `git ls-remote` previously ran from the outer project
  CWD, so it resolved `origin` to GitHub rather than the test's local
  bare remote. It passed only on the day the matching
  `catalog-refresh/${date}` branch happened to exist on GitHub. Now
  passes `-C repo.work` so the `origin` resolution is scoped to the
  test fixture.

## 1.6.0 - 2026-08-28

### Deals pipeline: RSC-primary + daily catalog refresh cron

The deals catalog is no longer scraped from HTML tables — it is generated from
the Command Code docs site's React Server Components (RSC) stream (the docs
pages fetched with an `rsc: 1` header; see ADR-0005). The HTML live fetch and
HTML fixtures are gone; `scripts/parse-docs.mjs` keeps its parsers as a
documented air-gapped fallback.

- **RSC parser** — `scripts/parse-rsc.mjs` with committed fixtures
  (`tests/fixtures/rsc-{pricing-limits,goat,pro}.txt`), shape-pinning unit
  tests, a slug-id→snapshot-id alias map, and the shared depth-state-machine
  extracted to `scripts/json-stream.mjs`.
- **Tier overrides** — `scripts/tier-overrides.mjs` pins the 7 known Command
  Code tier-categorization disagreements to `opensource` so TUI badges stay
  stable.
- **Daily cron** — `.github/workflows/catalog-refresh.yml` (06:00 UTC +
  `workflow_dispatch`) regenerates snapshot/facts/fixtures/deals, builds,
  tests, and opens a `chore: catalog refresh` PR (body via
  `scripts/diff-catalog.mjs`) only when upstream moved; silent exit when
  nothing drifted.
- **Fixture lockstep** — `npm run refresh` now re-captures the RSC fixtures
  from the live docs pages (`scripts/capture-rsc-fixtures.mjs`) before
  regenerating the deals catalog, so fixtures, catalog, and tests stay
  consistent. Standalone `refresh:deals` falls back to fixtures on 5xx/network
  and fails loudly on 4xx.
- **Catalog refresh** — deals/snapshot/facts refreshed to
  `command-code@1.37.0` (new: `tencent/hy4-preview`, classified
  reasoning-capable without explicit efforts); benchmark pins updated to
  upstream's new values (Gemini 3.7 Flash, MiniMax M3).
- **Fixes** — live RSC URLs corrected (the `/docs/rsc/*` draft routes 404 on
  the real site); the cron now builds before testing (the pack contract test
  needs `dist/` in a fresh checkout); 4xx RSC responses fail loudly instead of
  silently falling back to fixtures.
- **Follow-ups** — open decisions tracked in issues #89 (shape-pinning value
  pins) and #90 (expired-deal filtering).

## 1.5.2 - 2026-08-28

Chore: catalog refresh to `command-code@1.36.0`, with a deals-coverage gate
fix for name-colliding free variants.

- Added `z-ai/glm-5.3-flash` (GLM-5.3 Flash) and `Qwen/Qwen3.8-Flash` with
  deals records; removed `stealth/ox-alpha` (dropped from the upstream
  catalog).
- MiniMax free variants (`minimax/minimax-m3-free`,
  `minimax/minimax-m2.7-free`) now append `(free)` to their picker display
  name — upstream renamed them to share the paid display name — derived
  data-driven from the zero-cost table, with updated deal allowance pricing
  for `deepseek/deepseek-v4-flash-vision-exp`.
- The deals-coverage gate now iterates every snapshot entry by id, so free
  variants whose display names collide with paid siblings are actually
  coverage-checked (a fixture that silently dropped them previously passed
  with exit 0 and emitted a partial deals catalog); a shared
  `scripts/snapshot-index.mjs` parser replaced the duplicated regex parsing.

### Fixes

- **Deals-coverage gate**: `check-deals-coverage.mjs` and the
  `missingDealsModels` check in `refresh-deals.mjs` iterated a first-wins
  name→id map, so MiniMax free variants — whose snapshot display names
  collide with their paid siblings — were never actually checked. Both gates
  now iterate by id, with the name fallback applying only to unambiguous
  names; records that resolve to no snapshot id are skipped instead of
  collapsing under `undefined`.
- Catalog refresh to `command-code@1.33.0` added the MiniMax free variants;
  the `1.36.0` refresh added GLM-5.3 Flash and Qwen 3.8 Flash, dropped Ox
  Alpha, and extended `src/plugin/models.ts` with the zero-cost `(free)`
  suffix. The extended pricing import now fits the print width again
  (`format:check` passes).

### Chores

- New `tests/deals-coverage.test.ts` regression cases: removed free variants
  now fail the gate; deals free flag ⇔ facts zero-cost table consistency;
  negative suffix test (absent cost entry must not get `(free)`).
- README documents the `(free)` suffix and its zero-cost derivation.

## 1.5.1 - 2026-08-24

Fix: provider parsers now synthesize the full reasoning and text lifecycle —
`reasoning-start`/`reasoning-end` and `text-start`/`text-end` — for both
OpenAI-style and Anthropic-style streams, so AI SDK consumers see balanced
section boundaries instead of missing or duplicated end events.

### Fixes

- **OpenAI-style streams** now emit `reasoning-start` before the first
  reasoning delta and `reasoning-end` before text, tool calls, or finish; the
  same for `text-start`/`text-end`. Reasoning and text sections use stable ids
  from the first chunk (instead of per-chunk ids), and unfinished sections are
  closed when the stream finishes.
- **Anthropic-style streams** now recognize `thinking` blocks and emit
  `reasoning-start`/`reasoning-delta`/`reasoning-end` for them. `content_block_stop`
  closes each block with the correct end event per its type (`text-end`,
  `reasoning-end`, or `tool-input-end` + a single `tool-call`), replacing the
  previous "emit both text-end and tool-input-end" pair that left consumers to
  ignore the spurious one.
- New `tests/stream.test.ts` cases cover the OpenAI reasoning→text ordering,
  reasoning-only finishes, and the Anthropic thinking-block lifecycle;
  `tests/provider-parity.test.ts` accepts `text-start` as the first text part.

## 1.5.0 - 2026-08-23

Feature: the `[CMD] ` display-name prefix for auto-registered models is now
configurable via `provider.commandcode.options.display_prefix`.

### Features

- **Configurable display-name prefix** (issue #60): a string value replaces the
  default `[CMD] ` prefix, and an empty string disables it entirely. The option
  is read-only at resolution time — nothing is persisted into the user's config
  (unlike `npm`/`name`/`env`/`options.baseURL`, which are filled when unset).
- Non-string values fall back to the default `[CMD] ` prefix.
- Declared model entries are never renamed — the prefix applies only to models
  auto-registered from the bundled snapshot.

### Chores

- New `tests/plugin-models.test.ts` cases: `resolveDisplayPrefix` fallback,
  prefix override (`"CC/"`), empty string disabling the prefix (with non-name
  metadata unaffected), and declared models keeping their names regardless of
  the setting.

## 1.4.0 - 2026-08-23

Feature: after a successful `/connect`, the credential is mirrored under
`command-code` in OpenCode's auth store and to `~/.commandcode/auth.json`
(official CLI layout), so ecosystem consumers such as OpenChamber's Usage
page find the key without manual setup.

### Features

- **Credential mirroring** (issue #64): `/connect` now writes the credential
  under `command-code` in OpenCode's auth store — refreshed on every
  successful re-auth so the mirror stays in sync — and to
  `~/.commandcode/auth.json` in the official CLI layout, which is only
  written when it does not already hold a different credential, so an
  official CLI login is never clobbered. Writes are atomic; new auth files
  get owner-only permissions and existing file modes are preserved.
- Mirroring is best-effort: failures are swallowed and never fail `/connect`
  itself, and `mirror: false` opts out (used by the oauth tests). Users who
  authenticate via `COMMANDCODE_API_KEY` alone are unaffected.
- Existing users re-run `/connect` once (or copy the entry manually) to pick
  the mirror up.

### Chores

- New `tests/auth-mirror.test.ts` suite: preserves unrelated auth-store
  entries, owner-only permissions on create, stale-entry refresh on re-auth,
  no-clobber of a differing CLI credential, idempotent no-op, blank-key
  guard, and the end-to-end `/connect` flow including `mirror: false` —
  wired into `test:unit`.
- Docs: README notes the mirror locations and that mirroring is best-effort.

## 1.3.0 - 2026-08-23

Feature: dual-transport Provider API — non-Go plans now use the documented
`/provider/v1/*` endpoints with self-healing fallback to the legacy transport.

### Features

- **Provider API routing** (issues #51, #53): non-Go plans (goat, pro, max,
  max20, teampro, provider aliases) route through the documented Provider API —
  `claude-*` models to `POST /provider/v1/messages` (Anthropic shape), everything
  else to `POST /provider/v1/chat/completions` (OpenAI shape) — with retry,
  timeout, abort, and redaction parity with the legacy transport. Go /
  individual-go sessions stay byte-for-byte on the legacy `POST /alpha/generate`
  wire format, proven by golden byte-parity tests.
- **Session-cached plan resolution** (issue #54): transport is chosen per model
  instance from the shared plan-resolution seam — explicit override →
  `COMMANDCODE_PLAN` env → cached `GET /alpha/whoami` → default Provider API.
  Only a resolved `go` selects the legacy transport; next session after a plan
  upgrade auto-switches.
- **Self-healing upgrade flip** (issue #56): if a plan-detection miss sends a
  true Go user to the Provider API, a documented `403 upgrade_required` pins the
  session to the legacy transport and retries the same call once there — no
  second Provider API hit, no double-counted usage.
- **ZDR passthrough** (issue #57): `CMD_ZDR=1` sends `x-cmd-zdr: 1` on every
  Provider API request; the documented `422 cmd_zdr_no_providers` flows through
  the existing error/redaction pipeline. The legacy transport never sends it.
- **Transport hardening** (issue #58): the finish part now waits for a trailing
  OpenAI usage-only chunk so cost reflects real token counts; non-image file
  parts are rejected with a clear role-aware error instead of silently
  base64-encoding; stateful SSE parsers complete tool calls whose arguments
  arrive across multiple events.

### Fixes

- Restored the "Command Code" TUI sidebar section for Ox Alpha and DeepSeek V4
  Flash Vision (exp): the deals-coverage gate now fails loudly when scraped
  records lack a snapshot model, and the fixtures were refreshed to cover every
  model (issue #61).

### Chores

- Added the `refresh` project skill documenting the offline catalog refresh
  (`npm run refresh` from `tests/fixtures/*.html`).
- New test suites: provider transport, parity, upgrade-fallback, ZDR, and
  deals coverage — all wired into `test:unit`.

## 1.2.2 - 2026-08-22

Chore: catalog refresh to `command-code@1.32.1`.

- Added `deepseek/deepseek-v4-flash-vision-exp` (DeepSeek V4 Flash Vision (exp)):
  1M context, text+image input, reasoning efforts `high`/`max`, $0.22/$0.66 per
  1M input/output tokens.
- Added reasoning efforts for `stealth/ox-alpha` (`low`, `high`, `max`).
- Deals catalog unchanged (56 entries).

## 1.2.1 - 2026-08-21

Fix: `/connect` no longer lists Command Code — the plugin failed to load.

- The `cmd_plan_summary` tool runtime-imported `@opencode-ai/plugin`, an
  optional peer dependency that `opencode plugin <pkg>` installs in
  `.opencode/`, not next to the plugin. That import threw `ERR_MODULE_NOT_FOUND`
  at load, silently killing the whole server plugin — no auto-registration and
  no `/connect` entry (Command Code vanished from the provider list).
- The tool now builds its Zod args from a direct `zod` dependency instead of
  `@opencode-ai/plugin`'s `tool()` helper, so the server bundle has zero
  runtime imports of optional peers.
- Added a contract test that scans the built `dist/` and fails on any runtime
  `@opencode-ai/*` import, so this class of regression can't ship again.

## 1.2.0 - 2026-08-21

Feature: Deals intelligence — per-model pricing/allowance data in a sidebar panel and a plan-summary tool, delivered zero-step.

### Features

- New Deals catalog (`src/deals/catalog.ts`): tier, benchmarks, deal discounts (`was`/`now` rates), peak/off-peak windows, and GOAT/Pro monthly allowances for every model, scraped from the Command Code docs.
- New `cmd_plan_summary` tool (plan-aware allowances and deal rates) and a TUI sidebar "Command Code" section for the selected model.
- Zero-step delivery: the package exports a `./tui` target (`dist/tui.js`), and `opencode plugin opencode-cmd-provider` writes both `opencode.json(c)` and `tui.json` from one command — no hand-written `tui.json` (fixes #39).
- Deals intelligence is an excisable slice (`src/deals/`); deleting it plus two lines in the plugin entry leaves Core (models, auth, streaming) unchanged.
- Visible degradation: when the Deals catalog is empty (scraping mitigated), the sidebar shows a "Deals unavailable" banner with placeholder rows and the tool reports no bundled data — Core is unaffected.
- `refresh:deals` no longer blocks a release: it falls back to fixtures or an empty catalog with a warning, and the Deals gate in the release workflow is non-blocking.

### Fixes

- Streaming usage now reports cache-inclusive input token totals (the AI SDK convention). OpenChamber showed context usage as low as ~0.1% instead of ~5% because the converter reported only non-cached input; `inputTokens.total` now includes cache read/write tokens (issue #36).

### Chores

- Catalog refresh to `command-code@1.31.0`, adding the free reasoning model `stealth/ox-alpha` (Ox Alpha).
- Docs: corrected the install command (`opencode plugin`, no `add`), simplified the README Install section, and added build/test/architecture guidance to `AGENTS.md`.

## 1.1.1 - 2026-08-20

Fix: generate image-input modalities from the Command Code CLI catalog.

- `MODEL_INPUT_MODALITIES` now comes from `inputModalities` fields in the
  parsed `command-code` CLI bundle instead of a hand-maintained table.
- The release refresh validates that every API snapshot model is represented
  in the CLI bundle and fails loudly on unsupported or conflicting modality
  data.
- Added AST parser and offline coverage for reordered fields, duplicate model
  entries, malformed bundles, and text-only fallback behavior.
- Docs: the release skill and facts-sync spec now describe the modality
  refresh and the new release-gate failure mode.
- Thanks to @ericpastorm for #31, which auto-syncs the input-modality table
  from the CLI catalog.

## 1.1.0 - 2026-08-20

Feature: complete capability metadata for every catalog model, with automatic sync of reasoning and pricing facts at release time.

- Every auto-registered model now advertises tool calls, reasoning (efforts or reasoning-capable classification), image input, and cost — no more blank CAPABILITIES, blank MODALITIES, or $0.00 rows (fixes #22).
- Reasoning efforts and per-1M-token rates are generated from the command-code package's bundled `models.md` at snapshot-refresh time (`src/catalog/facts.ts`); the release pipeline now fails loudly if the committed facts drifted (ADR 0003).
- Corrected real pricing drift: `deepseek-v4-pro`/`flash` rates were stale, and the expired `gpt-5.6-terra`/`luna` discounts are gone. Context-tier pricing was removed — Command Code publishes flat rates only.
- Added vision entries for `Qwen/Qwen3.8-27B` and `google/gemini-3.7-flash`, and reasoning efforts for `zai-org/GLM-5.3`, `Qwen/Qwen3.8-27B`, `google/gemini-3.7-flash`, and `xai/grok-4.6`.

## 1.0.2 - 2026-08-19

Chore: refresh the bundled model catalog snapshot after the live catalog drifted.

- Added `Qwen/Qwen3.8-27B` (262144 context) to the bundled snapshot — the release pipeline's stale-snapshot gate would otherwise fail the next tag push (ADR 0003).

## 1.0.1 - 2026-08-16

Chore: harden the release flow so a tag push can no longer publish from an unmerged tree or rewrite tags.

- The release pipeline now refuses to run unless the tag's commit is an ancestor of `origin/main` — a tag pushed before the version bump lands on main fails with an explicit error instead of publishing (ADR 0003).
- A stale catalog snapshot now fails the run with remediation instructions instead of committing on the tag's tree, force-pushing main, and re-pointing the tag.
- The release skill ritual was updated: the bump and CHANGELOG entry land on main via PR before tagging; the tag push is all that triggers the pipeline.

## 1.0.0 - 2026-08-16

First stable release: API and behavior locked in, shipping now runs through a tag-driven pipeline.

- Tag-driven release pipeline: pushing `vX.Y.Z` asserts the tag matches `package.json`, refreshes the bundled model-catalog snapshot (committing it and re-triggering itself if stale), builds, runs the full test suite, publishes to npm via OIDC trusted publishing with provenance, and creates the GitHub Release from the CHANGELOG section (ADR 0002).
- Added the `release` skill documenting the pre-tag ritual and post-push verification; removed the run-map skill and the wayfinder-loop script.
- Docs: spell the product name as OpenCode everywhere, list Command Code plans, credit pi-commandcode-provider, and note provenance requires a public repository.
- The e2e test now uses the inherited PATH instead of a hardcoded home directory.

## 0.1.3 - 2026-08-16

Feature: zero-config install via auto-registration from a bundled model snapshot.

- The plugin now bundles a snapshot of the Command Code model catalog (`src/catalog/snapshot.ts`, 55 models) and auto-registers the `commandcode` provider — npm, name, `env`, and every model — during its `config` hook. Installing the plugin is enough: all Command Code models appear in `/models` with the `[CMD]` display-name prefix, no `provider.commandcode` block or `models` map required. No network access is ever needed at runtime.
- Declared config wins: provider-level keys are filled only when unset, declared models are never modified or removed, models that left the catalog stay usable, and `whitelist`/`blacklist` still filter auto-registered models.
- The snapshot is regenerated from the live catalog at every release via `npm run refresh:snapshot` (`scripts/refresh-snapshot.mjs`); newly published models appear after a plugin update.
- Deleted the now-dead network machinery: live catalog fetch and cache (`loadCommandCodeModels`, cache file), the `provider.models` hook, `catalogToOpenCodeModels`, and the `COMMANDCODE_MODELS_*` env vars.
- `COMMANDCODE_API_BASE` now actually overrides the runtime API base (injected as `options.baseURL` when the user declares no `baseURL` of their own).

## 0.1.2 - 2026-08-15

Fix: tool-call history round-trip and reasoning effort. Live probes against the Command Code API with OpenCode confirmed the AI SDK v3 shapes differ from what the converters expected:

- Assistant tool-call parts carry arguments under `input`, not `args`/`arguments` — the converter read the legacy fields, so every prior tool call was re-sent with empty `{}` arguments, corrupting multi-turn context.
- Tool-result outputs use the v3 `{ type: "text" | "error-text" | "json" | "content", ... }` shapes — `resultText` stringified the wrapper, double-encoding results in history. Replaced with `unwrapToolResult`.
- `reasoning_effort` was silently dropped: OpenCode passes `providerOptions` namespaced per provider (`{ commandcode: { reasoningEffort } }`), but the model read the top-level keys. Added `resolveProviderReasoning` (namespaced + top-level fallback) so the configured thinking level actually reaches the API.

Also: remove duplicated README disclaimer; bump `@ai-sdk/provider` to 4.x and `@types/node` to 26.x.

## 0.1.1 - 2026-08-15

Fix: emit `text-start`/`text-end` and `reasoning-start`/`reasoning-end` stream parts. The live Command Code API sends start/end events with ids; the AI SDK's streamText consumer requires them before deltas, so reasoning-capable models (e.g. `deepseek/deepseek-v4-flash`) failed with "reasoning part <id> not found".

## 0.1.0 - 2026-08-15

Initial release: Command Code provider + plugin for OpenCode. Published to npm as `opencode-cmd-provider@0.1.0` (`latest`), tagged `v0.1.0`.

- `createCommandCode(options)` AI SDK provider (LanguageModelV3) + `default` V1 OpenCode plugin module in one package.
- `/connect` browser auth flow, `COMMANDCODE_API_KEY` env var, and legacy auth file support (`~/.commandcode/auth.json`, `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json`).
- Model catalog fetch, parse, and cache with offline fallback; pricing/cost display; image input; reasoning effort.
- Config-declared `models` map required under `provider.commandcode` until `commandcode` lands in OpenCode's models.dev catalog.
