// scripts/refresh-snapshot.mjs — regenerate src/catalog/snapshot.ts and
// src/catalog/facts.ts from the Command Code model catalog (ADR-0024).
// Runs at release time; never at runtime.
//
// Membership authority: the catalog endpoint's client view
// (`GET /provider/v1/models?view=client`), which is the same source the
// Command Code CLI itself resolves models from since command-code 1.83.0
// (`models.md` is a rendering of that catalog's non-hidden rows, so it
// lags every catalog change by a package release). Every selectable
// (non-`hidden`) record ships in the Snapshot. The API is no longer
// demoted to a note: it decides which models ship, plus context, costs, efforts and
// input modalities directly, so `scripts/parse-facts.mjs` and
// `scripts/parse-modalities.mjs` are gone.
//
// The npm registry is still consulted for the `command-code` `latest`
// dist-tag: FACTS_PACKAGE_VERSION feeds the `x-command-code-version`
// runtime header, which the legacy gateway version-gates, and the
// version-pinned provider specifier (ADR-0009) reads it. It no longer
// decides which models ship.
//
// Ship-bar (issue #129): id + name + context + cost. A row missing any of
// the four from the catalog record fails the refresh loudly. The ordered
// enrichment ladders (issue #132) survive for gaps the endpoint leaves —
// a record whose `pricing` block is absent still walks the ladder:
//
//   context: catalog `context_length` → RSC slug-record contextWindow →
//            carried-forward last-known-good (the previous committed
//            snapshot) → loud unshippable-row failure. Context may carry
//            forward: a stale length is reviewable diff noise, never a
//            billing error.
//   cost:    catalog `pricing` → models page index row rates → model
//            detail page header → RSC slug-record rates → loud
//            unshippable-row failure. **Costs never carry forward** — a
//            model going free must never be billed at its old rate.
//   modalities: catalog `inputModalities` → models page Caps Vision bit →
//            text-only fallback (a pending report, never a failure).
//
// The RSC goat/pro pages and the models page index are enrichment-only:
// they are consulted lazily (only when a record actually needs a ladder
// step), never as the model list. Detail pages are live-fetch-only on
// cost-ladder use and are never pinned (issue #129). Only two loud
// failure classes survive: an unshippable row after the full ladder, and
// a parser shape change in any source.
//
// A record with no `pricing` block resolves via the ladder and ships with
// its provenance (`costSource`); a record missing a required field, or a
// `pricing` block whose rates are unparseable, is a loud shape failure
// (parser work, never a silent default); missing never zero-fills (a zero
// rate means explicitly free).
//
// Usage: node scripts/refresh-snapshot.mjs [--out path] [--facts-out path]
//   --out        write the snapshot to this path (default src/catalog/snapshot.ts)
//   --facts-out  write the facts shim to this path (default <out dir>/facts.ts)
//   env COMMANDCODE_API_BASE overrides the API base (tests point at the mock)
//   env COMMANDCODE_REGISTRY_URL overrides the npm registry URL (tests point at the mock)
//   env COMMANDCODE_CATALOG_URL overrides the catalog endpoint (tests point at the mock)
//   env COMMANDCODE_RSC_GOAT_URL / COMMANDCODE_RSC_PRO_URL override the RSC
//       slug-record pages (used only when a record needs a ladder step)
//   env COMMANDCODE_MODELS_PAGE_URL overrides the models page index
//   env COMMANDCODE_MODELS_DETAIL_URL overrides the model detail page base
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const DEFAULT_API_BASE = "https://api.commandcode.ai"
const DEFAULT_OUT = resolve(import.meta.dirname, "..", "src", "catalog", "snapshot.ts")
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/command-code"
const DEFAULT_CATALOG_URL = (base) => `${base}/provider/v1/models?view=client`
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
 * here is a note-only failure — never a ship-bar gate.
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
        row.contextSource === undefined ? '"catalog"' : JSON.stringify(row.contextSource)
      }, ` +
      `efforts: ${row.efforts === null ? "null" : JSON.stringify(row.efforts)}, cost: ${
        row.cost === null
          ? "null"
          : `{ input: ${row.cost.input}, output: ${row.cost.output}, cacheRead: ${row.cost.cacheRead}, cacheWrite: ${row.cost.cacheWrite} }`
      }, costSource: ${
        row.costSource === undefined || row.costSource === null
          ? '"catalog"'
          : JSON.stringify(row.costSource)
      } },`,
  )
  return [
    "// src/catalog/snapshot.ts — GENERATED by scripts/refresh-snapshot.mjs. Do not edit.",
    "//",
    "// A copy of the Command Code model catalog bundled in the package so the",
    "// plugin can auto-register every model without network access at runtime.",
    "// Since ADR-0024 the catalog endpoint's client view",
    "// (`GET /provider/v1/models?view=client`) decides which models ship — the",
    "// same source the Command Code CLI resolves models from — so every",
    "// selectable (non-`hidden`) record ships here with its ship-bar fields",
    "// (id, name, exact context length, costs, efforts). A record whose ship-bar",
    "// cell upstream left blank is resolved through the ordered enrichment",
    "// ladders (context: RSC contextWindow → carried-forward; cost: models page",
    "// index → detail page → RSC rates — costs never carry forward), and each",
    "// row carries its `contextSource` / `costSource` provenance. Regenerate",
    "// with `npm run refresh:snapshot`.",
    "",
    "export interface CatalogModel {",
    "  readonly id: string",
    "  readonly name: string",
    "  readonly contextLength: number | null",
    '  /** "catalog" when the endpoint supplied it; else the ladder step that resolved it. */',
    '  readonly contextSource: "catalog" | "rsc" | "carried-forward"',
    "  readonly efforts: readonly string[] | null",
    "  readonly cost: {",
    "    readonly input: number",
    "    readonly output: number",
    "    readonly cacheRead: number",
    "    readonly cacheWrite: number",
    "  } | null",
    '  /** "catalog" when the endpoint supplied it; else the ladder step that resolved it. */',
    '  readonly costSource: "catalog" | "models-page" | "detail" | "rsc"',
    "}",
    "",
    `export const MODEL_SNAPSHOT: readonly CatalogModel[] = [`,
    ...modelLines,
    "]",
    "",
    // Provenance (source URL, catalog + package version, refresh date)
    // deliberately lives in facts.ts only — the cron's drift check ignores
    // date-only churn in the generated modules, and a redundant date stamp in
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
    "// Capability facts derived from the catalog-primary Snapshot rows in",
    "// src/catalog/snapshot.ts (ADR-0024): reasoning efforts, rates and input",
    "// modalities all come from the catalog endpoint's client view",
    "// (`/provider/v1/models?view=client`), which is the source the Command Code",
    "// CLI itself resolves models from. Regenerate with",
    "// `npm run refresh:snapshot`.",
    "",
    `export const FACTS_SOURCE_URL = ${JSON.stringify(metadata.sourceUrl)}`,
    `export const FACTS_CATALOG_VERSION = ${JSON.stringify(metadata.catalogVersion)}`,
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

// --- Source of truth: the Command Code model catalog (ADR-0024) ---
const { parseModelCatalog } = await import("./parse-catalog.mjs")
const registry = await fetchJson(registryUrl)
const latest = registry?.["dist-tags"]?.latest
if (typeof latest !== "string" || latest.length === 0) {
  fail(`could not resolve latest command-code version from ${registryUrl}`)
}
// The package version no longer decides which models ship; it feeds the runtime
// `x-command-code-version` header (the legacy gateway version-gates it) and
// the version-pinned provider specifier (ADR-0009).
const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
const sourceUrl = process.env.COMMANDCODE_CATALOG_URL ?? DEFAULT_CATALOG_URL(apiBase)

const catalogPayload = await fetchJson(sourceUrl)

let parsed
try {
  parsed = parseModelCatalog(catalogPayload)
} catch (error) {
  fail(`could not parse ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`)
}
if (parsed.rows.length === 0) fail("Command Code model catalog contains no selectable rows")

const rows = parsed.rows.map((row) => ({
  id: row.id,
  name: row.name,
  contextLength: row.contextLength,
  contextSource: row.contextSource,
  efforts: row.efforts,
  cost: row.cost,
  costSource: row.costSource,
}))

const packageIds = new Set(rows.map((row) => row.id))
if (packageIds.size !== rows.length) {
  fail("Command Code model catalog contains duplicate model ids")
}
if (parsed.hidden.length > 0) {
  console.log(
    `refresh-snapshot: catalog marks ${parsed.hidden.length} record(s) hidden (not offered): ${parsed.hidden.join(", ")}`,
  )
}
console.log(`refresh-snapshot: catalog version ${parsed.catalogVersion}`)

// ---------------------------------------------------------------------------
// Issue #132 fallback ladders. A catalog record can still carry
// `cost: null` (no `pricing` block). Those gaps are resolved through ordered
// enrichment ladders (never a silent zero-fill, never a blocking failure for
// a single row, and for costs NEVER a carry-forward):
//
//   context: catalog context_length → RSC slug-record contextWindow →
//            carried-forward LKG → loud fail
//   cost:    catalog pricing → models page index row → model detail
//            page header → RSC slug-record rates → loud fail
//   modalities: catalog inputModalities → models page Caps Vision →
//            text fallback (pending)
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
// The slugs the models page carried, when it was fetched — `null` means "no
// page evidence", which keeps the page-relative pin classes "not evaluated"
// rather than falsely clean. Set alongside `pageCache`.
let pageSlugs = null
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
  pageSlugs = parsedRows.map((row) => row.slug)
  const byId = new Map()
  for (const row of parsedRows) {
    let id
    try {
      id = slugToSnapshotId(row.slug)
    } catch {
      // A slug the pinned map doesn't know is *pin drift*, not a shape
      // change: upstream is ahead of the pin, and the page is enrichment —
      // never decides what ships, never a gate (issue #132). Skipping the row costs
      // that model its models-page rung and nothing else; the drift is
      // reported with the other pin classes below, and the ladder carries
      // on. (This used to `fail()` here, which aborted the whole refresh —
      // the cost ladder would have died on the first docs-ahead slug the
      // day any catalog record lost its pricing block.)
      continue
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
  // --- context ladder: catalog context_length → RSC contextWindow
  // → carried-forward LKG → loud unshippable-row failure ---
  if (row.contextLength === null) {
    const rscWindow = rscSlugRecords.get(row.id)?.contextWindow
    if (typeof rscWindow === "number" && Number.isFinite(rscWindow) && rscWindow > 0) {
      row.contextLength = rscWindow
      row.contextSource = "rsc"
      console.log(`refresh-snapshot: context ${row.id}: ${rscWindow} (from RSC contextWindow)`)
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
            `(catalog, RSC contextWindow, carried-forward) — ` +
            `unshippable row (issue #129 ship-bar)`,
        )
      }
    }
  }

  // --- cost ladder (NEVER carries forward):
  // catalog pricing → models page index row → detail header → RSC rates →
  // loud unshippable-row failure. There is deliberately no last-known-good
  // step for costs anywhere in the pipeline (a model going free must never
  // be billed at its old rate). ---
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
              `(catalog, models page index, detail page, RSC rates) — ` +
              `unshippable row (issue #129 ship-bar). Costs never carry forward.`,
          )
        }
      }
    }
  }
}

// Modalities: the catalog record's `inputModalities` is authoritative and
// arrives with the model list, so no CLI-bundle scrape is needed any more (that
// 3.3 MB regex read is retired with ADR-0024). A record advertising nothing
// still walks the #132 modalities ladder — catalog → models page Caps Vision
// → text-only fallback — which only matters for an upstream gap.
const modalities = {}
const missingModalities = []
for (const row of rows) {
  const record = parsed.rows.find((entry) => entry.id === row.id)
  // MODEL_INPUT_MODALITIES is image-only by convention (text-only models are
  // omitted; the runtime falls back to ["text"]), so a record advertising text
  // alone adds nothing.
  if (record?.modalities !== undefined && record.modalities.includes("image")) {
    modalities[row.id] = record.modalities
  } else if (record?.modalities === undefined) {
    missingModalities.push(row.id)
  }
}
if (missingModalities.length > 0) {
  console.log(
    `refresh-snapshot: modalities pending — catalog advertises none for ${missingModalities.length} model(s): ${missingModalities.join(", ")}`,
  )
}
// A catalog record with no modality list stays text-only via the runtime
// fallback and MAY be promoted to image by the models page Caps Vision bit
// (issue #132 ladder). MODEL_INPUT_MODALITIES is image-only by convention
// (text-only models are omitted; the runtime falls back to ["text"]), so only
// a page-Vision-promoted model enters the map — with a visible pending note
// for the plain text-only fallback. The models page is fetched only when such
// a record exists; a page fetch failure degrades to text-only (pending
// report), never a loud failure.
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
for (const id of missingModalities) {
  const pageRow = pageForModalities.get(id)
  if (pageRow?.caps?.vision === true) {
    modalities[id] = ["text", "image"]
    console.log(
      `refresh-snapshot: modalities ${id}: text + image (from models page Caps Vision bit)`,
    )
  } else {
    console.log(
      `refresh-snapshot: modalities pending — ${id}: catalog advertises none and no Caps Vision evidence; text-only fallback`,
    )
  }
}

// Annotate-only divergence notes (issue #130: API demoted to enrichment).
// Note-only: the plain listing endpoint (`/provider/v1/models`, the thin
// shape) is a different resource from the client view that decides
// the model list. It should agree on ids; when it does not, that is worth a line
// in the refresh log but never a gate (ADR-0024: the client view is
// model list, the plain view is neither authority nor fallback).
const apiIds = await fetchApiModelIds()
if (apiIds !== null) {
  const apiSet = new Set(apiIds)
  const inCatalogNotApi = rows.filter((row) => !apiSet.has(row.id)).map((row) => row.id)
  const inApiNotCatalog = apiIds.filter((id) => !packageIds.has(id))
  if (inCatalogNotApi.length > 0) {
    console.log(
      `refresh-snapshot: divergence note — shipped models the plain listing endpoint does not serve: ${inCatalogNotApi.join(", ")}`,
    )
  }
  if (inApiNotCatalog.length > 0) {
    console.log(
      `refresh-snapshot: divergence note — served by the plain listing endpoint but not shipped by the catalog: ${inApiNotCatalog.join(", ")}`,
    )
  }
  if (inCatalogNotApi.length === 0 && inApiNotCatalog.length === 0) {
    console.log(
      "refresh-snapshot: divergence note — plain listing endpoint agrees with the shipped catalog",
    )
  }
}

const out = argValue("--out") ?? DEFAULT_OUT
const factsOut = argValue("--facts-out") ?? resolve(dirname(out), "facts.ts")
const metadata = {
  sourceUrl,
  catalogVersion: parsed.catalogVersion,
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

// Pinned-slug-map drift (spec #108 pending report, issue #132 contract).
// The map mirrors two upstream-owned facts — the models-page slug and the
// Snapshot id — so upstream can rename either out from under it (the
// 2026-09-19/20 cron failure: `meituan/LongCat-2.0:free` →
// `meituan/LongCat-2.0`, slug `longcat-2-0-free` → `longcat-2-0`). Reported
// as pending pins for the refresh-PR body; never a failure, never silent.
{
  const { slugMapPinReport } = await import("./parse-models-page.mjs")
  const pins = slugMapPinReport({
    snapshotIds: [...packageIds],
    pageSlugs: pageSlugs ?? undefined,
  })
  for (const { slug, id } of pins.stale ?? []) {
    console.log(
      `refresh-snapshot: slug map pending — value ${slug} → ${id}: pinned id is not in the Snapshot (re-pin the map)`,
    )
  }
  for (const slug of pins.dangling ?? []) {
    console.log(
      `refresh-snapshot: slug map pending — key ${slug}: pinned key has no live models-page row (prune or re-pin)`,
    )
  }
  for (const slug of pins.unmapped ?? []) {
    console.log(
      `refresh-snapshot: slug map pending — key ${slug}: models-page slug not in the pinned map (docs-ahead; page evidence skipped)`,
    )
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
