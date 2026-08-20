// scripts/parse-docs.mjs — Command Code docs page parsers for the deals
// catalog. The docs pages (plans/goat, plans/pro, pricing-limits) embed full
// per-model records as escaped JSON in the Next.js flight payload; we decode
// that instead of scraping HTML tables for the model-level data, and read the
// rendered allowance tables for plan credits.
import { extractTables, parseMoney } from "./html-tables.mjs"

function decodeEscapedJson(html) {
  // The flight payload escapes quotes/newlines inside script text as \" and \n.
  return html.replaceAll('\\"', '"').replaceAll("\\n", "\n").replaceAll("\\u0026", "&")
}

function parseRecord(text, start) {
  // Parse one JSON object starting at `start`. Assumes no nested braces in
  // string values (true for these records).
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === "\\") {
      escaped = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) {
        try {
          return { record: JSON.parse(text.slice(start, i + 1)), end: i + 1 }
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

export function extractModelRecords(html) {
  const text = decodeEscapedJson(html)
  const records = new Map()
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('{"slug":"', i)) {
      const parsed = parseRecord(text, i)
      if (!parsed || typeof parsed.record.id !== "string") continue
      records.set(parsed.record.id, parsed.record)
      i = parsed.end
    }
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
