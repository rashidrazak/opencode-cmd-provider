// scripts/refresh-deals.mjs — regenerate src/deals/catalog.ts (Deals slice)
// from the Command Code docs pages (pricing-limits, plans/goat, plans/pro).
// Runs at release time; never at runtime. Independent of
// refresh-snapshot.mjs — a failure here never blocks the snapshot release or
// vice versa.
//
// Usage: node scripts/refresh-deals.mjs [--out path] [--fixtures]
//   --fixtures regenerates from tests/fixtures/*.html (offline)
//   --allow-partial  do not fail on snapshot models missing from the scraped
//                    records (off for the standalone refresh so a partial
//                    catalog can never be committed silently)
//   env COMMANDCODE_DEALS_PRICING_URL   overrides the pricing-limits page URL
//   env COMMANDCODE_DEALS_GOAT_URL      overrides the goat plan page URL
//   env COMMANDCODE_DEALS_PRO_URL       overrides the pro plan page URL
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
import { readFileSync } from "node:fs"
import { snapshotIndex } from "./snapshot-index.mjs"

const DEFAULT_PRICING_URL = "https://commandcode.ai/docs/resources/pricing-limits"
const DEFAULT_GOAT_URL = "https://commandcode.ai/docs/plans/goat"
const DEFAULT_PRO_URL = "https://commandcode.ai/docs/plans/pro"
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

async function readFixtures() {
  const fixtures = resolve(import.meta.dirname, "..", "tests", "fixtures")
  const [pricingHtml, goatHtml, proHtml] = await Promise.all([
    readFile(resolve(fixtures, "pricing-limits.html"), "utf-8"),
    readFile(resolve(fixtures, "goat.html"), "utf-8"),
    readFile(resolve(fixtures, "pro.html"), "utf-8"),
  ])
  return { pricingHtml, goatHtml, proHtml }
}

async function main() {
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

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`refresh-deals: ${error.message}`)
    process.exit(1)
  })
}
