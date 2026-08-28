# ADR-0005: RSC-primary deals pipeline with a daily catalog-refresh cron

Status: accepted

The deals catalog is generated from the Command Code docs site's **React
Server Components (RSC) flight payload** instead of scraped HTML tables, and a
**daily GitHub Actions cron** keeps the bundled catalogs in step with upstream
between human-driven releases. Wayfinder map #78 (tickets #79–#86) shipped the
implementation; this ADR records the decisions that survived verification.

## The RSC surface

Next.js serves the per-model records — with stronger typing than the rendered
tables — as a JSON flight payload on the **same URLs as the docs pages** when
the request carries an `rsc: 1` header. Verified live 2026-08-28:

- `https://commandcode.ai/docs/resources/pricing-limits` → `text/x-component`
- `https://commandcode.ai/docs/plans/goat` → `text/x-component`
- `https://commandcode.ai/docs/plans/pro` → `text/x-component`

The `/docs/rsc/*` routes do **not** exist on the live site (404) — an earlier
draft used them and was corrected after a live probe. The RSC is treated as a
black box: `scripts/parse-rsc.mjs` returns the embedded JSON as-is, and
shape-pinning unit tests (fixtures in `tests/fixtures/rsc-*.txt`) fail loudly
if upstream renames or drops a field. The shared depth-state-machine lives in
`scripts/json-stream.mjs`. The HTML parsers in `scripts/parse-docs.mjs` remain
as a documented fallback for air-gapped environments; the HTML live fetch and
HTML fixtures are gone.

## Fetch semantics (decided after the first cron runs)

- **5xx / network failure** → fall back to the committed RSC fixtures
  (transient; the fixtures are the offline source of truth).
- **4xx** → fail loudly and write nothing. A 404 is a config error (route
  moved or a wrong `COMMANDCODE_RSC_*_URL` override), not a transient — it
  must never be masked by silently shipping fixture data as live.

## Fixture lockstep

The fixture-based unit tests treat the committed fixtures as ground truth, so
the fixtures must move with the snapshot: `npm run refresh` =
`refresh:snapshot` (live) → `refresh:fixtures` (`scripts/capture-rsc-fixtures.mjs`,
all-or-nothing, loud on any failure) → `refresh:deals -- --fixtures`. The
catalog is therefore regenerated from the freshly captured payloads, and the
cron commits fixtures + catalog + snapshot together. The coverage gate
(`missingDealsModelsFromRsc`) fails loudly when a snapshot model has no RSC
record, so a partial catalog can never be committed silently
(`--allow-partial` opts out for the release pipeline's non-blocking deals
check, per ADR-0003).

## Data seams

- **Slug-id alias** (`SLUG_ID_TO_SNAPSHOT_ID` in `parse-rsc.mjs`): RSC slug ids
  (e.g. `claude-haiku-4-5`) map to date-suffixed snapshot ids
  (`claude-haiku-4-5-20251001`); applied at parse time so the emitted Map is
  snapshot-keyed.
- **Tier overrides** (`scripts/tier-overrides.mjs`): the only judgment the
  generator makes — 7 known upstream tier-categorization disagreements
  (`gpt-5.6-luna`, `gpt-5.6-sol`, `google/gemini-3.7-flash`, `xai/grok-4.5`,
  `xai/grok-4.6`, `meta/muse-spark-1.2`, `meta/muse-spark-1.2-contributor`) are
  pinned to `opensource` so TUI badges stay stable.

## Daily cron

`.github/workflows/catalog-refresh.yml` (06:00 UTC + `workflow_dispatch`,
concurrency-serialized): `npm ci` → `npm run refresh` → **`npm run build`**
(required — `npm test` includes an `npm pack` contract test, and a fresh
checkout has no `dist/`) → `npm test` → byte-diff against `origin/main` for
the three generated files plus the fixtures. Drift opens a
`chore: catalog refresh — YYYY-MM-DD` PR whose body is produced by
`scripts/diff-catalog.mjs` (added/removed/changed models, last-refreshed
dates); no drift exits silently. Re-run safety: an existing same-date PR is
updated instead of duplicated. The release pipeline's stale-snapshot gate
(ADR-0003) is untouched — the cron is best-effort freshness, the tag-time gate
is the safety net.

## Consequences

- The deals data users see is regenerated at most daily and is accurate to
  the last upstream publish the cron saw; upstream value changes surface as
  shape-pinning test failures (human updates the pins — or relaxes them, see
  issue #89) rather than silently shipping.
- The cron's PRs require review (branch protection) — the maintainer observes
  the first runs before trusting auto-merge; routine refreshes are designed to
  be one-click merges.
- No runtime network change: the plugin stays offline at runtime; only
  release-time/cron-time scripts hit the docs site.
