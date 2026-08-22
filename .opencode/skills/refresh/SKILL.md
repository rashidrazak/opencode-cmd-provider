---
name: refresh
description: Refresh the bundled catalogs of opencode-cmd-provider — model snapshot, capability facts, and deals catalog — including re-capturing the docs fixtures and running the coverage gate. Use when the user says "refresh", "refresh the catalogs", "update the models", "re-sync the snapshot", "re-capture fixtures", or asks to update model list/pricing/deals data. Not for cutting a release (use the release skill) or for editing the refresh scripts themselves (plain code work).
---

# Refresh

A **Catalog refresh** (the model snapshot) plus a **Deals catalog** refresh
updates the generated catalogs so the plugin's bundled data matches Command
Code's live catalog (see `CONTEXT.md`). It happens on demand (typically before
a release), never at runtime; the pipeline also refreshes at release time —
this skill is the manual, local, commit-ready version of the same work.

## What gets refreshed

| File                                   | Source                                                 | Script                         |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| `src/catalog/snapshot.ts`              | live API catalog (id, name, context)                   | `scripts/refresh-snapshot.mjs` |
| `src/catalog/facts.ts`                 | npm `command-code` bundle (efforts, rates, modalities) | `scripts/refresh-snapshot.mjs` |
| `src/deals/catalog.ts`                 | docs pages / `tests/fixtures/*.html`                   | `scripts/refresh-deals.mjs`    |
| `tests/fixtures/goat.html`, `pro.html` | live docs capture (deals source)                       | manual `fetch`                 |

`src/catalog/*.ts`, `src/deals/catalog.ts` — **generated, never hand-edit**
(AGENTS.md).

## Quick start

```bash
npm run refresh            # snapshot + facts (live) + deals (offline fixtures)
node scripts/check-deals-coverage.mjs   # gate: every snapshot model has a deal
npm test                   # full suite (unit + integration + contract + format)
```

## Workflows

### A. Full refresh (recommended)

1. **Refresh the model catalog** (snapshot + facts, live):
   `npm run refresh:snapshot` — hits the API + npm registry. Fails hard on
   network/parse problems.
2. **Refresh the deals catalog** (offline, from fixtures):
   `npm run refresh:deals -- --fixtures`.
   If the snapshot gained models the fixtures lack, **this aborts with exit 1**
   naming them — that is the coverage gate doing its job.
3. **Re-capture the fixtures** when the gate (or a review) shows the docs have
   new models (Workflow B), then re-run step 2.
4. **Verify** — `node scripts/check-deals-coverage.mjs` (OK line), then
   `npm test`. `npm run build` needs `bun` on PATH only when rebuilding the TUI.
5. **Review the diff** — `git diff` should show additive entries: new snapshot
   ids, new `MODEL_DEALS` entries, small fixture deltas. Date stamps
   (`FACTS_LAST_REFRESHED`, `DEAL_LAST_REFRESHED`) change by design.
6. **Commit** — conventional style, e.g. `chore(catalog): refresh to
command-code@X.Y.Z`.

### B. Re-capturing the deals fixtures

The fixtures must stay in sync with the snapshot: a model in the snapshot but
missing from the docs pages silently loses its "Command Code" sidebar section
(issue: Ox Alpha / DeepSeek V4 Flash Vision (exp) showed no section because the
fixtures predated them).

1. Fetch the two record-bearing pages (the pricing-limits page carries no
   embedded records — goat and pro are the sources):
   ```bash
   curl -sL -H 'accept: text/html' https://commandcode.ai/docs/plans/goat -o tests/fixtures/goat.html
   curl -sL -H 'accept: text/html' https://commandcode.ai/docs/plans/pro  -o tests/fixtures/pro.html
   ```
2. Regenerate and gate:
   `npm run refresh:deals -- --fixtures` — must write 58+ entries, not abort.
3. `git diff --stat tests/fixtures/` — expect a small, noisy delta (the
   Next.js flight payload embeds a build hash on every capture; the _record_
   changes are what matter). Spot-check that only intended models/rates
   changed.
4. Run the deals tests:
   `npx tsx tests/parse-docs.test.ts && npx tsx tests/refresh-deals.test.ts && npx tsx tests/deals-coverage.test.ts`.

### C. Deals data stale but gate passed

The gate only proves coverage. If deal _values_ (allowances, discounts,
benchmarks) are stale, re-capture the fixtures (B), re-run
`refresh:deals -- --fixtures`, and eyeball the diff for rate changes.

## Failure recovery

- **`refresh:deals` aborts with "N snapshot model(s) have no deals record"** —
  fixtures (or live scrape) are behind the snapshot. Re-capture fixtures (B),
  re-run. Do **not** pass `--allow-partial` to ship a partial catalog; that
  flag is reserved for the release pipeline's non-blocking check.
- **`refresh:snapshot` fails** ("CLI modality catalog is missing API models") —
  upstream timing: the API lists a model the CLI bundle lacks, or
  `scripts/parse-modalities.mjs` needs updating. Resolve on main, re-refresh.
- **Network down / docs changed shape** — offline still works:
  `npm run refresh:deals -- --fixtures` from the committed fixtures; only the
  fixture re-capture (B) needs the live docs.
- **A stale catalog fails the release run** — nothing shipped. Refresh locally,
  commit, land on main, re-tag (see the release skill).

## Reference

- `CONTEXT.md` (vocabulary), ADR-0002/0003 (release gates), ADR-0004 (Deals
  slice), AGENTS.md ("Generated files — do not hand-edit").
- Mechanics: `scripts/refresh-deals.mjs`, `scripts/refresh-snapshot.mjs`,
  `scripts/check-deals-coverage.mjs`, `tests/deals-coverage.test.ts`.
