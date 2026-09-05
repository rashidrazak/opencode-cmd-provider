// scripts/build-enrichment.mjs — enrichment input builder for the refresh
// diff's snapshot subsections (issue #134).
//
// The catalog-refresh workflow's PR body renders six sections for the
// Model catalog kind in `diff-catalog.mjs`: the loud removed-section plus
// pending enrichment per model, carried-forward context, cost-fallback
// provenance, API divergence, and banded-pricing notes. This module builds
// the single `enrichment` input those renderers consume from three sources
// the cron already captures:
//
//   - the "after" extracted payloads (snapshot rows carry `contextSource` /
//     `costSource` provenance; the classification module carries
//     `MODEL_REASONING_PENDING`; the deals module carries `MODEL_DEALS`);
//   - the refresh log (`refresh.log`, captured from `npm run refresh` with
//     `tee`): the annotate-only API divergence notes, the
//     modalities-pending reports, and the models-page banded-pricing notes
//     are log lines, not generated data.
//
// Pure: no network, no file reads in the builders (the CLI reads files).
// Deterministic: every list is sorted, so same inputs → same bytes. Missing
// inputs degrade to empty sections, never throw — a subsection renders only
// when it has content.
import { readFile, writeFile } from "node:fs/promises"

function asRecord(value) {
  return value !== null && typeof value === "object"
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

function sortedUnique(ids) {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  )
}

/**
 * Parses the refresh log (`npm run refresh` stdout, captured with `tee`)
 * for the annotate-only signals the generated modules don't carry:
 *
 *   - API divergence notes (both directions, plus the matches/skipped lines);
 *   - modalities-pending reports (the CLI-omits list + the per-model
 *     text-only fallback lines);
 *   - models-page banded-pricing / off-peak verification notes (the
 *     `models-page:` lines `refresh-snapshot` echoes with its own prefix).
 *
 * @param {string} logText
 * @returns {{ inMembershipNotApi: string[], inApiNotMembership: string[], skipped: boolean, matched: boolean, known: boolean, pendingModalities: string[], bandedNotes: string[] }}
 *   `known` is true when the log carried any divergence signal (either
 *   direction, the matches line, or the skipped line) — only then does the
 *   renderer claim anything about the API.
 */
export function parseRefreshLog(logText) {
  const text = String(logText ?? "")
  const out = {
    inMembershipNotApi: [],
    inApiNotMembership: [],
    skipped: false,
    matched: false,
    pendingModalities: [],
    bandedNotes: [],
  }
  const splitIds = (list) =>
    String(list ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  for (const line of text.split(/\r?\n/)) {
    let match = line.match(/in package membership but not served by the listing API:\s*(.+)$/)
    if (match) {
      out.inMembershipNotApi.push(...splitIds(match[1]))
      continue
    }
    match = line.match(/served by the listing API but not in package membership:\s*(.+)$/)
    if (match) {
      out.inApiNotMembership.push(...splitIds(match[1]))
      continue
    }
    if (/listing API matches package membership/.test(line)) {
      out.matched = true
      continue
    }
    if (/divergence note skipped/.test(line)) {
      out.skipped = true
      continue
    }
    // "modalities pending — CLI bundle omits N package models: a, b" — the
    // aggregate list. (The "unreachable … using text-only fallbacks" line
    // carries no ids and is correctly ignored here.)
    match = line.match(/CLI bundle omits \d+ package models:\s*(.+)$/)
    if (match) {
      out.pendingModalities.push(...splitIds(match[1]))
      continue
    }
    // "modalities pending — <id>: CLI omits and no Caps Vision evidence;
    // text-only fallback" — the per-model line.
    match = line.match(/modalities pending — ([^:,\s]+):/)
    if (match) {
      out.pendingModalities.push(match[1].trim())
      continue
    }
    // The models-page verification notes (`refresh-snapshot: models-page:
    // …`) — banded pricing and off-peak markers alike.
    match = line.match(/models-page:\s*(.+?)\s*$/)
    if (match) {
      out.bandedNotes.push(`models-page: ${match[1].trim()}`)
    }
  }
  out.inMembershipNotApi = sortedUnique(out.inMembershipNotApi)
  out.inApiNotMembership = sortedUnique(out.inApiNotMembership)
  out.pendingModalities = sortedUnique(out.pendingModalities)
  out.bandedNotes = [...new Set(out.bandedNotes)].sort((a, b) => a.localeCompare(b))
  out.known =
    out.matched ||
    out.skipped ||
    out.inMembershipNotApi.length > 0 ||
    out.inApiNotMembership.length > 0
  return out
}

/**
 * Snapshot rows from an extracted payload: accepts the cron's
 * `{ MODEL_SNAPSHOT: [...] }` wrapper and the bare array.
 *
 * @param {unknown} value
 * @returns {Array<Record<string, unknown>>}
 */
function snapshotRowsOf(value) {
  const rec = asRecord(value)
  const rows = rec?.MODEL_SNAPSHOT ?? value
  return Array.isArray(rows) ? rows.filter((row) => asRecord(row)) : []
}

/**
 * Builds the `enrichment` input for `diffCatalogs({ kind: "snapshot", …,
 * enrichment })` from the cron's "after" extracted payloads plus the
 * refresh log text.
 *
 * @param {{ snapshotAfter?: unknown, classificationAfter?: unknown, dealsAfter?: unknown, refreshLogText?: string }} args
 * @returns {{ pendingClassification: string[], pendingDeals: string[], pendingModalities: string[], carriedForward: Array<{id: string, contextLength: number}>, costFallbacks: Array<{id: string, source: string}>, apiDivergence: { inMembershipNotApi: string[], inApiNotMembership: string[], skipped: boolean } | null, bandedNotes: string[] }}
 *   `apiDivergence` is null when the log carried no divergence signal —
 *   the renderer then omits the section instead of claiming a match.
 */
export function buildEnrichment({
  snapshotAfter,
  classificationAfter,
  dealsAfter,
  refreshLogText,
} = {}) {
  const rows = snapshotRowsOf(snapshotAfter)
  const ids = sortedUnique(rows.map((row) => row.id))
  const idSet = new Set(ids)

  const classRec = asRecord(classificationAfter) ?? {}
  const pendingClassification = sortedUnique(
    classRec.MODEL_REASONING_PENDING ?? classRec.pending ?? [],
  ).filter((id) => idSet.size === 0 || idSet.has(id))
  // Pending deals: snapshot ids with no deals record. Only computed when
  // the deals side actually carries a record map (the cron's wrapper
  // `{ MODEL_DEALS: {...} }`, or a bare record) — a missing extract
  // ({"missing":true}) degrades to empty, never to "everything pending".
  const dealsRec = asRecord(dealsAfter)
  const dealsMap =
    dealsRec !== null && !dealsRec.missing ? (asRecord(dealsRec.MODEL_DEALS) ?? dealsRec) : null
  const pendingDeals =
    rows.length > 0 && dealsMap !== null
      ? ids.filter((id) => !Object.prototype.hasOwnProperty.call(dealsMap, id))
      : []
  const log = parseRefreshLog(refreshLogText ?? "")

  const carriedForward = rows
    .filter((row) => row.contextSource === "carried-forward")
    .map((row) => ({ id: String(row.id), contextLength: row.contextLength }))
    .filter((entry) => typeof entry.contextLength === "number")
    .sort((a, b) => a.id.localeCompare(b.id))

  const costFallbacks = rows
    .filter((row) => typeof row.costSource === "string" && row.costSource !== "models.md")
    .map((row) => ({ id: String(row.id), source: String(row.costSource) }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return {
    pendingClassification,
    pendingDeals,
    pendingModalities: log.pendingModalities.filter((id) => idSet.size === 0 || idSet.has(id)),
    carriedForward,
    costFallbacks,
    apiDivergence: log.known
      ? {
          inMembershipNotApi: log.inMembershipNotApi,
          inApiNotMembership: log.inApiNotMembership,
          skipped: log.skipped,
        }
      : null,
    bandedNotes: log.bandedNotes,
  }
}

// CLI entry point. `node scripts/build-enrichment.mjs --snapshot
// after-snapshot.json --classification after-classification.json --deals
// after-deals.json --log refresh.log --out enrichment.json`
//
// Every input is optional; a missing/unreadable file degrades to its empty
// section (never a failure — the diff renders without that subsection).
async function main() {
  const argValue = (name) => {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const readJson = async (path) => {
    if (!path) return undefined
    try {
      return JSON.parse(await readFile(path, "utf-8"))
    } catch {
      return undefined
    }
  }
  const readText = async (path) => {
    if (!path) return ""
    try {
      return await readFile(path, "utf-8")
    } catch {
      return ""
    }
  }
  const enrichment = buildEnrichment({
    snapshotAfter: await readJson(argValue("--snapshot")),
    classificationAfter: await readJson(argValue("--classification")),
    dealsAfter: await readJson(argValue("--deals")),
    refreshLogText: await readText(argValue("--log")),
  })
  const out = argValue("--out")
  const text = `${JSON.stringify(enrichment, null, 2)}\n`
  if (out) await writeFile(out, text, "utf-8")
  else process.stdout.write(text)
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`build-enrichment: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
