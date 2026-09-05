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
// the four after its full fallback ladder fails the refresh loudly. The
// ordered enrichment ladders (issue #132) resolve a blank models.md cell
// instead of shipping it pending:
//
//   context: models.md Context cell → RSC slug-record contextWindow →
//            CLI-bundle contextWindow → carried-forward last-known-good
//            (the previous committed snapshot) → loud unshippable-row
//            failure. Context may carry forward: a stale length is
//            reviewable diff noise, never a billing error.
//   cost:    models.md price cell → models page index row rates → model
//            detail page header → RSC slug-record rates → loud
//            unshippable-row failure. **Costs never carry forward** — a
//            model going free must never be billed at its old rate.
//   modalities: CLI inputModalities → models page Caps Vision bit →
//            text-only fallback (a pending report, never a failure).
//
// The RSC goat/pro pages and the models page index are enrichment-only:
// they are consulted lazily (only when a row actually needs a ladder
// step), never as membership. Detail pages are live-fetch-only on
// cost-ladder use and are never pinned (issue #129). Only two loud
// failure classes survive: an unshippable row after the full ladder, and
// a parser shape change in any source.
//
// A missing Context cell ("—") resolves via the ladder and ships with its
// provenance (`contextSource`); an unknown Context token or an unparseable
// price cell is a loud shape failure (parser work, never a silent
// default); missing never zero-fills (a zero rate means explicitly free).
//
// Usage: node scripts/refresh-snapshot.mjs [--out path] [--facts-out path]
//   --out        write the snapshot to this path (default src/catalog/snapshot.ts)
//   --facts-out  write the facts shim to this path (default <out dir>/facts.ts)
//   env COMMANDCODE_API_BASE overrides the API base (tests point at the mock)
//   env COMMANDCODE_REGISTRY_URL overrides the npm registry URL (tests point at the mock)
//   env COMMANDCODE_FACTS_URL overrides the models.md URL (tests point at the mock)
//   env COMMANDCODE_MODALITIES_URL overrides the CLI bundle URL (tests point at the mock)
//   env COMMANDCODE_RSC_GOAT_URL / COMMANDCODE_RSC_PRO_URL override the RSC
//       slug-record pages (used only when a row needs a ladder step)
//   env COMMANDCODE_MODELS_PAGE_URL overrides the models page index
//   env COMMANDCODE_MODELS_DETAIL_URL overrides the model detail page base
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const DEFAULT_API_BASE = "https://api.commandcode.ai"
const DEFAULT_OUT = resolve(import.meta.dirname, "..", "src", "catalog", "snapshot.ts")
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/command-code"
const DEFAULT_FACTS_URL = (version) =>
  `https://unpkg.com/command-code@${version}/dist/bundled/command-code-knowledge/reference/models.md`
const DEFAULT_MODALITIES_URL = (version) => `https://unpkg.com/command-code@${version}/dist/cli.mjs`
const DEFAULT_RSC_GOAT_URL = "https://commandcode.ai/docs/plans/goat"
const DEFAULT_RSC_PRO_URL = "https://commandcode.ai/docs/plans/pro"
const DEFAULT_MODELS_PAGE_URL = "https://commandcode.ai/models"
const DEFAULT_MODELS_DETAIL_URL = "https://commandcode.ai/models"

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
 * Fetches an enrichment source's body as text WITHOUT failing the refresh
 * when the source is unavailable (network / 5xx / 4xx). Enrichment sources
 * (RSC slug pages, models page) degrade to null — the caller walks to the
 * next ladder step with a note. A null return is never a shape failure:
 * parse errors on a *successful* fetch stay loud in the callers.
 * @returns {Promise<string|null>}
 */
async function fetchEnrichmentText(url, headers) {
  let response
  try {
    response = await fetch(url, headers)
  } catch (error) {
    console.log(
      `refresh-snapshot: note — enrichment source unreachable (${url}): ${
        error instanceof Error ? error.message : String(error)
      }; degrading to the next ladder step`,
    )
    return null
  }
  if (!response.ok) {
    console.log(
      `refresh-snapshot: note — enrichment source returned ${response.status} (${url}); ` +
        `degrading to the next ladder step`,
    )
    return null
  }
  try {
    return await response.text()
  } catch (error) {
    console.log(
      `refresh-snapshot: note — enrichment source body unreadable (${url}): ${
        error instanceof Error ? error.message : String(error)
      }; degrading to the next ladder step`,
    )
    return null
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
 * with its ship-bar fields (contextLength/cost never null after the #132
 * ladders) and the ladder provenance (`contextSource` / `costSource`) so
 * a reviewer can trace which enrichment step resolved each gap.
 */

function renderSnapshot(rows) {
  const modelLines = rows.map(
    (row) =>
      `  { id: ${JSON.stringify(row.id)}, name: ${JSON.stringify(row.name)}, ` +
      `contextLength: ${row.contextLength === null ? "null" : row.contextLength}, ` +
      `contextSource: ${
        row.contextSource === undefined ? '"models.md"' : JSON.stringify(row.contextSource)
      }, ` +
      `efforts: ${row.efforts === null ? "null" : JSON.stringify(row.efforts)}, cost: ${
        row.cost === null
          ? "null"
          : `{ input: ${row.cost.input}, output: ${row.cost.output}, cacheRead: ${row.cost.cacheRead}, cacheWrite: ${row.cost.cacheWrite} }`
      }, costSource: ${
        row.costSource === undefined ? '"models.md"' : JSON.stringify(row.costSource)
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
    "// efforts). Since issue #132 a blank models.md cell is resolved through",
    "// the ordered enrichment ladders (context: RSC contextWindow → CLI",
    "// contextWindow → carried-forward; cost: models page index → detail page",
    "// → RSC rates — costs never carry forward), and each row carries its",
    "// `contextSource` / `costSource` provenance. The listing API decides",
    "// nothing and wins no field. Regenerate with `npm run refresh:snapshot`.",
    "",
    "export interface CatalogModel {",
    "  readonly id: string",
    "  readonly name: string",
    "  readonly contextLength: number | null",
    '  /** "models.md" when the package cell parsed; else the ladder step that resolved it. */',
    '  readonly contextSource: "models.md" | "rsc" | "cli" | "carried-forward"',
    "  readonly efforts: readonly string[] | null",
    "  readonly cost: {",
    "    readonly input: number",
    "    readonly output: number",
    "    readonly cacheRead: number",
    "    readonly cacheWrite: number",
    "  } | null",
    '  /** "models.md" when the package cell parsed; else the ladder step that resolved it. */',
    '  readonly costSource: "models.md" | "models-page" | "detail" | "rsc"',
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

// ---------------------------------------------------------------------------
// Issue #132 fallback ladders. The models.md rows carry `contextLength` /
// `cost` = null when the package table shipped a "—" cell. Those gaps are
// resolved through ordered enrichment ladders (never a silent zero-fill,
// never a blocking failure for a single row, and for costs NEVER a
// carry-forward):
//
//   context: parsed models.md → RSC slug-record contextWindow →
//            CLI contextWindow → carried-forward LKG → loud fail
//   cost:    parsed models.md → models page index row → model detail
//            page header → RSC slug-record rates → loud fail
//   modalities: CLI → models page Caps Vision → text fallback (pending)
//
// Sources are fetched lazily: the RSC slug pages and models page are only
// fetched when at least one row actually needs them; detail pages only on
// cost-ladder use (live-fetch-only, never pinned). A shape failure in any
// source is loud but scoped: it names the failing model rather than
// silently degrading.
//
// The output rows gain `contextSource` / `costSource` so a reviewer sees
// exactly which step resolved each gap, and the emitted snapshot reflects
// the same ladder the refresh log describes.
// ---------------------------------------------------------------------------

const rowsNeedingContext = rows.filter((row) => row.contextLength === null)
const rowsNeedingCost = rows.filter((row) => row.cost === null)

// RSC slug records (extractPlanPageRsc over the goat/pro pages) power both
// ladders' final step + the classification evidence. Cached after the first
// call so the refresh never fetches them when no row needs a ladder step.
//
// The RSC pages are **enrichment-only** for the snapshot ladders: a fetch
// failure (network / 5xx / 4xx) degrades to an empty source with a loud
// note — the ladder still walks on to the CLI / carried-forward steps.
// A *parse* shape failure (extractPlanPageRsc throwing) stays loud: that
// is parser work, never a silent degrade.
let rscSlugRecordsPromise
function provideRscSlugRecords() {
  rscSlugRecordsPromise ??= (async () => {
    const { extractPlanPageRsc } = await import("./parse-rsc.mjs")
    const goatUrl = process.env.COMMANDCODE_RSC_GOAT_URL ?? DEFAULT_RSC_GOAT_URL
    const proUrl = process.env.COMMANDCODE_RSC_PRO_URL ?? DEFAULT_RSC_PRO_URL
    const merged = new Map()
    for (const url of [goatUrl, proUrl]) {
      const text = await fetchEnrichmentText(url, { headers: { rsc: "1" } })
      if (text === null) continue
      // A parse failure on a successfully-fetched page is a shape change —
      // loud, never a silent degrade.
      for (const [id, record] of extractPlanPageRsc(text)) merged.set(id, record)
    }
    return merged
  })()
  return rscSlugRecordsPromise
}

// Models page index rows (per-row rates + Caps bits + coarse context).
// Cached after the first call (the slug → snapshot id join is the pinned
// TOTAL map).
// Cache state: `undefined` = not attempted, `null` = attempt failed
// (degrade, retry allowed), else the resolved Map.
let pageCache
async function provideModelsPage() {
  if (pageCache) return pageCache
  const { parseModelsPage, slugToSnapshotId } = await import("./parse-models-page.mjs")
  const url = process.env.COMMANDCODE_MODELS_PAGE_URL ?? DEFAULT_MODELS_PAGE_URL
  const html = await fetchEnrichmentText(url, { headers: { accept: "text/html" } })
  if (html === null) {
    pageCache = null
    return new Map()
  }
  // A parse failure here is a shape change — loud, never a silent degrade.
  const { rows: parsedRows, notes } = parseModelsPage(html)
  for (const note of notes) console.log(`refresh-snapshot: ${note}`)
  const byId = new Map()
  for (const row of parsedRows) {
    let id
    try {
      id = slugToSnapshotId(row.slug)
    } catch (error) {
      // A slug the pinned map doesn't know is a shape change — loud,
      // never silently dropped (the enum in parse-models-page is TOTAL).
      fail(
        `models page slug "${row.slug}" does not resolve to a snapshot id: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    byId.set(id, row)
  }
  pageCache = byId
  return byId
}

/**
 * Resolves the ship-bar gap(s) of one row through the ladders, mutating the
 * row in place (`contextLength`, `cost`, `contextSource`, `costSource`).
 * Loud failure: a row that stays unresolved after EVERY ladder step is
 * unshippable (issue #129 ship-bar) and aborts the refresh naming it.
 */
async function resolveRowLadders(row, { previousSnapshot, rscSlugRecords, modelsPageById }) {
  // --- context ladder: models.md → RSC contextWindow → CLI contextWindow
  // → carried-forward LKG → loud unshippable-row failure ---
  if (row.contextLength === null) {
    const rscWindow = rscSlugRecords.get(row.id)?.contextWindow
    if (typeof rscWindow === "number" && Number.isFinite(rscWindow) && rscWindow > 0) {
      row.contextLength = rscWindow
      row.contextSource = "rsc"
      console.log(`refresh-snapshot: context ${row.id}: ${rscWindow} (from RSC contextWindow)`)
    } else {
      const cliWindow = parsedModalities.contextWindows?.[row.id]
      if (typeof cliWindow === "number" && Number.isFinite(cliWindow) && cliWindow > 0) {
        row.contextLength = cliWindow
        row.contextSource = "cli"
        console.log(`refresh-snapshot: context ${row.id}: ${cliWindow} (from CLI contextWindow)`)
      } else {
        const previous = previousSnapshot?.get(row.id)
        if (previous && typeof previous.contextLength === "number" && previous.contextLength > 0) {
          row.contextLength = previous.contextLength
          row.contextSource = "carried-forward"
          console.log(
            `refresh-snapshot: context ${row.id}: ${previous.contextLength} (carried forward from previous snapshot)`,
          )
        } else {
          fail(
            `row ${row.id} has no context length after the full fallback ladder ` +
              `(models.md, RSC contextWindow, CLI contextWindow, carried-forward) — ` +
              `unshippable row (issue #129 ship-bar)`,
          )
        }
      }
    }
  }

  // --- cost ladder (NEVER carries forward):
  // models.md → models page index row → detail header → RSC rates → loud
  // unshippable-row failure. There is deliberately no last-known-good step
  // for costs anywhere in the pipeline (a model going free must never be
  // billed at its old rate). ---
  if (row.cost === null) {
    // A page row only resolves when ALL of input/output/cacheRead are
    // present — a "—" cacheRead cell must never zero-fill into a free
    // cache read (missing never reads as free). cacheWrite may be absent
    // everywhere and is an explicit 0.
    const pageRow = modelsPageById.get(row.id)
    const pageRates = pageRow?.rates
    if (
      pageRates &&
      pageRates.input !== null &&
      pageRates.output !== null &&
      pageRates.cacheRead !== null
    ) {
      row.cost = {
        input: pageRates.input,
        output: pageRates.output,
        cacheRead: pageRates.cacheRead,
        cacheWrite: pageRates.cacheWrite ?? 0,
      }
      row.costSource = "models-page"
      console.log(
        `refresh-snapshot: cost ${row.id}: $${row.cost.input}/$${row.cost.output} (from models page index row)`,
      )
    } else {
      // Detail page (live-fetch-only, never pinned). Use the row's slug:
      // the page-index row carries it; a model the index didn't carry falls
      // back to the last path segment of the snapshot id.
      const { parseModelDetailRates } = await import("./parse-models-page.mjs")
      const detailBase = process.env.COMMANDCODE_MODELS_DETAIL_URL ?? DEFAULT_MODELS_DETAIL_URL
      const pageSlug = pageRow?.slug
      const slug =
        typeof pageSlug === "string" && pageSlug.length > 0
          ? pageSlug
          : String(row.id).split("/").pop()
      // The detail page is enrichment: a fetch failure (network / 404 /
      // 5xx) degrades to the RSC step with a note; a *parse* failure of a
      // successfully-fetched page stays loud (shape change).
      const detailHtml = await fetchEnrichmentText(`${detailBase}/${slug}`, {
        headers: { accept: "text/html" },
      })
      const detailRates =
        detailHtml === null
          ? { input: null, output: null, cacheRead: null, cacheWrite: null }
          : parseModelDetailRates(detailHtml)
      if (
        detailRates.input !== null &&
        detailRates.output !== null &&
        detailRates.cacheRead !== null
      ) {
        row.cost = {
          input: detailRates.input,
          output: detailRates.output,
          cacheRead: detailRates.cacheRead,
          cacheWrite: detailRates.cacheWrite ?? 0,
        }
        row.costSource = "detail"
        console.log(
          `refresh-snapshot: cost ${row.id}: $${row.cost.input}/$${row.cost.output} (from model detail page header)`,
        )
      } else {
        const record = rscSlugRecords.get(row.id)
        const toRate = (value) =>
          typeof value === "number" && Number.isFinite(value) ? value : undefined
        const rscInput = toRate(record?.inputCost)
        const rscOutput = toRate(record?.outputCost)
        const rscCacheRead = toRate(record?.cacheReadCost)
        if (rscInput !== undefined && rscOutput !== undefined && rscCacheRead !== undefined) {
          row.cost = {
            input: rscInput,
            output: rscOutput,
            cacheRead: rscCacheRead,
            cacheWrite: toRate(record?.cacheWriteCost) ?? 0,
          }
          row.costSource = "rsc"
          console.log(
            `refresh-snapshot: cost ${row.id}: $${row.cost.input}/$${row.cost.output} (from RSC slug-record rates)`,
          )
        } else {
          fail(
            `row ${row.id} has no cost after the full fallback ladder ` +
              `(models.md, models page index, detail page, RSC rates) — ` +
              `unshippable row (issue #129 ship-bar). Costs never carry forward.`,
          )
        }
      }
    }
  }
}

// Modalities: parsed from the CLI bundle, then bridged through the issue
// #132 modalities ladder — CLI inputModalities → models page Caps Vision →
// text-only fallback. The CLI is the primary source (a CLI-ahead id is
// enrichment data for a model that does not ship); a package row the CLI
// omits is a pending-modalities report, never a failure: the models page
// Caps Vision bit may still promote it to image, and the text-only
// fallback keeps it usable either way. Every resolved model carries its
// provenance (`modalitySource`) so the refresh log explains the step.
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
// Models with no CLI entry stay text-only via the runtime fallback and MAY
// be promoted to image by the models page Caps Vision bit (issue #132
// ladder). MODEL_INPUT_MODALITIES is image-only by convention (text-only
// models are omitted; the runtime falls back to ["text"]), so only a
// page-Vision-promoted model enters the map — with a visible pending note
// for the plain text-only fallback. The models page is fetched only when a
// CLI-omitted model exists; a page fetch failure degrades to text-only
// (pending report), never a loud failure.
let pageForModalities = new Map()
if (missingModalities.length > 0) {
  try {
    pageForModalities = await provideModelsPage()
  } catch (error) {
    console.log(
      `refresh-snapshot: note — models page unavailable for the modalities ladder (${
        error instanceof Error ? error.message : String(error)
      }); using text-only fallbacks`,
    )
  }
}
for (const row of rows) {
  // CLI-covered models (text OR image) are already decided by the CLI
  // step — only a model the CLI omits consults the page Vision bit.
  if (parsedModalities.modelIds.has(row.id)) continue
  const pageRow = pageForModalities.get(row.id)
  if (pageRow?.caps?.vision === true) {
    modalities[row.id] = ["text", "image"]
    console.log(
      `refresh-snapshot: modalities ${row.id}: text + image (from models page Caps Vision bit)`,
    )
  } else {
    console.log(
      `refresh-snapshot: modalities pending — ${row.id}: CLI omits and no Caps Vision evidence; text-only fallback`,
    )
  }
}

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

const out = argValue("--out") ?? DEFAULT_OUT
const factsOut = argValue("--facts-out") ?? resolve(dirname(out), "facts.ts")
const metadata = {
  sourceUrl,
  modalitiesSourceUrl: modalitiesUrl,
  packageVersion: latest,
  lastRefreshed: new Date().toISOString().split("T")[0],
}

// Carried-forward last-known-good (issue #132 context ladder): the previous
// committed snapshot at the --out path. Read before regeneration; a missing
// or unreadable previous file simply means no LKG source (the ladder still
// has the RSC + CLI steps before a row can fail).
//
// The previous file is a generated .ts module; the refresh runs under plain
// node, so the LKG rows are extracted with the same entry regex
// scripts/snapshot-index.mjs uses (never a runtime import of a .ts file).
let previousSnapshot = new Map()
try {
  const previousText = await readFile(out, "utf-8")
  const ENTRY_RE = /\{ id: "([^"]+)", name: "([^"]+)", contextLength: (null|[0-9]+),/g
  for (const match of previousText.matchAll(ENTRY_RE)) {
    previousSnapshot.set(match[1], {
      id: match[1],
      name: match[2],
      contextLength: match[3] === "null" ? null : Number(match[3]),
    })
  }
} catch {
  // No previous snapshot — nothing to carry forward.
}

// Resolve every ship-bar gap through the #132 ladders. A row that stays
// unresolved after the full ladder fails the refresh loudly (unshippable
// row) before anything is written — no partial refresh, no silent pending
// rows in the emitted module.
if (rowsNeedingContext.length > 0 || rowsNeedingCost.length > 0) {
  const [rscSlugRecords, modelsPageById] = await Promise.all([
    provideRscSlugRecords(),
    rowsNeedingCost.length > 0 ? provideModelsPage() : Promise.resolve(new Map()),
  ])
  for (const row of rows) {
    if (row.contextLength === null || row.cost === null) {
      await resolveRowLadders(row, { previousSnapshot, rscSlugRecords, modelsPageById })
    }
  }
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
