// scripts/refresh-deals.mjs — regenerate src/deals/catalog.ts (Deals slice)
// from the Command Code docs pages (pricing-limits, plans/goat, plans/pro).
// Runs at release time; never at runtime. Independent of
// refresh-snapshot.mjs — a failure here never blocks the snapshot release or
// vice versa.
//
// Usage: node scripts/refresh-deals.mjs [--out path] [--fixtures]
//   --fixtures regenerates from committed fixtures (offline)
//   --allow-partial  do not fail on snapshot models missing from the scraped
//                    records (off for the standalone refresh so a partial
//                    catalog can never be committed silently)
//   env COMMANDCODE_DEALS_PRICING_URL   overrides the HTML pricing-limits page URL
//   env COMMANDCODE_DEALS_GOAT_URL      overrides the HTML goat plan page URL
//   env COMMANDCODE_DEALS_PRO_URL       overrides the HTML pro plan page URL
//   env COMMANDCODE_RSC_PRICING_URL     overrides the RSC pricing-limits endpoint
//   env COMMANDCODE_RSC_GOAT_URL        overrides the RSC goat plan endpoint
//   env COMMANDCODE_RSC_PRO_URL         overrides the RSC pro plan endpoint
//
// When all three RSC env vars are set, the script takes the RSC-primary
// path (scripts/parse-rsc.mjs); otherwise the HTML path is used. The two
// paths produce the same MODEL_DEALS shape; the RSC path is strictly
// more complete because the RSC's `planAllowanceUsd.{goat,pro}` field
// covers every paid model, while the HTML tables only list a subset.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  benchmarkFor,
  endsAtFor,
  extractModelRecords,
  extractPlanAllowances,
  num,
  ratesFor,
} from "./parse-docs.mjs"
import { applySlugIdAlias, extractPlanPageRsc, extractPricingLimitsRsc } from "./parse-rsc.mjs"
import { applyTierOverride } from "./tier-overrides.mjs"
import { readFileSync } from "node:fs"
import { snapshotIndex } from "./snapshot-index.mjs"

const DEFAULT_PRICING_URL = "https://commandcode.ai/docs/resources/pricing-limits"
const DEFAULT_GOAT_URL = "https://commandcode.ai/docs/plans/goat"
const DEFAULT_PRO_URL = "https://commandcode.ai/docs/plans/pro"
const DEFAULT_RSC_PRICING_URL = "https://commandcode.ai/docs/rsc/pricing-limits"
const DEFAULT_RSC_GOAT_URL = "https://commandcode.ai/docs/rsc/plans/goat"
const DEFAULT_RSC_PRO_URL = "https://commandcode.ai/docs/rsc/plans/pro"
const DEFAULT_OUT = resolve(import.meta.dirname, "..", "src", "deals", "catalog.ts")

// Missing snapshot models in the chosen records source. Returns
// `{ missing, covered }`: `missing` is the list of snapshot ids that have no
// docs record in `records`; `covered` is the count of snapshot models the
// records do cover. A partial catalog silently drops the TUI sidebar
// "Command Code" section for the missing models, so refresh must fail loudly
// instead of emitting a partial catalog (issue: Ox Alpha / DeepSeek V4 Flash
// Vision (exp) showed no section because the fixtures predated them).
export function missingDealsModels(records) {
  const { byId, nameCounts } = snapshotIndex()
  const ids = new Set([...records.values()].map((record) => record.id))
  const names = new Set([...records.values()].map((record) => record.name))
  const missing = []
  for (const [id, name] of byId) {
    // Match by id first: free variants share display names with their paid
    // siblings (MiniMax M3 / M2.7) but carry unique ids, so only an id match
    // proves the right docs record exists. The name fallback applies only to
    // unambiguous names (legacy id mismatches like claude-haiku-4-5 docs →
    // claude-haiku-4-5-20251001 snapshot).
    const covered = ids.has(id) || (nameCounts.get(name) === 1 && names.has(name))
    if (!covered) missing.push(id)
  }
  return { missing, covered: byId.size - missing.length }
}

// RSC equivalent of `missingDealsModels`: the records are already
// snapshot-keyed (extractPlanPageRsc applies the slug-id alias), so the
// gate is a direct id-set comparison. `bySnapshotId` is the Map built
// inside `emitDealsModuleFromRsc`; the function is exported so the gate
// can be exercised independently of the emit step.
export function missingDealsModelsFromRsc(bySnapshotId) {
  const { byId } = snapshotIndex()
  const present = new Set(bySnapshotId.keys())
  const missing = []
  for (const [id] of byId) {
    if (!present.has(id)) missing.push(id)
  }
  return { missing, covered: byId.size - missing.length }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function fetchOrFail(url, label) {
  let response
  try {
    response = await fetch(url, { headers: { accept: "text/html" } })
  } catch (error) {
    console.error(`refresh-deals: could not fetch ${label} (${url}): ${error.message}`)
    return ""
  }
  if (!response.ok) {
    console.error(`refresh-deals: ${label} returned ${response.status} — skipping`)
    return ""
  }
  return response.text()
}

// Deal-term → discount endsAt. The docs use free-form terms; keep the ISO date
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

export function emitDealsModule({
  pricingLimitsHtml,
  goatHtml,
  proHtml,
  lastRefreshed,
  packageVersion,
}) {
  const goatRecords = extractModelRecords(goatHtml)
  const pricingRecords = extractModelRecords(pricingLimitsHtml)
  const records = goatRecords.size >= pricingRecords.size ? goatRecords : pricingRecords
  // Map docs name → snapshot id (snapshot is the source of truth for model ids).
  const { byName: nameToSnapshotId, byId: snapshotIds } = snapshotIndex()
  // Some docs ids (e.g. claude-haiku-4-5) diverge from the snapshot id
  // (claude-haiku-4-5-20251001), so the name-based map catches those. When
  // multiple snapshot entries share a name (paid + free variants like
  // MiniMaxAI/MiniMax-M3 + minimax/minimax-m3-free), the docs id resolves
  // the ambiguity: each fixture record carries its own id, so we prefer it
  // when it matches a known snapshot id, and fall back to the name map
  // otherwise.
  const bySnapshotId = new Map()
  for (const record of records.values()) {
    const sid =
      (record.id && snapshotIds.has(record.id) ? record.id : undefined) ??
      nameToSnapshotId.get(record.name) ??
      record.id
    // A record that resolves to no snapshot id cannot be keyed — skip it
    // rather than collapsing every such record under `undefined`.
    if (sid === undefined) continue
    bySnapshotId.set(sid, { ...record, name: record.name })
  }
  // Allowances keyed by snapshot id.
  const goatAllowances = extractPlanAllowances(goatHtml)
  const proAllowances = extractPlanAllowances(proHtml)
  const goatBySnapshot = new Map()
  const proBySnapshot = new Map()
  for (const [name, credits] of goatAllowances.entries()) {
    const sid = nameToSnapshotId.get(name)
    if (sid) goatBySnapshot.set(sid, credits)
  }
  for (const [name, credits] of proAllowances.entries()) {
    const sid = nameToSnapshotId.get(name)
    if (sid) proBySnapshot.set(sid, credits)
  }
  return buildDealsModule({
    bySnapshotId,
    goatBySnapshot,
    proBySnapshot,
    lastRefreshed,
    packageVersion,
  })
}

// Builds the deals module text from already-normalised inputs. Both the
// HTML and RSC paths produce a `bySnapshotId` Map (snapshot-id → record)
// plus `goatBySnapshot` / `proBySnapshot` Maps (snapshot-id → credits),
// then call this function. The template (PLAN_CATALOG, interfaces, header)
// lives here so the two paths can't drift.
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
    `export const DEAL_SOURCE_URL = ${JSON.stringify(DEFAULT_PRICING_URL)}`,
    `export const DEAL_LAST_REFRESHED = ${JSON.stringify(lastRefreshed)}`,
    `export const DEAL_PACKAGE_VERSION = ${JSON.stringify(packageVersion)}`,
    "",
  ].join("\n")
}

// RSC-primary path: parses the three RSC payloads with parse-rsc.mjs,
// applies the slug-id alias map, applies the tier overrides, and emits
// the same MODEL_DEALS shape as the HTML path. The per-plan RSC (goat,
// pro) is the source of truth for the model `id` (the vendor-prefixed
// form); the pricing-limits RSC's availability and compact arrays carry
// the deal, tier, and allowance data. Cross-reference is by name.
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
//
// This is the expand half of the HTML → RSC switch (ticket #82 on the
// wayfinder map). The HTML path stays in place behind the same module
// surface for ticket #83's contract step (and for the offline --fixtures
// fallback to HTML when the RSC env vars are unset).
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
  // already carries tiers / deal / caps — the same fields the HTML
  // path's `extractModelRecords` produced. Apply the tier override
  // here so `modelDealEntry` sees the final tier (the override map
  // grows in ticket #86).
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

async function readFixtures() {
  const fixtures = resolve(import.meta.dirname, "..", "tests", "fixtures")
  const [pricingHtml, goatHtml, proHtml] = await Promise.all([
    readFile(resolve(fixtures, "pricing-limits.html"), "utf-8"),
    readFile(resolve(fixtures, "goat.html"), "utf-8"),
    readFile(resolve(fixtures, "pro.html"), "utf-8"),
  ])
  return { pricingHtml, goatHtml, proHtml }
}

async function readRscFixtures() {
  const fixtures = resolve(import.meta.dirname, "..", "tests", "fixtures")
  const [pricingRsc, goatRsc, proRsc] = await Promise.all([
    readFile(resolve(fixtures, "rsc-pricing-limits.txt"), "utf-8"),
    readFile(resolve(fixtures, "rsc-goat.txt"), "utf-8"),
    readFile(resolve(fixtures, "rsc-pro.txt"), "utf-8"),
  ])
  return { pricingRsc, goatRsc, proRsc }
}

async function fetchRscOrFail(url, label) {
  let response
  try {
    response = await fetch(url, { headers: { rsc: "1" } })
  } catch (error) {
    console.error(`refresh-deals: could not fetch RSC ${label} (${url}): ${error.message}`)
    return ""
  }
  if (!response.ok) {
    console.error(`refresh-deals: RSC ${label} returned ${response.status} — skipping`)
    return ""
  }
  return response.text()
}

async function main() {
  // The RSC-primary path is gated on all three RSC env vars being set.
  // When any is missing, the HTML path is used. This is the expand half
  // of the HTML → RSC switch (ticket #82 on the wayfinder map); the
  // contract step (ticket #83) flips the default and removes the HTML
  // path entirely.
  const rscEnvSet = Boolean(
    process.env.COMMANDCODE_RSC_PRICING_URL &&
    process.env.COMMANDCODE_RSC_GOAT_URL &&
    process.env.COMMANDCODE_RSC_PRO_URL,
  )
  if (rscEnvSet) {
    await runRscPath()
  } else {
    await runHtmlPath()
  }
}

async function runHtmlPath() {
  let pricingHtml
  let goatHtml
  let proHtml
  if (process.argv.includes("--fixtures")) {
    try {
      ;({ pricingHtml, goatHtml, proHtml } = await readFixtures())
    } catch (error) {
      console.warn(
        `refresh-deals: warning — could not read fixtures (${error instanceof Error ? error.message : String(error)}) — emitting empty deals catalog`,
      )
      pricingHtml = ""
      goatHtml = ""
      proHtml = ""
    }
  } else {
    const pricingUrl = process.env.COMMANDCODE_DEALS_PRICING_URL ?? DEFAULT_PRICING_URL
    const goatUrl = process.env.COMMANDCODE_DEALS_GOAT_URL ?? DEFAULT_GOAT_URL
    const proUrl = process.env.COMMANDCODE_DEALS_PRO_URL ?? DEFAULT_PRO_URL
    let livePricingHtml
    let liveGoatHtml
    let liveProHtml
    try {
      ;[livePricingHtml, liveGoatHtml, liveProHtml] = await Promise.all([
        fetchOrFail(pricingUrl, "pricing-limits"),
        fetchOrFail(goatUrl, "goat plan"),
        fetchOrFail(proUrl, "pro plan"),
      ])
    } catch (error) {
      console.warn(
        `refresh-deals: warning — live fetch threw (${error instanceof Error ? error.message : String(error)}) — falling back to fixtures`,
      )
      livePricingHtml = ""
      liveGoatHtml = ""
      liveProHtml = ""
    }
    const anyEmpty = !livePricingHtml || !liveGoatHtml || !liveProHtml
    let liveRecordsEmpty = false
    try {
      const goatSize = extractModelRecords(liveGoatHtml).size
      // pricing-limits historically yields 0 records; only goat matters for mitigation detection
      if (goatSize === 0) liveRecordsEmpty = true
    } catch {
      liveRecordsEmpty = true
    }
    if (anyEmpty || liveRecordsEmpty) {
      console.warn(
        "refresh-deals: warning — live fetch failed or returned no model records — falling back to fixtures",
      )
      try {
        ;({ pricingHtml, goatHtml, proHtml } = await readFixtures())
        console.warn("refresh-deals: warning — using fixtures for deals catalog")
      } catch (error) {
        console.warn(
          `refresh-deals: warning — fixtures unavailable (${error instanceof Error ? error.message : String(error)}) — emitting empty deals catalog`,
        )
        pricingHtml = ""
        goatHtml = ""
        proHtml = ""
      }
    } else {
      pricingHtml = livePricingHtml
      goatHtml = liveGoatHtml
      proHtml = liveProHtml
    }
  }

  const out = argValue("--out") ?? DEFAULT_OUT
  // Fail loudly before writing when the resolved input lacks snapshot models —
  // a partial deals catalog silently drops the TUI sidebar "Command Code"
  // section for the missing models (issue: Ox Alpha / DeepSeek V4 Flash
  // Vision (exp)). `--allow-partial` overrides for tooling that must not exit
  // non-zero (e.g. the release pipeline's non-blocking deals check).
  if (!process.argv.includes("--allow-partial")) {
    const records = extractModelRecords(goatHtml)
    const { missing, covered } = missingDealsModels(records)
    if (missing.length > 0) {
      console.error(
        `refresh-deals: aborting — ${missing.length} snapshot model(s) have no deals record ` +
          `(${covered}/${covered + missing.length} covered): ${missing.join(", ")}. ` +
          `The docs may have added models without rendering them on the scraped pages, or the ` +
          `fixtures are stale. Re-run against live docs or refresh the fixtures before ` +
          `regenerating; the generated catalog would silently hide the Command Code sidebar ` +
          `section for these models.`,
      )
      process.exit(1)
    }
  }
  let module
  try {
    module = emitDealsModule({
      pricingLimitsHtml: pricingHtml,
      goatHtml,
      proHtml,
      lastRefreshed: new Date().toISOString().split("T")[0],
      packageVersion: "docs",
    })
  } catch (error) {
    console.warn(
      `refresh-deals: warning — failed to parse deals data (${error instanceof Error ? error.message : String(error)}) — emitting empty catalog`,
    )
    module = emitDealsModule({
      pricingLimitsHtml: "",
      goatHtml: "",
      proHtml: "",
      lastRefreshed: new Date().toISOString().split("T")[0],
      packageVersion: "docs",
    })
  }
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, module, "utf-8")
  // goatHtml may be empty on fallback — report the actual written entry count from the parsed module inputs
  let writtenCount = 0
  try {
    writtenCount = extractModelRecords(goatHtml).size
  } catch {
    writtenCount = 0
  }
  console.log(`refresh-deals: wrote ${writtenCount} model entries to ${out}`)
}

async function runRscPath() {
  let pricingRsc
  let goatRsc
  let proRsc
  if (process.argv.includes("--fixtures")) {
    try {
      ;({ pricingRsc, goatRsc, proRsc } = await readRscFixtures())
    } catch (error) {
      console.warn(
        `refresh-deals: warning — could not read RSC fixtures (${error instanceof Error ? error.message : String(error)}) — emitting empty deals catalog`,
      )
      pricingRsc = ""
      goatRsc = ""
      proRsc = ""
    }
  } else {
    const pricingUrl = process.env.COMMANDCODE_RSC_PRICING_URL ?? DEFAULT_RSC_PRICING_URL
    const goatUrl = process.env.COMMANDCODE_RSC_GOAT_URL ?? DEFAULT_RSC_GOAT_URL
    const proUrl = process.env.COMMANDCODE_RSC_PRO_URL ?? DEFAULT_RSC_PRO_URL
    let livePricingRsc
    let liveGoatRsc
    let liveProRsc
    try {
      ;[livePricingRsc, liveGoatRsc, liveProRsc] = await Promise.all([
        fetchRscOrFail(pricingUrl, "pricing-limits"),
        fetchRscOrFail(goatUrl, "plans/goat"),
        fetchRscOrFail(proUrl, "plans/pro"),
      ])
    } catch (error) {
      console.warn(
        `refresh-deals: warning — RSC live fetch threw (${error instanceof Error ? error.message : String(error)}) — falling back to RSC fixtures`,
      )
      livePricingRsc = ""
      liveGoatRsc = ""
      liveProRsc = ""
    }
    const anyEmpty = !livePricingRsc || !liveGoatRsc || !liveProRsc
    if (anyEmpty) {
      console.warn("refresh-deals: warning — RSC live fetch failed — falling back to RSC fixtures")
      try {
        ;({ pricingRsc, goatRsc, proRsc } = await readRscFixtures())
        console.warn("refresh-deals: warning — using RSC fixtures for deals catalog")
      } catch (error) {
        console.warn(
          `refresh-deals: warning — RSC fixtures unavailable (${error instanceof Error ? error.message : String(error)}) — emitting empty deals catalog`,
        )
        pricingRsc = ""
        goatRsc = ""
        proRsc = ""
      }
    } else {
      pricingRsc = livePricingRsc
      goatRsc = liveGoatRsc
      proRsc = liveProRsc
    }
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
    // Same coverage gate as the HTML path: a partial catalog silently
    // drops the TUI sidebar "Command Code" section for the missing
    // models. The RSC path keys records by snapshot id directly
    // (extractPlanPageRsc applies the alias), so the gate is a direct
    // id-set comparison via missingDealsModelsFromRsc.
    if (!process.argv.includes("--allow-partial")) {
      const { missing, covered } = missingDealsModelsFromRsc(bySnapshotId)
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
    module = emitDealsModule({
      pricingLimitsHtml: "",
      goatHtml: "",
      proHtml: "",
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
