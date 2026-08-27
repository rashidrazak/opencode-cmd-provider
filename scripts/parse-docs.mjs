// scripts/parse-docs.mjs — Command Code docs page parsers for the deals
// catalog. The docs pages (plans/goat, plans/pro, pricing-limits) embed full
// per-model records as escaped JSON in the Next.js flight payload; we decode
// that instead of scraping HTML tables for the model-level data, and read the
// rendered allowance tables for plan credits.
//
// The shared JSON depth-state-machine lives in json-stream.mjs; this module
// is the HTML-allowance-table half of the legacy deals pipeline. The RSC
// surface (pricing-limits availability + compact arrays, per-plan slug
// records) lives in parse-rsc.mjs.
import { extractTables, parseMoney } from "./html-tables.mjs"
import { parseJsonValue } from "./json-stream.mjs"

function decodeEscapedJson(html) {
  // The flight payload escapes quotes/newlines inside script text as \" and \n.
  return html.replaceAll('\\"', '"').replaceAll("\\n", "\n").replaceAll("\\u0026", "&")
}

export function extractModelRecords(html) {
  const text = decodeEscapedJson(html)
  const records = new Map()
  // The legacy HTML path scans the page for each `{"slug":...}` object
  // separately — the flight payload embeds them as standalone objects
  // rather than a single top-level array. The shared parseJsonValue helper
  // from json-stream.mjs does the brace-balancing and JSON.parse once per
  // match, so there's no duplicated state-machine here.
  for (let i = 0; i < text.length; i++) {
    if (!text.startsWith('{"slug":"', i)) continue
    const parsed = parseJsonValue(text, i)
    if (!parsed || typeof parsed.value.id !== "string") continue
    records.set(parsed.value.id, parsed.value)
    i = parsed.end - 1
  }
  // The docs `id` for Claude Haiku omits the snapshot's version suffix; callers
  // that need snapshot-keyed data should map names to snapshot ids separately.
  return records
}

export function extractPlanAllowances(html) {
  // Returns { modelName: credits } from every "Monthly credits" table on the
  // page (the page splits models across several tables).
  const out = new Map()
  for (const table of extractTables(html)) {
    const header = table[0]
    if (!header || header[0] !== "Model" || !header.includes("Monthly credits")) continue
    for (const row of table.slice(1)) {
      const credits = parseMoney(row[5])
      if (credits !== null) out.set(row[0], credits)
    }
  }
  return out
}

export function snapshotIdByName(snapshotIds, snapshotNames) {
  // Snapshot ids are the source of truth (the plugin's configured model ids).
  // The docs pages use names as the stable key; ids diverge for version-suffixed
  // snapshots like claude-haiku-4-5-20251001. Map name → snapshot id.
  const nameToId = new Map()
  for (let i = 0; i < snapshotIds.length; i++) {
    nameToId.set(snapshotNames[i], snapshotIds[i])
  }
  return nameToId
}

const undefinedTokens = new Set(["$undefined", "undefined", "null"])

export function num(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  if (undefinedTokens.has(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function endsAtFor(deal) {
  if (!deal || typeof deal !== "object") return undefined
  if (deal.free === true) return "while capacity lasts"
  const term = typeof deal.term === "string" ? deal.term : ""
  if (term.includes("permanent")) return undefined
  if (typeof deal.expires === "string") return deal.expires.slice(0, 10)
  return undefined
}

export function ratesFor(tier) {
  if (!tier || typeof tier.rates !== "object") return undefined
  const input = num(tier.rates.input)
  const output = num(tier.rates.output)
  const cacheRead = num(tier.rates.cacheRead)
  if (input === undefined || output === undefined) return undefined
  return { input, output, cacheRead: cacheRead ?? 0 }
}

export function benchmarkFor(record) {
  const intelligence = num(record.intelligenceIndex)
  const tokPerSec = num(record.outputTokensPerSec)
  if (intelligence === undefined && tokPerSec === undefined) return undefined
  return {
    ...(intelligence !== undefined ? { intelligence } : {}),
    ...(tokPerSec !== undefined ? { tokPerSec } : {}),
  }
}
