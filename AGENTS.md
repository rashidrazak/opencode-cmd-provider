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
- Single test: `npx tsx tests/<file>.test.ts`. Tests are plain `.test.ts` files
  run by `tsx` (no vitest/jest); helpers `run`/`assert`/`assertEqual` come from
  `tests/harness.ts`.
- **New test files must be added to the `test:unit` script in `package.json`**
  (it is an explicit `&&` list, not a glob) or CI won't run them.
- `npm run test:e2e` needs a real `opencode` binary on PATH and is excluded from
  `npm test`. Its headless `opencode run` leg deliberately skips — upstream
  opencode bug (anomalyco/opencode #14956, #5674). Don't "fix" the skip.

## Generated files — do not hand-edit

`src/catalog/snapshot.ts`, `src/catalog/facts.ts`, and `src/deals/catalog.ts`
are generated (`scripts/refresh-snapshot.mjs`, `scripts/refresh-deals.mjs`).
Regenerate with `npm run refresh` — snapshot from the live models API; the
RSC fixtures (`tests/fixtures/rsc-*.txt`) are re-captured from the live docs
pages (`scripts/capture-rsc-fixtures.mjs`, all-or-nothing, loud on any
failure); the deals catalog is regenerated from the freshly captured
fixtures, so fixtures, catalog, and the fixture-based unit tests stay in
lockstep. The cron commits the fixtures alongside the catalog when upstream
moved. Standalone live regeneration: `npm run refresh:deals` (5xx/network →
fixture fallback, 4xx fails loudly); offline-only:
`npm run refresh:deals -- --fixtures`.
`refresh:deals` **fails loudly (exit 1) when the RSC/fixture records lack a
snapshot model** — a partial deals catalog silently hides the TUI sidebar
"Command Code" section for the missing models. This gate is why the fixtures
must be refreshed alongside the snapshot (see `scripts/check-deals-coverage.mjs`
and `tests/deals-coverage.test.ts`). `--allow-partial` opts out for tooling
that must not exit non-zero (the release pipeline's non-blocking deals check);
it never emits an empty catalog.

## Architecture

- **Two hosts, two config files.** The server host reads `opencode.json`
  (`src/plugin/index.ts`, package export `"."`); the TUI host reads `tui.json`
  (`src/deals/tui.tsx`, package export `"./tui"` → `dist/tui.js`). The TUI host
  never reads `opencode.json` (verified, ADR-0004).
- **`src/deals/` is the excisable Deals slice.** Deleting it plus the two
  registration lines in `src/plugin/index.ts` leaves Core green. Keep the server
  barrel `src/deals/index.ts` free of the TUI re-exports — exporting `tui.tsx`
  from it pulls `solid-js`/`@opentui` into the server bundle.
- **Never runtime-import `@opencode-ai/*`.** `@opencode-ai/plugin`/`@opencode-ai/sdk`
  are optional peer deps: `opencode plugin <pkg>` installs them in `.opencode/`,
  not next to the plugin, so a runtime import fails to resolve at load and kills
  the whole plugin (no auto-registration, no `/connect`). Reference them only via
  `import type`. Enforced by `tests/contract.test.ts`.
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
