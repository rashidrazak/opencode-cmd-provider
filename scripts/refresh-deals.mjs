// scripts/refresh-deals.mjs — regenerate src/catalog/deals.ts from the Command
// Code docs pages (pricing-limits, plans/goat, plans/pro). Runs at release
// time; never at runtime. Independent of refresh-snapshot.mjs — a failure here
// never blocks the snapshot release or vice versa.
//
// Usage: node scripts/refresh-deals.mjs [--out path] [--fixtures]
//   --fixtures regenerates from tests/fixtures/*.html (offline)
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

const DEFAULT_PRICING_URL = "https://commandcode.ai/docs/resources/pricing-limits"
const DEFAULT_GOAT_URL = "https://commandcode.ai/docs/plans/goat"
const DEFAULT_PRO_URL = "https://commandcode.ai/docs/plans/pro"
const DEFAULT_OUT = resolve(import.meta.dirname, "..", "src", "catalog", "deals.ts")

// Snapshot ids and names, as used by the opencode provider config. Deals keys
// must match these ids; docs records carry ids with different slugs for some
// models (e.g. claude-haiku-4-5 vs snapshot's claude-haiku-4-5-20251001), so we
// map docs → snapshot by stable display name.
function snapshotIdsByName() {
  const text = readFileSync(
    resolve(import.meta.dirname, "..", "src", "catalog", "snapshot.ts"),
    "utf-8",
  )
  const map = new Map()
  for (const m of text.matchAll(/\{ id: "([^"]+)", name: "([^"]+)",/g)) {
    map.set(m[2], m[1])
  }
  return map
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
  const nameToSnapshotId = snapshotIdsByName()
  const bySnapshotId = new Map()
  for (const record of records.values()) {
    const sid = nameToSnapshotId.get(record.name) ?? record.id
    bySnapshotId.set(sid, {
      ...record,
      name: nameToSnapshotId.has(record.name) ? record.name : record.name,
    })
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
    "// src/catalog/deals.ts — GENERATED by scripts/refresh-deals.mjs. Do not edit.",
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

async function main() {
  let pricingHtml
  let goatHtml
  let proHtml
  if (process.argv.includes("--fixtures")) {
    const fixtures = resolve(import.meta.dirname, "..", "tests", "fixtures")
    pricingHtml = await readFile(resolve(fixtures, "pricing-limits.html"), "utf-8")
    goatHtml = await readFile(resolve(fixtures, "goat.html"), "utf-8")
    proHtml = await readFile(resolve(fixtures, "pro.html"), "utf-8")
  } else {
    const pricingUrl = process.env.COMMANDCODE_DEALS_PRICING_URL ?? DEFAULT_PRICING_URL
    const goatUrl = process.env.COMMANDCODE_DEALS_GOAT_URL ?? DEFAULT_GOAT_URL
    const proUrl = process.env.COMMANDCODE_DEALS_PRO_URL ?? DEFAULT_PRO_URL
    ;[pricingHtml, goatHtml, proHtml] = await Promise.all([
      fetchOrFail(pricingUrl, "pricing-limits"),
      fetchOrFail(goatUrl, "goat plan"),
      fetchOrFail(proUrl, "pro plan"),
    ])
  }

  const out = argValue("--out") ?? DEFAULT_OUT
  const module = emitDealsModule({
    pricingLimitsHtml: pricingHtml,
    goatHtml,
    proHtml,
    lastRefreshed: new Date().toISOString().split("T")[0],
    packageVersion: "docs",
  })
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, module, "utf-8")
  console.log(`refresh-deals: wrote ${extractModelRecords(goatHtml).size} model entries to ${out}`)
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`refresh-deals: ${error.message}`)
    process.exit(1)
  })
}
