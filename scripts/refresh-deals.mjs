// scripts/refresh-deals.mjs — regenerate src/deals/catalog.ts (Deals slice)
// from the Command Code docs site's RSC stream (pricing-limits, plans/goat,
// plans/pro). Runs at release time; never at runtime. Independent of
// refresh-snapshot.mjs — a failure here never blocks the snapshot release or
// vice versa.
//
// Usage: node scripts/refresh-deals.mjs [--out path] [--fixtures]
//   --fixtures regenerates from the committed tests/fixtures/rsc-*.txt
//                    text fixtures (offline). The HTML path is gone —
//                    see ticket #83 on the wayfinder map for the
//                    contract half of the HTML → RSC switch.
//   --allow-partial  do not fail on snapshot models missing from the RSC
//                    records (off for the standalone refresh so a
//                    partial catalog can never be committed silently)
//   env COMMANDCODE_RSC_PRICING_URL   overrides the RSC pricing-limits URL
//   env COMMANDCODE_RSC_GOAT_URL      overrides the RSC goat plan URL
//   env COMMANDCODE_RSC_PRO_URL       overrides the RSC pro plan URL
//
// Live fetch semantics: the docs site serves the RSC flight payload on
// the same URLs as the HTML pages when the request carries the `rsc: 1`
// header (verified 2026-08-28 — `/docs/rsc/*` is not a route). A 5xx or
// network failure falls back to the committed fixtures (transient —
// per the wayfinder spec at #77); a 4xx fails loudly (the route moved
// or the env override is wrong — a config error, not a transient).
//
// The HTML parsers in scripts/parse-docs.mjs (extractModelRecords,
// extractPlanAllowances) are kept as a documented fallback for
// air-gapped environments per the wayfinder spec at #77; this script
// no longer calls them. Run them via Node directly if you need the
// legacy HTML pipeline.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { num, ratesFor, benchmarkFor, endsAtFor } from "./parse-docs.mjs"
import {
  applySlugIdAlias,
  extractPlanPageRsc,
  extractPlanTableRsc,
  extractPricingLimitsRsc,
} from "./parse-rsc.mjs"
import { applyTierOverride } from "./tier-overrides.mjs"
import { RSC_PAGES, loadRscPages, missingSnapshotModels } from "./rsc-source.mjs"
import { snapshotIndex } from "./snapshot-index.mjs"

// The RSC page catalog and the fetch/fixture ladder live in the shared
// record source (issue #109) so the classification generator cannot drift
// from the fetch semantics or grow a second copy of the fallback ladder.
// The historical export names stay (the DEAL_SOURCE_URL emit and the
// tests import them from here).
export const DEFAULT_RSC_PRICING_URL = RSC_PAGES.pricing.defaultUrl
export const DEFAULT_RSC_GOAT_URL = RSC_PAGES.goat.defaultUrl
export const DEFAULT_RSC_PRO_URL = RSC_PAGES.pro.defaultUrl
const DEFAULT_OUT = resolve(import.meta.dirname, "..", "src", "deals", "catalog.ts")

// Coverage gate for the RSC path. Re-exported under its historical name:
// The gate itself lives in the shared record source so the classification
// generator reuses it without importing from the Deals generator
// (issue #109). `bySnapshotId` is the Map built by `buildRscInputs` (the
// records are already snapshot-keyed by extractPlanPageRsc, which applies
// the slug-id alias). Since issue #132 the gate is a pending-report
// primitive (missingSnapshotModels), never an abort: deals are a subset
// of membership, a missing record ships the model core-only with a
// `deals pending` report, and `--allow-partial` remains an accepted no-op
// for tooling that passed it historically (e.g. the release pipeline's
// non-blocking deals check).
export { missingSnapshotModels as missingDealsModelsFromRsc } from "./rsc-source.mjs"

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

// Deal-term → discount endsAt. The RSC uses free-form terms; keep the ISO date
// when present, otherwise drop endsAt (permanent).
export function discountFor(record) {
  const deal = record.deal
  if (!deal || typeof deal !== "object" || deal === null) return undefined
  if (deal.free === true) return undefined
  const pct = num(deal.discountPercent)
  if (pct === undefined) return undefined
  const endsAt = endsAtFor(deal)
  return { pct, ...(endsAt !== undefined ? { endsAt } : {}) }
}

export function peakOffPeakFor(record) {
  const tod = record.timeOfDay
  if (!tod || typeof tod !== "object" || tod === null) return undefined
  const peak = ratesFor({ rates: tod.peak })
  const offPeak = ratesFor({ rates: tod.offPeak })
  if (!peak || !offPeak) return undefined
  const windows = typeof tod.windows === "string" ? tod.windows : ""
  return {
    peak: { ...peak, cacheWrite: 0 },
    offPeak: { ...offPeak, cacheWrite: 0 },
    windows,
  }
}

export function modelDealEntry(record) {
  const tier =
    record.category === "premium"
      ? "premium"
      : record.category === "opensource"
        ? "opensource"
        : undefined
  const free = record.deal?.free === true || record.deal?.discountPercent === 100
  const tiers = Array.isArray(record.tiers) ? record.tiers : []
  const first = tiers[0]
  const now = ratesFor(first)
  const was =
    first && typeof first.listRates === "object" ? ratesFor({ rates: first.listRates }) : undefined
  const discount = discountFor(record)
  const entry = {
    ...(tier !== undefined ? { tier } : {}),
    ...(discount ? { discount } : {}),
    ...(was ? { was } : {}),
    ...(now && (discount || was) ? { now } : {}),
    ...(free ? { free: true } : {}),
    ...(benchmarkFor(record) ? { benchmark: benchmarkFor(record) } : {}),
    ...(peakOffPeakFor(record) ? { peakOffPeak: peakOffPeakFor(record) } : {}),
  }
  if (tiers.length > 1) {
    const longTier = tiers[tiers.length - 1]
    const base = ratesFor(longTier)
    if (base) {
      const cacheWrite = num(longTier.rates?.cacheWrite) ?? 0
      const over = { ...base, cacheWrite }
      const differsFromNow =
        !now ||
        over.input !== now.input ||
        over.output !== now.output ||
        over.cacheRead !== now.cacheRead
      const hasCacheWrite = over.cacheWrite !== 0
      if (differsFromNow || hasCacheWrite) {
        // Only emit when long-context rates are distinct — MiniMax M3's
        // >512K tier is byte-identical to its ≤512K tier, so we omit it.
        entry.overContext = over
      }
    }
  }
  if (!entry.free && free === false) {
    // non-free models always get the explicit flag so the shape is stable
    entry.free = false
  }
  return entry
}

// --- Plan rows (issue #229) -------------------------------------------------
//
// The PLAN_CATALOG rows used to be hand-typed in this template and nothing
// covered them: upstream repriced Pro and added GOAT between the 2026-08-03
// and 2026-08-06 docs captures and nothing here noticed (issue #162 was found
// by a user). The pricing-limits RSC renders the usage-limits table
// (`Plan | Your cost | Monthly credits | 5-hour limit | Weekly limit`) with
// every subscription plan; it is now the live source for the emitted rows.
// Only the two rows the usage-limits table cannot source are pinned below,
// each with its provenance rendered as a comment above the row.

// The docs usage-limits table's row labels → this package's PlanId vocabulary.
// A table row whose label is not in this map is docs-ahead skew (the #132
// superset discipline): it is reported as `plan table pending` and skipped —
// never silently emitted under a guessed id.
export const PLAN_LABEL_TO_ID = {
  Go: "go",
  GOAT: "goat",
  Pro: "pro",
  "Max 10×": "max",
  "Max 20×": "max20",
  "Team Pro": "teampro",
}

// The only hand-typed plan rows. `note` is the provenance comment the emitter
// writes above the row, so a pin is never mistaken for a parsed value.
export const PLAN_PINS = {
  prolegacy: {
    row: { price: 15, credits: 30, window5h: 9, windowWeek: 18, display: "Pro (legacy)" },
    note: [
      "Legacy Pro: the docs table's row before the Aug 2026 repricing, kept",
      "for grandfathered individual-pro accounts (issue #162). Source:",
      "https://web.archive.org/web/20260803033612/https://commandcode.ai/docs/resources/pricing-limits",
      "Docs allowances stay keyed pro, so this row has no allowance table.",
    ],
  },
  provider: {
    row: { price: 15, credits: 0, window5h: 0, windowWeek: 0, display: "Provider" },
    note: [
      "Provider: pinned — the usage-limits table has no Provider row, because",
      "the plan is pay-as-you-go API access: no monthly credits or window",
      "caps. The $15/mo price and PAYG terms are from",
      "https://commandcode.ai/provider (the marketing table's Provider row",
      "carries the price but prose, not plan figures).",
    ],
  },
}

// Emission order — the PlanId vocabulary order of src/catalog/plans.ts. The
// emitted module is a `Record<PlanId, PlanInfo>` literal, so a PlanId missing
// here fails `npm run typecheck` instead of shipping a partial catalog.
export const PLAN_ID_ORDER = [
  "go",
  "goat",
  "pro",
  "prolegacy",
  "max",
  "max20",
  "teampro",
  "provider",
]

/**
 * A plan row's figures: what the docs usage-limits table carries and what the
 * emitter writes into PLAN_CATALOG.
 * @typedef {{ display: string, price: number, credits: number, window5h: number, windowWeek: number }} PlanRow
 */

/**
 * A resolved plan row: the figures plus the provenance comment lines the
 * emitter writes above the row (absent for a table-sourced row).
 * @typedef {{ row: PlanRow, note?: string[] }} PlanRowEntry
 */

// Builds the PLAN_CATALOG rows from the parsed docs plan table, the pins, and
// the previously emitted rows:
//
//   rows            Map<PlanId, PlanRowEntry> in PLAN_ID_ORDER order
//   unmatched       table rows whose label maps to no PlanId (pending report)
//   carriedForward  PlanIds no source carries whose previous row was reused
//   missing         PlanIds with no row at all (an unshippable plan row)
//
// Precedence: the live table wins over a pin; a pin covers a PlanId the table
// does not carry; a carried-forward previous row covers one neither the table
// nor a pin carries (a plan upstream removed — a `plan table pending` report,
// never a silent row drop). A PlanId with no source after that full ladder is
// an unshippable row (the same loud class as a Snapshot row that stays
// unresolved after its ladder): shipping a plan summary with no figures is
// worse than not shipping.
export function buildPlanRows({
  tableRows = [],
  previousRows = new Map(),
  pins = PLAN_PINS,
  labelToId = PLAN_LABEL_TO_ID,
  order = PLAN_ID_ORDER,
} = {}) {
  for (const id of Object.keys(pins)) {
    if (!order.includes(id)) {
      throw new Error(`plan pin "${id}" is not in PLAN_ID_ORDER — the pin would never be emitted`)
    }
  }
  // Match the table rows to PlanIds first (and detect duplicates), then walk
  // the vocabulary order so the emitted rows keep a stable order regardless of
  // the order the docs table lists them in.
  const tableById = new Map()
  const unmatched = []
  for (const tableRow of tableRows) {
    const id = labelToId[tableRow.display]
    if (id === undefined) {
      unmatched.push(tableRow)
      continue
    }
    if (!order.includes(id)) {
      throw new Error(
        `plan table row "${tableRow.display}" maps to PlanId "${id}", ` +
          `which is not in PLAN_ID_ORDER — update scripts/refresh-deals.mjs`,
      )
    }
    if (tableById.has(id)) {
      throw new Error(
        `RSC plan table shape change: two table rows map to PlanId "${id}" ` +
          `(second label: "${tableRow.display}")`,
      )
    }
    tableById.set(id, tableRow)
  }
  const rows = new Map()
  const carriedForward = []
  const missing = []
  for (const id of order) {
    const tableRow = tableById.get(id)
    if (tableRow) {
      rows.set(id, { row: tableRow })
      continue
    }
    const pin = pins[id]
    if (pin) {
      rows.set(id, { row: pin.row, note: pin.note })
      continue
    }
    const previous = previousRows.get(id)
    if (previous) {
      rows.set(id, {
        row: previous,
        note: [
          "Carried forward: the docs usage-limits table no longer carries this",
          "plan, so these are its last table-sourced values. Re-pin the row here",
          "or prune the PlanId (issue #229).",
        ],
      })
      carriedForward.push(id)
      continue
    }
    missing.push(id)
  }
  return { rows, unmatched, carriedForward, missing }
}

// The plan rows for one pricing-limits payload: the parsed table joined to the
// pins / carry-forward state. Both the RSC emit seam and main() build their
// rows here, so the pending-report population and the unshippable-row abort
// can't drift between the two.
//
// Throws on a plan table shape change (extractPlanTableRsc) and on a PlanId
// with no source at all (see buildPlanRows).
export function planRowsFromRsc({ pricingLimitsRsc, previousRows = new Map() } = {}) {
  const { rows, unmatched, carriedForward, missing } = buildPlanRows({
    tableRows: extractPlanTableRsc(pricingLimitsRsc ?? ""),
    previousRows,
  })
  if (missing.length > 0) {
    throw new Error(
      `plan row(s) without a source: ${missing.join(", ")} — neither the docs ` +
        `usage-limits table, a PLAN_PINS entry, nor a previously emitted row to ` +
        `carry forward (unshippable plan row)`,
    )
  }
  return { rows, unmatched, carriedForward }
}

// The previously emitted PLAN_CATALOG rows, read back for the carry-forward
// step above. The refresh runs under plain node and the catalog is a generated
// .ts file, so the rows are extracted with a line regex (the same approach
// scripts/snapshot-index.mjs uses) rather than a runtime TS import.
const PREVIOUS_PLAN_ROW_RE =
  /^ {2}([A-Za-z0-9]+): \{ price: ([0-9]+(?:\.[0-9]+)?), credits: ([0-9]+(?:\.[0-9]+)?), window5h: ([0-9]+(?:\.[0-9]+)?), windowWeek: ([0-9]+(?:\.[0-9]+)?), display: ("(?:[^"\\]|\\.)*") \},$/gm

export function parsePreviousPlanRows(text) {
  const rows = new Map()
  for (const match of text.matchAll(PREVIOUS_PLAN_ROW_RE)) {
    rows.set(match[1], {
      price: Number(match[2]),
      credits: Number(match[3]),
      window5h: Number(match[4]),
      windowWeek: Number(match[5]),
      display: JSON.parse(match[6]),
    })
  }
  return rows
}

// Builds the deals module text from already-normalised inputs. The
// template (PLAN_CATALOG, interfaces, header) lives here so the emit
// step can't drift from the rest of the script.
export function buildDealsModule({
  bySnapshotId,
  goatBySnapshot,
  proBySnapshot,
  planRows,
  lastRefreshed,
  packageVersion,
}) {
  const modelLines = []
  for (const [id, record] of [...bySnapshotId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = modelDealEntry(record)
    const allowance = {}
    const goat = goatBySnapshot.get(id)
    const pro = proBySnapshot.get(id)
    if (goat !== undefined) allowance.goat = goat
    if (pro !== undefined) allowance.pro = pro
    if (Object.keys(allowance).length > 0) entry.allowance = allowance
    const parts = Object.entries(entry).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    modelLines.push(`  ${JSON.stringify(id)}: { ${parts.join(", ")} },`)
  }

  const planLines = []
  for (const [id, entry] of planRows) {
    for (const line of entry.note ?? []) planLines.push(`  // ${line}`)
    planLines.push(
      `  ${id}: { price: ${entry.row.price}, credits: ${entry.row.credits}, ` +
        `window5h: ${entry.row.window5h}, windowWeek: ${entry.row.windowWeek}, ` +
        `display: ${JSON.stringify(entry.row.display)} },`,
    )
  }

  return [
    "// src/deals/catalog.ts — GENERATED by scripts/refresh-deals.mjs. Do not edit.",
    "//",
    "// Deal/allowance/benchmark intelligence parsed from the Command Code docs",
    "// site (pricing-limits, plans/goat, plans/pro). Bundled so the plugin can",
    "// enrich the model picker, the sidebar panel, and the plan summary tool",
    "// without network access at runtime. Regenerate with `npm run refresh:deals`.",
    "//",
    "// PLAN_CATALOG rows are parsed from the pricing-limits usage-limits table;",
    "// rows the table cannot source carry their pin / carry-forward provenance",
    "// comment above the row (issue #229).",
    "//",
    "// Plan identity (PlanId) lives in Core — src/catalog/plans.ts — so the",
    "// provider transport can read an explicit plan pin without importing this",
    "// excisable slice (ADR-0004).",
    "",
    'import type { PlanId } from "../catalog/plans.js"',
    "",
    "export interface DealRates {",
    "  input: number",
    "  output: number",
    "  cacheRead: number",
    "  cacheWrite: number",
    "}",
    "",
    "export interface PlanInfo {",
    "  price: number",
    "  credits: number",
    "  window5h: number",
    "  windowWeek: number",
    "  /** Human-facing plan name as shown on the Command Code pricing page. */",
    "  display: string",
    "}",
    "",
    "export interface ModelDeals {",
    "  /** $/month credit allowance per plan. Absent plan = no data. */",
    "  allowance?: Partial<Record<PlanId, number>>",
    '  /** Deal metadata. endsAt: ISO date or "while capacity lasts". */',
    "  discount?: { pct: number; endsAt?: string }",
    "  /** Pre-deal list prices (for reference). */",
    "  was?: { input: number; output: number; cacheRead: number }",
    "  /** Discounted deal prices (what you pay now). */",
    "  now?: { input: number; output: number; cacheRead: number }",
    "  /** Time-varying rates (DeepSeek V4 peak/off-peak). */",
    "  peakOffPeak?: { peak: DealRates; offPeak: DealRates; windows: string }",
    "  /** Higher-context tier rates (docs: MiniMax M3 >512K). */",
    "  overContext?: DealRates",
    "  benchmark?: { intelligence?: number; tokPerSec?: number }",
    '  tier?: "opensource" | "premium"',
    "  free: boolean",
    "}",
    "",
    "export const MODEL_DEALS: Readonly<Record<string, ModelDeals>> = {",
    ...modelLines,
    "}",
    "",
    "export const PLAN_CATALOG: Readonly<Record<PlanId, PlanInfo>> = {",
    ...planLines,
    "}",
    "",
    `export const DEAL_SOURCE_URL = ${JSON.stringify(DEFAULT_RSC_PRICING_URL)}`,
    `export const DEAL_LAST_REFRESHED = ${JSON.stringify(lastRefreshed)}`,
    `export const DEAL_PACKAGE_VERSION = ${JSON.stringify(packageVersion)}`,
    "",
  ].join("\n")
}

// RSC-primary path. Parses the three RSC payloads with parse-rsc.mjs,
// applies the slug-id alias map (via extractPlanPageRsc), applies the
// tier overrides, and emits the same MODEL_DEALS shape the old HTML
// path produced. The per-plan RSC (goat, pro) is the source of truth
// for the model `id` (the vendor-prefixed form, already aliased); the
// pricing-limits RSC's availability and compact arrays carry the deal,
// tier, and allowance data. Cross-reference is by name.
//
// The pricing-limits availability array covers most models but lags the
// per-plan pages for newly-added models (e.g. Qwen 3.8 Flash and GLM
// 5.3 Flash are on the goat plan but not in the pricing-limits
// availability array as of the current fixtures). The per-plan slug
// records are merged in to fill those gaps — every model that the
// per-plan pages expose but the pricing-limits page doesn't, plus its
// tiers/deal/caps from the slug record.
//
// The snapshot index is the source of truth for which models the
// plugin actually knows about. RSC records whose id doesn't resolve to
// a snapshot id (via the per-plan slug Map or the slug-id alias) are
// dropped — they could be new models the npm package hasn't picked up
// yet, and shipping entries for unknown ids would either blow up the
// consumers or be silently filtered downstream.
export function buildRscInputs({ pricingLimitsRsc, goatRsc, proRsc }) {
  // Per-plan RSC: source of truth for the snapshot id (already
  // aliased inside extractPlanPageRsc). Union goat and pro so a model
  // that's on goat but not pro is still reachable.
  const goatSlug = extractPlanPageRsc(goatRsc ?? "")
  const proSlug = extractPlanPageRsc(proRsc ?? "")
  const slugBySnapshotId = new Map([...goatSlug, ...proSlug])
  // Pricing-limits RSC: availability (per-model records with tiers +
  // deal) and compact (per-model planAllowanceUsd.{goat,pro}).
  const { availability, compact } = extractPricingLimitsRsc(pricingLimitsRsc ?? "")
  // Snapshot index: which ids the plugin actually knows about. RSC
  // records that don't resolve to a snapshot id are dropped.
  const { byId: snapshotIds, byName: nameToSnapshotId } = snapshotIndex()
  // Reuse the snapshot-index name map for the per-plan slug records
  // (the snapshot's byName covers every model the per-plan pages
  // could expose, by name, including paid + free variants).
  for (const [sid, record] of slugBySnapshotId) {
    if (record.name) nameToSnapshotId.set(record.name, sid)
  }
  // Build bySnapshotId from availability. Each availability record
  // already carries tiers / deal / caps. Apply the tier override here
  // so `modelDealEntry` sees the final tier (the override map grows
  // in ticket #86).
  //
  // When a slug record exists for the same snapshot id, its fields
  // fill in anything the availability record doesn't carry
  // (intelligenceIndex, outputTokensPerSec, minPlanName, vendor). The
  // availability record wins on conflict because it's the more
  // recent of the two data sources.
  const bySnapshotId = new Map()
  for (const record of availability) {
    if (!record.name) continue
    const aliased = { ...record, id: applySlugIdAlias(record.id ?? "") }
    // Resolve to a snapshot id: per-plan slug Map first (vendor-prefixed,
    // already aliased), then the raw RSC id (after alias). Drop if
    // neither resolves — those are new models the snapshot doesn't
    // carry yet.
    const sid = nameToSnapshotId.get(record.name) ?? aliased.id
    if (sid === undefined || !snapshotIds.has(sid)) continue
    const slugRecord = slugBySnapshotId.get(sid)
    const merged = slugRecord ? { ...slugRecord, ...aliased, id: sid } : { ...aliased, id: sid }
    // Apply the tier override; the function falls back to record.category
    // when the snapshot id isn't in TIER_OVERRIDES.
    const tier = applyTierOverride(merged)
    bySnapshotId.set(sid, tier ? { ...merged, category: tier } : merged)
  }
  // Merge in per-plan slug records that aren't already covered. The
  // pricing-limits availability array lags the per-plan pages for some
  // models; the slug records carry the same field shape (tiers, deal,
  // caps) so they drop in directly. Slug records are already
  // snapshot-keyed (extractPlanPageRsc applies the alias and the Map
  // key is the snapshot id), so the snapshot id check is implicit.
  for (const [sid, slugRecord] of slugBySnapshotId) {
    if (bySnapshotId.has(sid)) continue
    if (!snapshotIds.has(sid)) continue
    const tier = applyTierOverride(slugRecord)
    bySnapshotId.set(
      sid,
      tier ? { ...slugRecord, id: sid, category: tier } : { ...slugRecord, id: sid },
    )
  }
  // Build the per-plan allowance maps from the compact array. The
  // compact record's `id` is also the un-prefixed form; apply the
  // alias and fall back to the name map. Drop entries that don't
  // resolve to a snapshot id.
  const goatBySnapshot = new Map()
  const proBySnapshot = new Map()
  for (const record of compact) {
    if (!record.planAllowanceUsd) continue
    const sid = nameToSnapshotId.get(record.name ?? "") ?? applySlugIdAlias(record.id ?? "")
    if (!sid || !snapshotIds.has(sid)) continue
    if (record.planAllowanceUsd.goat !== undefined)
      goatBySnapshot.set(sid, record.planAllowanceUsd.goat)
    if (record.planAllowanceUsd.pro !== undefined)
      proBySnapshot.set(sid, record.planAllowanceUsd.pro)
  }
  return { bySnapshotId, goatBySnapshot, proBySnapshot }
}

export function emitDealsModuleFromRsc({
  pricingLimitsRsc,
  goatRsc,
  proRsc,
  previousPlanRows = new Map(),
  lastRefreshed,
  packageVersion,
}) {
  const { bySnapshotId, goatBySnapshot, proBySnapshot } = buildRscInputs({
    pricingLimitsRsc,
    goatRsc,
    proRsc,
  })
  const { rows: planRows } = planRowsFromRsc({ pricingLimitsRsc, previousRows: previousPlanRows })
  return buildDealsModule({
    bySnapshotId,
    goatBySnapshot,
    proBySnapshot,
    planRows,
    lastRefreshed,
    packageVersion,
  })
}

// The previously emitted PLAN_CATALOG rows at `out`, for the carry-forward
// step above. A missing or unreadable file simply means there is nothing to
// carry forward.
async function readPreviousPlanRows(out) {
  try {
    return parsePreviousPlanRows(await readFile(out, "utf-8"))
  } catch {
    return new Map()
  }
}

async function main() {
  // RSC source resolution runs through the shared record source
  // (scripts/rsc-source.mjs): --fixtures reads the committed fixtures
  // offline; live fetch follows the ADR-0005 semantics (5xx/network →
  // committed fixtures; 4xx → loud RscHttpError that propagates out of
  // main and exits non-zero before anything is written).
  const fixturesMode = process.argv.includes("--fixtures")
  const urls = {}
  for (const key of ["pricing", "goat", "pro"]) {
    const page = RSC_PAGES[key]
    const override = process.env[page.env]
    if (override) urls[key] = override
  }
  let pricingRsc
  let goatRsc
  let proRsc
  try {
    ;({
      pricing: pricingRsc,
      goat: goatRsc,
      pro: proRsc,
    } = await loadRscPages({
      keys: ["pricing", "goat", "pro"],
      mode: fixturesMode ? "fixtures" : "live",
      urls,
      fixturesDir: argValue("--fixtures-dir"),
      prefix: "refresh-deals",
    }))
  } catch (error) {
    console.error(`refresh-deals: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const out = argValue("--out") ?? DEFAULT_OUT

  // Plan rows (issue #229). The usage-limits table is parsed before the model
  // try/catch: a missing table, a renamed header, or an unreadable cell is a
  // parser shape change and must abort the refresh loudly (ADR-0008), never
  // degrade to the empty-catalog fallback below. A table row the vocabulary
  // does not know, and a PlanId no source carries, are pending reports — the
  // row is never silently dropped (the #132 superset discipline); a PlanId
  // with no source after the full table → pin → carried-forward ladder is an
  // unshippable plan row and aborts.
  const {
    rows: planRows,
    unmatched,
    carriedForward,
  } = planRowsFromRsc({
    pricingLimitsRsc: pricingRsc,
    previousRows: await readPreviousPlanRows(out),
  })
  if (unmatched.length > 0) {
    console.log(
      `refresh-deals: plan table pending — ${unmatched.length} docs table row(s) map to no ` +
        `PlanId: ${unmatched.map((row) => `"${row.display}"`).join(", ")}. Add the PlanId and ` +
        `its aliases to src/catalog/plans.ts and PLAN_LABEL_TO_ID in scripts/refresh-deals.mjs ` +
        `to ship them.`,
    )
  }
  if (carriedForward.length > 0) {
    console.log(
      `refresh-deals: plan table pending — no live source carries ${carriedForward.join(", ")}; ` +
        `carried forward the last emitted row(s). Re-pin or prune the PlanId (issue #229).`,
    )
  }

  let module
  try {
    // Build the inputs once — the pending report consumes
    // bySnapshotId, and the emit step consumes the same map plus
    // the allowance maps.
    const { bySnapshotId, goatBySnapshot, proBySnapshot } = buildRscInputs({
      pricingLimitsRsc: pricingRsc,
      goatRsc,
      proRsc,
    })
    // Deals are a subset of membership (issue #132): a snapshot model with
    // no RSC record simply skips enrichment — the picker/sidebar keep the
    // core entry and the missing record is reported as a pending line,
    // NEVER an abort. (The old coverage gate exited 1 here; the parent
    // spec #129's only loud classes are an unshippable ship-bar row and a
    // parser shape change.) `--allow-partial` remains an accepted no-op for
    // callers that passed it historically.
    const { missing, covered } = missingSnapshotModels(bySnapshotId)
    if (missing.length > 0) {
      console.log(
        `refresh-deals: deals pending — ${missing.length} snapshot model(s) have no RSC record ` +
          `(${covered}/${covered + missing.length} covered): ${missing.join(", ")}. ` +
          `These models ship core-only (enrichment skipped) until the docs/RSC ` +
          `fixtures carry them.`,
      )
    }
    module = buildDealsModule({
      bySnapshotId,
      goatBySnapshot,
      proBySnapshot,
      planRows,
      lastRefreshed: new Date().toISOString().split("T")[0],
      packageVersion: "docs",
    })
  } catch (error) {
    console.warn(
      `refresh-deals: warning — failed to parse RSC data (${error instanceof Error ? error.message : String(error)}) — emitting empty catalog`,
    )
    module = buildDealsModule({
      bySnapshotId: new Map(),
      goatBySnapshot: new Map(),
      proBySnapshot: new Map(),
      planRows,
      lastRefreshed: new Date().toISOString().split("T")[0],
      packageVersion: "docs",
    })
  }
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, module, "utf-8")
  let writtenCount = 0
  try {
    // Report the number of models actually written — count unique
    // snapshot ids in the availability array.
    const { availability } = extractPricingLimitsRsc(pricingRsc)
    writtenCount = availability?.length ?? 0
  } catch {
    writtenCount = 0
  }
  console.log(`refresh-deals: wrote ${writtenCount} model entries to ${out}`)
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`refresh-deals: ${error.message}`)
    process.exit(1)
  })
}
