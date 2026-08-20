# Command Code Deals & Pricing Intelligence — Design

Date: 2026-08-20
Status: Approved (pending user spec review)
Branch: `feat/cmd-deals-intelligence`

## Problem

The plugin's bundled catalog (`src/catalog/snapshot.ts` + `src/catalog/facts.ts`,
generated from the npm-shipped `models.md`) carries deal-adjusted per-token
rates but none of the surrounding deal/pricing intelligence published on the
Command Code docs site:

- per-model monthly credit allowances per plan (e.g. Qwen 3.8 27B: $70/mo on
  GOAT — today's "7× usage" announcement)
- deal metadata (discount %, was→now prices, expiry dates)
- plan catalog (price, credits, 5h/weekly window caps)
- DeepSeek V4 peak/off-peak rates with UTC windows
- benchmark scores (intelligence, Tok/s)
- models present on the docs but missing from the npm catalog (Ling 3.0 Flash,
  Claude Opus 4.6, Claude Sonnet 4.5, MiniMax M3 Free)
- per-window request estimates per model

This data exists only as HTML on `commandcode.ai/docs` — no machine-readable
source. It is also volatile: Command Code may renegotiate, expire, or
discard these concepts at any time.

## Goals

1. Surface docs-only pricing/deal data to users of the plugin.
2. Never break existing functionality or the OpenCode UI when that data is
   absent, stale, or structurally changed.
3. Validate the UX with a mocked sample in real OpenCode before building the
   scraper (Milestone 0).

## Non-goals

- Runtime fetching of docs pages (HTML parsing stays at release time).
- Name badges in `/models` (rejected in brainstorming — label noise).
- Replacing the existing `models.md`-based pricing table.
- Plan detection beyond whoami/env/default (no billing portal integration).

## Architecture

Two independent generated modules, two independent refresh scripts:

- existing: `scripts/refresh-snapshot.mjs` → `src/catalog/snapshot.ts` +
  `src/catalog/facts.ts` (unchanged)
- new: `scripts/refresh-deals.mjs` → `src/catalog/deals.ts`

The scraper is a later, swap-in module. The integration code path is identical
whether it consumes the mock or the real generated data — Milestone 0 wires the
mock, the scraper replaces the file.

### Data model — `src/catalog/deals.ts`

```ts
export interface DealRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelDeals {
  allowance: Partial<Record<"go" | "goat" | "pro" | "max" | "max20", number>> // $/mo
  discount?: { pct: number; endsAt?: string } // "permanent" | "while capacity lasts" | ISO date
  was?: { input: number; output: number; cacheRead: number } // pre-deal prices
  peakOffPeak?: {
    peak: DealRates
    offPeak: DealRates
    windows: string // e.g. "01-04 & 06-10 UTC"
  }
  benchmark?: { intelligence?: number; tokPerSec?: number }
  free: boolean
}

export const MODEL_DEALS: Readonly<Record<string, ModelDeals>>
export const PLAN_CATALOG: Readonly<
  Record<
    string,
    {
      price: number
      credits: number
      window5h: number
      windowWeek: number
    }
  >
>
export const DEAL_SOURCE_URL: string
export const DEAL_LAST_REFRESHED: string
export const DEAL_PACKAGE_VERSION: string
```

### Scraper — `scripts/refresh-deals.mjs`

- Inputs: `/docs/resources/pricing-limits` (deals section, was/now table, free
  models), `/docs/plans/goat`, `/docs/plans/pro`, `/docs/plans/max`
  (allowance tables). Env overrides for tests, mirroring the existing
  `COMMANDCODE_*_URL` pattern (`COMMANDCODE_DEALS_*_URL`).
- Each page parse is isolated: a failed parse fails that section only, never
  the whole script; other sections still emit.
- Emits `src/catalog/deals.ts` with the same header/type conventions as
  `facts.ts` ("GENERATED — Do not edit").
- Independent of `refresh:snapshot`; a failure never blocks the snapshot
  release, and vice versa.

### Runtime integration — `src/plugin/`

Config hook additions (all after existing `autoRegister` + augment):

1. `family` = vendor derived from model id namespace (claude-* → claude,
   google/* → google, Qwen/* → qwen, …). Never scraped; cannot go stale.
2. `options.cmd = { tier, allowance, deal, benchmark, peakOffPeak }` — only
   fields present in `MODEL_DEALS[modelId]`.
3. `cost.context_over_200k` when the docs carry a higher tier (MiniMax M3);
   all other costs unchanged.

New plugin tool `cmd_plan_summary`:

- plan = runtime `/alpha/whoami` when online + key present → `COMMANDCODE_PLAN`
  env → default `go`
- markdown output: plan price/credits, 5h/week caps, per-model allowances +
  request estimates, active deals with expiries, link to
  `/docs/resources/pricing-limits`
- offline / no data → graceful message + link, never throws

Optional `tui.toast.show` at startup listing active deals when `MODEL_DEALS`
is present.

### Degradation contract (hard rule)

Every enrichment site is guarded: a missing field, empty map, or absent module
skips _that enrichment only_. Never throw; never emit schema-invalid config.
Snapshot registration, reasoning, modalities, and facts-based cost are
untouched. A test asserts that with a stub/empty `deals.ts`, the generated
config is byte-identical to today's output.

## Milestones

**Milestone 0 — Mock demo (validation):**

- `src/catalog/deals.demo.ts` with realistic samples: Qwen 3.8 27B $70 GOAT,
  Gemini 3.7 Flash −50% to 2026-12-31, MiMo −98/−99%, DeepSeek V4
  peak/off-peak, MiniMax M3 tiered cost, free models (Laguna, Ling).
- Enrichment code + `cmd_plan_summary` tool wired to the mock.
- Run real `opencode` with the built package; user inspects `/models` and the
  tool output and judges the UX.
- Branch: `feat/cmd-deals-intelligence`; main stays clean until the user
  decides it ships.

**Milestone 1 — Scraper:** `scripts/refresh-deals.mjs` + parser fixtures from
real pages; swap mock for generated `deals.ts`; add `refresh:deals` to the
release ritual.

## Testing

- parser unit tests against fixtures captured from the real docs pages
- fail-soft unit tests: partial/stub/empty `deals.ts` data
- config-output-equivalence test (stub deals ⇒ byte-identical config to today)
- `cmd_plan_summary` rendering tests (online, offline, no-data)
- existing suite stays green (`npm test`, `npm run build`, `npm run format:check`)

## Out of scope (future)

- Deal-delta announcements across releases (needs prior-release snapshot)
- `context_over_200k` for models other than MiniMax M3
- Runtime data freshness beyond plan detection
