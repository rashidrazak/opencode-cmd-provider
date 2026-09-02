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
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { num, ratesFor, benchmarkFor, endsAtFor } from "./parse-docs.mjs"
import { applySlugIdAlias, extractPlanPageRsc, extractPricingLimitsRsc } from "./parse-rsc.mjs"
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
// the gate itself lives in the shared record source so the classification
// generator reuses it without importing from the Deals generator
// (issue #109). `bySnapshotId` is the Map built by `buildRscInputs` (the
// records are already snapshot-keyed by extractPlanPageRsc, which applies
// the slug-id alias). A partial catalog silently drops the TUI sidebar
// "Command Code" section for the missing models, so refresh must fail
// loudly instead of emitting a partial catalog (issue: Ox Alpha /
// DeepSeek V4 Flash Vision (exp) showed no section because the fixtures
// predated them). `--allow-partial` overrides for tooling that must not
// exit non-zero (e.g. the release pipeline's non-blocking deals check).
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

// Builds the deals module text from already-normalised inputs. The
// template (PLAN_CATALOG, interfaces, header) lives here so the emit
// step can't drift from the rest of the script.
export function buildDealsModule({
  bySnapshotId,
  goatBySnapshot,
  proBySnapshot,
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

  return [
    "// src/deals/catalog.ts — GENERATED by scripts/refresh-deals.mjs. Do not edit.",
    "//",
    "// Deal/allowance/benchmark intelligence parsed from the Command Code docs",
    "// site (pricing-limits, plans/goat, plans/pro). Bundled so the plugin can",
    "// enrich the model picker, the sidebar panel, and the plan summary tool",
    "// without network access at runtime. Regenerate with `npm run refresh:deals`.",
    "",
    'export type PlanId = "go" | "goat" | "pro" | "max" | "max20" | "teampro" | "provider"',
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
    '  go: { price: 1, credits: 10, window5h: 3, windowWeek: 6, display: "Go" },',
    '  goat: { price: 10, credits: 70, window5h: 14, windowWeek: 35, display: "GOAT" },',
    '  pro: { price: 20, credits: 80, window5h: 16, windowWeek: 40, display: "Pro" },',
    '  max: { price: 100, credits: 150, window5h: 45, windowWeek: 90, display: "Max 10×" },',
    '  max20: { price: 200, credits: 300, window5h: 90, windowWeek: 180, display: "Max 20×" },',
    '  teampro: { price: 40, credits: 40, window5h: 12, windowWeek: 24, display: "Team Pro" },',
    '  provider: { price: 15, credits: 0, window5h: 0, windowWeek: 0, display: "Provider" },',
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
  lastRefreshed,
  packageVersion,
}) {
  const { bySnapshotId, goatBySnapshot, proBySnapshot } = buildRscInputs({
    pricingLimitsRsc,
    goatRsc,
    proRsc,
  })
  return buildDealsModule({
    bySnapshotId,
    goatBySnapshot,
    proBySnapshot,
    lastRefreshed,
    packageVersion,
  })
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
      prefix: "refresh-deals",
    }))
  } catch (error) {
    console.error(`refresh-deals: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const out = argValue("--out") ?? DEFAULT_OUT
  let module
  try {
    // Build the inputs once — the coverage gate consumes
    // bySnapshotId, and the emit step consumes the same map plus
    // the allowance maps.
    const { bySnapshotId, goatBySnapshot, proBySnapshot } = buildRscInputs({
      pricingLimitsRsc: pricingRsc,
      goatRsc,
      proRsc,
    })
    // Coverage gate: a partial catalog silently drops the TUI sidebar
    // "Command Code" section for the missing models. The RSC path
    // keys records by snapshot id directly (extractPlanPageRsc
    // applies the alias), so the gate is a direct id-set comparison
    // via the shared missingSnapshotModels gate.
    if (!process.argv.includes("--allow-partial")) {
      const { missing, covered } = missingSnapshotModels(bySnapshotId)
      if (missing.length > 0) {
        console.error(
          `refresh-deals: aborting — ${missing.length} snapshot model(s) have no RSC record ` +
            `(${covered}/${covered + missing.length} covered): ${missing.join(", ")}. ` +
            `The docs may have added models without exposing them in the RSC, or the ` +
            `RSC fixtures are stale. Re-run against live docs or refresh the RSC fixtures ` +
            `before regenerating; the generated catalog would silently hide the Command Code ` +
            `sidebar section for these models.`,
        )
        process.exit(1)
      }
    }
    module = buildDealsModule({
      bySnapshotId,
      goatBySnapshot,
      proBySnapshot,
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
