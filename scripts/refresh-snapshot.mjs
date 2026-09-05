// scripts/refresh-snapshot.mjs — regenerate src/catalog/snapshot.ts and
// src/catalog/facts.ts from the command-code npm package's bundled
// models.md table (the Snapshot membership authority since issue #130).
// Runs at release time; never at runtime.
//
// Membership authority: every models.md row ships in the Snapshot
// (id, name, decimal-parsed context, costs, efforts). The listing API
// decides nothing, wins no field, and gates nothing for these fields —
// its only output is an annotate-only divergence note (in membership but
// not API / in API but not membership) printed to the refresh log.
//
// Ship-bar (issue #129): id + name + context + cost. A row missing any of
// the four after its full fallback ladder fails the refresh loudly. In
// this ticket the fallback ladders do not exist yet (issue #132), so the
// parser's cell-level signals decide what ships:
//   - a missing Context cell ("—") ships as `contextLength: null` (the
//     ladder lands in #132) with a pending-context note;
//   - a missing price cell ("—") ships as a row without a cost entry
//     (the cost ladder lands in #132) with a missing-cost note;
//   - an unknown Context token or an unparseable price cell is a loud
//     shape failure — parser work, never a silent default;
//   - missing never zero-fills (a zero rate means explicitly free).
//
// The CLI bundle (dist/cli.mjs) input modalities are also parsed and
// filtered to the package-membership ids.
//
// Usage: node scripts/refresh-snapshot.mjs [--out path] [--facts-out path]
//   --out        write the snapshot to this path (default src/catalog/snapshot.ts)
//   --facts-out  write the facts shim to this path (default <out dir>/facts.ts)
//   env COMMANDCODE_API_BASE overrides the API base (tests point at the mock)
//   env COMMANDCODE_REGISTRY_URL overrides the npm registry URL (tests point at the mock)
//   env COMMANDCODE_FACTS_URL overrides the models.md URL (tests point at the mock)
//   env COMMANDCODE_MODALITIES_URL overrides the CLI bundle URL (tests point at the mock)
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const DEFAULT_API_BASE = "https://api.commandcode.ai"
const DEFAULT_OUT = resolve(import.meta.dirname, "..", "src", "catalog", "snapshot.ts")
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/command-code"
const DEFAULT_FACTS_URL = (version) =>
  `https://unpkg.com/command-code@${version}/dist/bundled/command-code-knowledge/reference/models.md`
const DEFAULT_MODALITIES_URL = (version) => `https://unpkg.com/command-code@${version}/dist/cli.mjs`

const registryUrl = process.env.COMMANDCODE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(message) {
  console.error(`refresh-snapshot: ${message}`)
  process.exit(1)
}

async function fetchOrFail(url, headers) {
  let response
  try {
    response = await fetch(url, headers)
  } catch (error) {
    fail(`could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    fail(`failed to fetch ${url}: ${response.status} ${response.statusText}`)
  }
  return response
}

async function fetchJson(url) {
  const response = await fetchOrFail(url, { headers: { accept: "application/json" } })
  try {
    return await response.json()
  } catch (error) {
    fail(`could not parse ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Reads the listing API purely for its divergence note (issue #130: the
 * API "decides nothing, wins no field, and gates nothing"). Any failure
 * here is a note-only failure — never a membership or ship-bar gate.
 * @returns {{ apiIds: string[] } | null} null when the API did not serve
 *   a usable model list (the note just says so).
 */
async function fetchApiModelIds() {
  const base = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
  const url = `${base}/provider/v1/models`
  let response
  try {
    response = await fetch(url, { headers: { accept: "application/json" } })
  } catch {
    console.log("refresh-snapshot: note — listing API unreachable; divergence note skipped")
    return null
  }
  if (!response.ok) {
    console.log(
      `refresh-snapshot: note — listing API returned ${response.status}; divergence note skipped`,
    )
    return null
  }
  let body
  try {
    body = await response.json()
  } catch {
    console.log("refresh-snapshot: note — listing API body was not JSON; divergence note skipped")
    return null
  }
  if (!isRecord(body) || body.object !== "list" || !Array.isArray(body.data)) {
    console.log(
      "refresh-snapshot: note — listing API response had an unexpected shape; divergence note skipped",
    )
    return null
  }
  return body.data
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : null))
    .filter((id) => id !== null)
}

/**
 * Renders the snapshot module: every package row ships as a CatalogModel
 * with its ship-bar fields (contextLength/cost null = pending — the
 * fallback ladders land in issue #132).
 */

function renderSnapshot(rows) {
  const modelLines = rows.map(
    (row) =>
      `  { id: ${JSON.stringify(row.id)}, name: ${JSON.stringify(row.name)}, ` +
      `contextLength: ${row.contextLength === null ? "null" : row.contextLength}, ` +
      `efforts: ${row.efforts === null ? "null" : JSON.stringify(row.efforts)}, cost: ${
        row.cost === null
          ? "null"
          : `{ input: ${row.cost.input}, output: ${row.cost.output}, cacheRead: ${row.cost.cacheRead}, cacheWrite: ${row.cost.cacheWrite} }`
      } },`,
  )
  return [
    "// src/catalog/snapshot.ts — GENERATED by scripts/refresh-snapshot.mjs. Do not edit.",
    "//",
    "// A copy of the Command Code model catalog bundled in the package so the",
    "// plugin can auto-register every model without network access at runtime.",
    "// Since issue #130 the npm package models.md table is the sole membership",
    "// authority: every models.md row ships here with its ship-bar fields",
    "// (id, name, context length parsed from the coarse Context column, costs,",
    "// efforts). The listing API decides nothing and wins no field. Regenerate",
    "// with `npm run refresh:snapshot`.",
    "",
    "export interface CatalogModel {",
    "  readonly id: string",
    "  readonly name: string",
    "  readonly contextLength: number | null",
    "  readonly efforts: readonly string[] | null",
    "  readonly cost: {",
    "    readonly input: number",
    "    readonly output: number",
    "    readonly cacheRead: number",
    "    readonly cacheWrite: number",
    "  } | null",
    "}",
    "",
    `export const MODEL_SNAPSHOT: readonly CatalogModel[] = [`,
    ...modelLines,
    "]",
    "",
    // Provenance (source URL, package version, refresh date) deliberately
    // lives in facts.ts only — the cron's drift check ignores date-only
    // churn in the generated modules, and a redundant date stamp in
    // snapshot.ts would count as meaningful drift on date-only churn
    // (the #103 no-op-PR lesson). Keep this file data-only.
  ].join("\n")
}

/**
 * facts.ts shim — keeps the pre-#130 consumer contract (MODEL_EFFORTS /
 * MODEL_COSTS / MODEL_INPUT_MODALITIES keyed maps plus provenance consts)
 * derived from the single source of truth in snapshot.ts. Generated rows
 * that still have a pending cost (context/cost ladders land in #132) are
 * absent from the maps — exactly as the old drop-filter behaved, so every
 * existing consumer stays green.
 */
function renderFactsShim(rows, modalities, metadata) {
  const mapLines = (entries, renderValue) =>
    entries.map(([id, value]) => `  ${JSON.stringify(id)}: ${renderValue(value)},`)
  const effortEntries = rows
    .filter((row) => row.efforts !== null && row.efforts.length > 0)
    .map((row) => [row.id, row.efforts])
  const costEntries = rows
    .filter((row) => row.cost !== null)
    .map((row) => [
      row.id,
      `{ input: ${row.cost.input}, output: ${row.cost.output}, cacheRead: ${row.cost.cacheRead}, cacheWrite: ${row.cost.cacheWrite} }`,
    ])
  const modalityEntries = Object.entries(modalities).map(([id, values]) => [id, values])
  return [
    "// src/catalog/facts.ts — GENERATED by scripts/refresh-snapshot.mjs. Do not edit.",
    "//",
    "// Capability facts derived from the models.md-primary Snapshot rows in",
    "// src/catalog/snapshot.ts (issue #130): reasoning efforts + rates parse",
    "// from the package table (never from the listing API). Input modalities",
    "// parse from the CLI bundle (dist/cli.mjs). Regenerate with",
    "// `npm run refresh:snapshot`.",
    "",
    `export const FACTS_SOURCE_URL = ${JSON.stringify(metadata.sourceUrl)}`,
    `export const MODALITIES_SOURCE_URL = ${JSON.stringify(metadata.modalitiesSourceUrl)}`,
    `export const FACTS_PACKAGE_VERSION = ${JSON.stringify(metadata.packageVersion)}`,
    `export const FACTS_LAST_REFRESHED = ${JSON.stringify(metadata.lastRefreshed)}`,
    "",
    "export const MODEL_EFFORTS: Readonly<Record<string, readonly string[]>> = {",
    ...mapLines(effortEntries, (value) => JSON.stringify(value)),
    "}",
    "",
    "export const MODEL_COSTS: Readonly<",
    "  Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>",
    "> = {",
    ...mapLines(costEntries, (value) => value),
    "}",
    "",
    "export const MODEL_INPUT_MODALITIES: Readonly<",
    '  Record<string, readonly ("text" | "image")[]>',
    "> = {",
    ...mapLines(modalityEntries, (value) => JSON.stringify(value)),
    "}",
    "",
  ].join("\n")
}

// --- Source of truth: the npm package models.md + CLI bundle ---
const { parseCatalogMarkdown } = await import("./parse-facts.mjs")
const registry = await fetchJson(registryUrl)
const latest = registry?.["dist-tags"]?.latest
if (typeof latest !== "string" || latest.length === 0) {
  fail(`could not resolve latest command-code version from ${registryUrl}`)
}
const sourceUrl = process.env.COMMANDCODE_FACTS_URL ?? DEFAULT_FACTS_URL(latest)
const modalitiesUrl = process.env.COMMANDCODE_MODALITIES_URL ?? DEFAULT_MODALITIES_URL(latest)

const factsMarkdown = await (
  await fetchOrFail(sourceUrl, { headers: { accept: "text/markdown" } })
).text()

let parsed
try {
  parsed = parseCatalogMarkdown(factsMarkdown)
} catch (error) {
  fail(`could not parse ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`)
}
if (parsed.rows.length === 0) fail("Command Code package models.md contains no model rows")

const rows = parsed.rows.map((row) => ({
  id: row.id,
  name: row.name,
  contextLength: row.contextLength === undefined ? null : row.contextLength,
  efforts: row.efforts === undefined ? null : row.efforts,
  cost: row.cost === undefined ? null : row.cost,
}))

const packageIds = new Set(rows.map((row) => row.id))
if (packageIds.size !== rows.length) {
  fail("Command Code package models.md contains duplicate model ids")
}

// Modalities: parsed from the CLI bundle, filtered to the package
// membership (a CLI-ahead id is enrichment data for a model that does not
// ship; a package row missing from the CLI is logged as a pending
// modalities report — the CLI-omits-model loud failure moves to a
// pending-report in issue #132).
const { parseInputModalities } = await import("./parse-modalities.mjs")
const modalitiesSource = await (
  await fetchOrFail(modalitiesUrl, { headers: { accept: "text/javascript" } })
).text()
let parsedModalities
try {
  parsedModalities = parseInputModalities(modalitiesSource)
} catch (error) {
  fail(
    `could not parse ${modalitiesUrl}: ${error instanceof Error ? error.message : String(error)}`,
  )
}
const missingModalities = rows
  .filter((row) => !parsedModalities.modelIds.has(row.id))
  .map((row) => row.id)
if (missingModalities.length > 0) {
  console.log(
    `refresh-snapshot: modalities pending — CLI bundle omits ${missingModalities.length} package models: ${missingModalities.join(", ")}`,
  )
}
const modalities = Object.fromEntries(
  Object.entries(parsedModalities.modalities).filter(([id]) => packageIds.has(id)),
)

// Annotate-only divergence notes (issue #130: API demoted to enrichment).
const apiIds = await fetchApiModelIds()
if (apiIds !== null) {
  const apiSet = new Set(apiIds)
  const inPackageNotApi = rows.filter((row) => !apiSet.has(row.id)).map((row) => row.id)
  const inApiNotPackage = apiIds.filter((id) => !packageIds.has(id))
  if (inPackageNotApi.length > 0) {
    console.log(
      `refresh-snapshot: divergence note — in package membership but not served by the listing API: ${inPackageNotApi.join(", ")}`,
    )
  }
  if (inApiNotPackage.length > 0) {
    console.log(
      `refresh-snapshot: divergence note — served by the listing API but not in package membership: ${inApiNotPackage.join(", ")}`,
    )
  }
  if (inPackageNotApi.length === 0 && inApiNotPackage.length === 0) {
    console.log("refresh-snapshot: divergence note — listing API matches package membership")
  }
}

// Ship-bar pending notes (issue #129 ship-bar; the fallback ladders land
// in issue #132 — these rows ship today with their pending field and a
// loud note so a reviewer sees them).
const pendingContext = rows.filter((row) => row.contextLength === null).map((row) => row.id)
if (pendingContext.length > 0) {
  console.log(
    `refresh-snapshot: context pending — ${pendingContext.length} rows carry a missing Context cell (fallback ladder lands in #132): ${pendingContext.join(", ")}`,
  )
}
const missingCost = rows.filter((row) => row.cost === null).map((row) => row.id)
if (missingCost.length > 0) {
  console.log(
    `refresh-snapshot: cost pending — ${missingCost.length} rows carry a missing price cell (cost ladder lands in #132): ${missingCost.join(", ")}`,
  )
}

const out = argValue("--out") ?? DEFAULT_OUT
const factsOut = argValue("--facts-out") ?? resolve(dirname(out), "facts.ts")
const metadata = {
  sourceUrl,
  modalitiesSourceUrl: modalitiesUrl,
  packageVersion: latest,
  lastRefreshed: new Date().toISOString().split("T")[0],
}

// Both parses complete before either file is written so a failure never
// leaves a partial refresh (a fresh snapshot.ts next to stale/missing facts).
await mkdir(dirname(out), { recursive: true })
await writeFile(out, renderSnapshot(rows), "utf-8")
console.log(`refresh-snapshot: wrote ${rows.length} models to ${out}`)
await writeFile(factsOut, renderFactsShim(rows, modalities, metadata), "utf-8")
const effortCount = rows.filter((row) => row.efforts !== null).length
const costCount = rows.filter((row) => row.cost !== null).length
console.log(
  `refresh-snapshot: wrote facts shim (${effortCount} efforts, ${costCount} costs, ${Object.keys(modalities).length} modalities) for command-code@${latest} to ${factsOut}`,
)
