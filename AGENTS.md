# opencode-cmd-provider

opencode plugin + provider: `provider.commandcode` auto-registration, `[CMD]`
models, `COMMANDCODE_API_KEY` auth, `provider/*` streaming, plus a Deals
intelligence slice. Domain vocabulary lives in `CONTEXT.md`; architectural
decisions in `docs/adr/`.

## Commands

- `npm run build` runs `tsc` then `bun scripts/build-tui.ts`. **`bun` must be on
  PATH** — the TUI (`dist/tui.js`) is built with bun because `tsc`'s `react-jsx`
  emit is non-reactive (props freeze; the sidebar never repaints). CI installs
  bun.
- `npm test` = typecheck → unit → integration → contract → `format:check`.
- `npm run lint:secrets` scans the tree with secretlint for Command Code key
  material (`user_`/`cc_` + 8 characters, mirroring `provider/redact.ts`). It is
  a separate CI step, not part of `npm test`. `.secretlintrc.json` deliberately
  carries that one pattern and no generic heuristic; the credential-shaped
  fixtures in `tests/` are allowlisted by value, so a new sentinel fails the
  gate until it is added there.
- Single test: `npx tsx tests/<file>.test.ts`. Tests are plain `.test.ts` files
  run by `tsx` (no vitest/jest); helpers `run`/`assert`/`assertEqual` come from
  `tests/harness.ts`.
- **New test files must be added to the `test:unit` script in `package.json`**
  (it is an explicit `&&` list, not a glob) or CI won't run them.
- `npm run test:e2e` needs a real `opencode` binary on PATH and is excluded from
  `npm test`. Its headless `opencode run` leg deliberately skips — upstream
  opencode bug (anomalyco/opencode #14956, #5674). Don't "fix" the skip.
- `npm run test:e2e:v2` is the v2 counterpart: it installs the build at
  `.opencode/plugins/commandcode/` (v2 only accepts a **directory** as a
  configured local plugin path), runs a headless `opencode run`, and asserts the
  provider, all Snapshot models, and the integration as the host reports them
  back. It skips when the installed binary is not v2, and its `run` leg skips on
  the same upstream hang. Don't use `opencode models` for this — v2 activates
  plugins asynchronously and the one-shot CLI can win that race (the API's
  `POST /api/plugin/await-activation` is the wait primitive).

## Generated files — do not hand-edit

`src/catalog/snapshot.ts`, `src/catalog/facts.ts`,
`src/catalog/classification.ts`, and `src/deals/catalog.ts` are generated
(`scripts/refresh-snapshot.mjs`, `scripts/refresh-classification.mjs`,
`scripts/refresh-deals.mjs`). Regenerate with `npm run refresh` — the
snapshot comes from the npm package's bundled models.md table (the sole
membership authority since #130; the listing API is annotate-only); the
RSC fixtures (`tests/fixtures/rsc-*.txt`) and the models-page index fixture
(`tests/fixtures/models-page.html`, issue #131) are re-captured from the
live docs pages (`scripts/capture-rsc-fixtures.mjs`, all-or-nothing, loud on
any failure); the classification module and the deals catalog are regenerated
from the freshly captured fixtures, so fixtures, catalogs, and the
fixture-based unit tests stay in lockstep. The cron commits the fixtures
alongside the catalogs when upstream moved. Standalone live regeneration:
`npm run refresh:deals` / `npm run refresh:classification` (5xx/network →
fixture fallback, 4xx fails loudly); offline-only:
`npm run refresh:deals -- --fixtures` / `npm run refresh:classification --
--fixtures`.
Since issue #132 the enrichment coverage gates are **inverted to
membership-superset-of-enrichment with pending reports**: deals records,
classification entries, and modalities are asserted as subsets of the
Snapshot, and a snapshot model missing enrichment ships core-only with a
visible pending note — never an exit-1. `refresh:deals` and
`refresh:classification` log pending reports (`deals pending —`,
`classification pending`) and exit 0. `--allow-partial` remains an accepted
no-op. The shape gate stays: the RSC `reasoning` flag is required on
consumed slug records — upstream renaming or dropping it is a loud
failure, never a silent default-to-non-reasoning (see ADR-0006). Only two
loud failure classes survive anywhere: an unshippable ship-bar row after
the full enrichment ladder (issue #132) and a parser shape change in any
source. The refresh scripts' subset checks stay in lockstep with the
fixtures (see `scripts/check-deals-coverage.mjs` and
`tests/deals-coverage.test.ts`).

## Architecture

- **Three hosts, two config files.** The server host reads `opencode.json`
  (`src/plugin/index.ts`, package export `"."`) and has two flavours — OpenCode
  v1 calls the default export's `server()`, v2 calls its `setup(context)`; the
  TUI host reads `tui.json` (`src/deals/tui.tsx`, package export `"./tui"` →
  `dist/tui.js`). The TUI host never reads `opencode.json` (verified, ADR-0004).
  The v1/v2 server halves are separate implementations of the same three
  capabilities — v2 does not translate v1 hooks (ADR-0010).
- **`src/deals/` is the excisable Deals slice.** Deleting it plus the two
  registration lines in `src/plugin/index.ts` (`enrichCatalog` and `tools` in
  the v2 `setup`, `enrichCommandCodeModels` and `planSummaryTool` in the v1
  `server`) leaves Core green. Keep the server barrel `src/deals/index.ts` free
  of the TUI re-exports — exporting `tui.tsx` from it pulls
  `solid-js`/`@opentui` into the server bundle.
- **Never runtime-import `@opencode-ai/*` or `@opencode/*`.** `@opencode-ai/plugin`/`@opencode-ai/sdk`
  are optional peer deps: `opencode plugin <pkg>` installs them in `.opencode/`,
  not next to the plugin, so a runtime import fails to resolve at load and kills
  the whole plugin (no auto-registration, no `/connect`). The v2 host packages
  are worse: the v2 context is _injected_, so nothing needs them at all. Mirror
  their shapes in `src/plugin/v2-types.ts` and reference the v1 packages only via
  `import type`. Enforced by `tests/contract.test.ts` for both scopes.
- The install command is `opencode plugin <pkg>` — **there is no `add`
  subcommand** on opencode 1.18+.

## Conventions

- Angular Conventional Commits; types/scopes in `CONTRIBUTING.md`.
- Use `CONTEXT.md` vocabulary (Model catalog, Snapshot, Auto-registration, Deals
  catalog, Deals intelligence, Core, Display name); don't drift to the "avoid"
  synonyms listed there.

## Agent skills

### Releases

When the user asks to cut a release — "release", "bump to X", "tag vX.Y.Z" —
the `release` project skill (`.opencode/skills/release/`) is the trigger:
version bump + CHANGELOG entry + snapshot refresh + tag, then the pipeline
(`.github/workflows/release.yml`, ADR 0002) publishes to npm and creates the
GitHub Release.

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map one-to-one to the label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Spec and plan

Specs and plans live in GitHub Issues. Domain vocabulary lives in `CONTEXT.md`;
architectural decisions (including verified OpenCode loader behavior) live in
`docs/adr/`. When working on any issue, read the issue, `CONTEXT.md`, and any
ADRs touching the area first. If a ticket and an ADR disagree, note the
discrepancy in the ticket.
