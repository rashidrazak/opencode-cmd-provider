// scripts/refresh-classification.mjs — regenerate src/catalog/classification.ts
// (the Core-side reasoning classification module, issues #110/#132).
//
// The per-model reasoning capability is **derived** from three evidence
// channels, any-true-wins (issue #132):
//
//   1. the `reasoning` flag on the Command Code docs' RSC slug records
//      (plans/goat + plans/pro; slug-id aliasing applied, keyed by snapshot
//      id — the same records the Deals generator consumes);
//   2. a models.md **efforts** entry for the model (the snapshot rows;
//      models.md is the Snapshot membership authority since #130);
//   3. the models page index Caps **Reasoning** bit for the model.
//
// A model is reasoning-capable when ANY channel says yes. Classification is
// a Core provider concern, so the module lives in the catalog layer (never
// the excisable Deals slice).
//
// The capability map is **sparse** (issue #132): only models with evidence
// get a MODEL_REASONING_CAPABILITY entry (true when any channel fires,
// false when present evidence is all-negative). A snapshot model with NO
// evidence anywhere ships in the visible `MODEL_REASONING_PENDING` bucket —
// it behaves as non-reasoning at runtime and flips with zero code the moment
// evidence arrives (a new RSC record, an efforts entry, or a page Reasoning
// bit). The pending list is emitted into the module so a refresh reviewer
// sees exactly which models lack capability evidence.
//
// Shape gates stay loud (never a silent default): a consumed slug record
// missing any required field (including the `reasoning` flag) aborts naming
// the model — upstream renames need parser work. Missing *evidence* is never
// loud: that is the pending bucket. Note-less override entries are rejected
// at generation time (scripts/classification-overrides.mjs).
//
// Usage: node scripts/refresh-classification.mjs [--out path] [--fixtures]
//   --fixtures       regenerate from the committed tests/fixtures/rsc-*.txt
//                    fixtures (offline) — the cron path inside
//                    `npm run refresh` (ordered after fixture capture, so
//                    no extra network is needed)
//   --allow-partial  accepted for backwards compatibility (the coverage
//                    gate is gone; missing records are pending, not loud)
//   --snapshot-path  snapshot module to read the efforts evidence from
//                    (default src/catalog/snapshot.ts)
//   env COMMANDCODE_RSC_GOAT_URL   overrides the RSC goat plan URL
//   env COMMANDCODE_RSC_PRO_URL    overrides the RSC pro plan URL
//   env COMMANDCODE_MODELS_PAGE_URL overrides the models page URL (page
//                    evidence; --fixtures reads the committed fixture)
//
// Live fetch semantics (ADR-0005, via the shared record source
// scripts/rsc-source.mjs): 5xx / network failure → fall back to the
// committed fixtures; 4xx → fail loudly and write nothing. The models page
// is enrichment-only for classification: a fetch failure degrades to no
// page evidence with a note (never loud).
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { extractPlanPageRsc, missingFields, REQUIRED_SLUG_RECORD_FIELDS } from "./parse-rsc.mjs"
import { parseModelsPage, slugToSnapshotId } from "./parse-models-page.mjs"
import { RSC_PAGES, loadRscPages } from "./rsc-source.mjs"
import {
  CLASSIFICATION_OVERRIDES,
  applyClassificationOverride,
  validateClassificationOverrides,
} from "./classification-overrides.mjs"
import { snapshotIndex } from "./snapshot-index.mjs"

const DEFAULT_OUT = resolve(import.meta.dirname, "..", "src", "catalog", "classification.ts")
const DEFAULT_SNAPSHOT_PATH = resolve(import.meta.dirname, "..", "src", "catalog", "snapshot.ts")
const DEFAULT_MODELS_PAGE_URL = "https://commandcode.ai/models"
const FIXTURES_DIR = resolve(import.meta.dirname, "..", "tests", "fixtures")

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

// Snapshot entry regex — the same row shape snapshot-index.mjs reads, plus
// the efforts cell (needed for the any-true efforts evidence channel).
const SNAPSHOT_ENTRY_RE =
  /\{ id: "([^"]+)", name: "([^"]+)", contextLength: (?:null|[0-9]+),[\s\S]*?efforts: (null|\[[^\]]*\]),/g

/**
 * Reads the snapshot module text and returns the membership ids + per-id
 * efforts (the issue #132 efforts evidence channel). A snapshot row with a
 * non-null efforts array counts as "efforts evidence". Pure text parse (the
 * refresh runs under plain node; never a runtime import of a .ts file).
 *
 * @param {string} snapshotText
 * @returns {{ byId: Set<string>, effortsById: Record<string, string[]> }}
 */
export function snapshotEvidenceFromText(snapshotText) {
  const byId = new Set()
  const effortsById = {}
  for (const match of snapshotText.matchAll(SNAPSHOT_ENTRY_RE)) {
    byId.add(match[1])
    if (match[3] !== "null") {
      // Strip quotes: ["low", "high"] → low, high
      effortsById[match[1]] = [...match[3].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    }
  }
  return { byId, effortsById }
}

/**
 * Parses the models page HTML into the issue #132 page-evidence channel:
 * snapshot id → { reasoning } (the Caps Reasoning bit). A slug the pinned
 * TOTAL map does not know is dropped with a loud note (it is docs-ahead
 * skew; the page is enrichment — never membership, never a gate).
 *
 * @param {string} html
 * @returns {{ pageById: Map<string, { reasoning: boolean }>, pending: string[] }}
 */
export function pageEvidenceFromHtml(html) {
  const { rows } = parseModelsPage(html)
  const pageById = new Map()
  const pending = []
  for (const row of rows) {
    let id
    try {
      id = slugToSnapshotId(row.slug)
    } catch {
      pending.push(row.slug)
      continue
    }
    pageById.set(id, { reasoning: row.caps.reasoning })
  }
  return { pageById, pending }
}

/**
 * Derives the per-model capability map + pending list from the three
 * evidence channels. Any-true-wins:
 *
 *   reasoning = efforts entry present  OR  RSC `reasoning` true  OR
 *               models page Caps Reasoning true
 *
 * A model with at least one evidence channel gets a map entry (true or
 * false — the false entry records that upstream evidence was checked and
 * was negative). A model with NO evidence at all is omitted from the map
 * and listed in the pending bucket. Overrides apply last (they may force
 * a value, and an override entry counts as human evidence — a pending
 * model with an override is emitted with the overridden value).
 *
 * Loud shape gate: every consumed slug record must satisfy the required
 * slug-record fields (which include the `reasoning` flag). Records whose id
 * doesn't resolve to a snapshot id are dropped — they are new upstream
 * models the snapshot doesn't carry yet.
 *
 * @param {Map<string, Record<string, unknown>>} bySnapshotId RSC slug records
 * @param {{ effortsById?: Record<string, string[]>, pageById?: Map<string, { reasoning: boolean }>, byId?: Set<string>, overrides?: Record<string, { capability: boolean, justification: string }> }} [options]
 * @returns {{ capability: Record<string, boolean>, pending: string[] }}
 *   capability: sorted snapshot id → final capability; pending: sorted
 *   snapshot ids with no evidence anywhere.
 */
export function deriveCapability(bySnapshotId, options = {}) {
  const {
    effortsById = {},
    pageById = new Map(),
    byId = snapshotIndex().byId,
    overrides = CLASSIFICATION_OVERRIDES,
  } = options
  validateClassificationOverrides(overrides)
  // snapshotIndex().byId is a Map (id → name); callers may pass a Set of
  // ids. Normalize to a Set of ids for iteration + membership checks.
  const idSet =
    byId instanceof Set ? byId : new Set(byId instanceof Map ? byId.keys() : Object.keys(byId))
  const overrideIds = new Set(Object.keys(overrides))
  const withRecord = new Set()
  const capability = {}
  for (const [sid, record] of bySnapshotId) {
    if (!idSet.has(sid)) continue
    withRecord.add(sid)
    const missing = missingFields(record, REQUIRED_SLUG_RECORD_FIELDS)
    if (missing.length > 0) {
      throw new Error(
        `refresh-classification: shape failure — snapshot model ${sid} is missing required ` +
          `slug-record field(s): ${missing.join(", ")}. The Command Code RSC schema changed; ` +
          `this needs parser work, not a silent default-to-non-reasoning.`,
      )
    }
    const anyTrue =
      (effortsById[sid]?.length ?? 0) > 0 ||
      record.reasoning === true ||
      pageById.get(sid)?.reasoning === true
    capability[sid] = applyClassificationOverride(sid, anyTrue, overrides)
  }
  // Models with efforts or page evidence but no RSC record (day-1 docs-lag
  // cases) still get entries — any-true across channels, never RSC-only.
  const effortIds = Object.keys(effortsById)
  for (const sid of effortIds) {
    if (!idSet.has(sid) || withRecord.has(sid)) continue
    const anyTrue = (effortsById[sid]?.length ?? 0) > 0 || pageById.get(sid)?.reasoning === true
    capability[sid] = applyClassificationOverride(sid, anyTrue, overrides)
  }
  for (const [sid, pageRow] of pageById) {
    if (!idSet.has(sid) || withRecord.has(sid) || capability[sid] !== undefined) continue
    capability[sid] = applyClassificationOverride(sid, pageRow.reasoning === true, overrides)
  }
  // Overrides on an otherwise-evidence-less model are human evidence.
  for (const sid of overrideIds) {
    if (!idSet.has(sid) || capability[sid] !== undefined) continue
    capability[sid] = overrides[sid].capability
  }
  // Pending: snapshot ids with no evidence anywhere and no override.
  const pending = []
  for (const sid of idSet) {
    if (capability[sid] !== undefined) continue
    const hasEfforts = (effortsById[sid]?.length ?? 0) > 0
    const hasRecord = bySnapshotId.has(sid)
    const hasPage = pageById.has(sid)
    if (!hasEfforts && !hasRecord && !hasPage) pending.push(sid)
  }
  const sorted = (record) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
  return {
    capability: sorted(capability),
    pending: [...pending].sort((a, b) => a.localeCompare(b)),
  }
}

/**
 * Builds the classification module text from the evidence channels.
 *
 * @param {{ goatRsc: string, proRsc: string, lastRefreshed: string, effortsById?: Record<string, string[]>, modelsPageHtml?: string, overrides?: Record<string, { capability: boolean, justification: string }> }} args
 * @returns {string}
 */
export function buildClassificationModule({
  goatRsc,
  proRsc,
  lastRefreshed,
  effortsById = {},
  modelsPageHtml,
  overrides = CLASSIFICATION_OVERRIDES,
}) {
  validateClassificationOverrides(overrides)
  const goatSlug = extractPlanPageRsc(goatRsc ?? "")
  const proSlug = extractPlanPageRsc(proRsc ?? "")
  const bySnapshotId = new Map([...goatSlug, ...proSlug])
  let pageById = new Map()
  if (modelsPageHtml !== undefined) {
    const pageEvidence = pageEvidenceFromHtml(modelsPageHtml)
    pageById = pageEvidence.pageById
    if (pageEvidence.pending.length > 0) {
      // Unmapped page slugs are docs-ahead skew (the page lists a model the
      // snapshot doesn't carry) — enrichment never gates, so they degrade
      // to a loud note instead of a failure.
      console.log(
        `refresh-classification: note — models page lists ${pageEvidence.pending.length} slug(s) not in the pinned slug-to-id map (docs-ahead; page evidence skipped for them): ${pageEvidence.pending.join(", ")}`,
      )
    }
  }
  const { capability, pending } = deriveCapability(bySnapshotId, {
    effortsById,
    pageById,
    overrides,
  })
  const capabilityLines = Object.entries(capability).map(
    ([id, value]) => `  ${JSON.stringify(id)}: ${value},`,
  )
  const pendingLines = pending.map((id) => `  ${JSON.stringify(id)},`)
  const overrideLines = Object.entries(overrides)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([id, entry]) =>
        `  ${JSON.stringify(id)}: { capability: ${entry.capability}, justification: ${JSON.stringify(entry.justification)} },`,
    )
  return [
    "// src/catalog/classification.ts — GENERATED by scripts/refresh-classification.mjs. Do not edit.",
    "//",
    "// Per-model reasoning capability, derived any-true-wins across the",
    "// models.md efforts entries, the `reasoning` flag on the Command Code",
    "// docs' RSC slug records (plans/goat + plans/pro, slug-id aliasing",
    "// applied, keyed by snapshot id), and the models page Caps Reasoning",
    "// bit (issue #132). The map is sparse: only models with evidence get an",
    "// entry (true = any channel fires; false = checked evidence is",
    "// all-negative). Models with NO evidence anywhere ship in",
    "// MODEL_REASONING_PENDING — they behave as non-reasoning at runtime and",
    "// flip with zero code when evidence arrives. Classification is",
    "// upstream-managed and derived, never hand-maintained; the only human",
    "// seam is CLASSIFICATION_OVERRIDES, whose entries each carry a written",
    "// justification naming the upstream disagreement (see ADR-0006).",
    "// Regenerate with `npm run refresh` (offline:",
    "// `npm run refresh:classification -- --fixtures`).",
    "",
    `export const CLASSIFICATION_SOURCE_URLS: ReadonlyArray<string> = [`,
    `  ${JSON.stringify(RSC_PAGES.goat.defaultUrl)},`,
    `  ${JSON.stringify(RSC_PAGES.pro.defaultUrl)},`,
    "]",
    "",
    `export const CLASSIFICATION_LAST_REFRESHED = ${JSON.stringify(lastRefreshed)}`,
    "",
    "// Active capability overrides. Empty = upstream data is truth.",
    "// Every entry requires a written justification naming the upstream",
    "// disagreement; entries are rendered into the refresh PR body.",
    "export const CLASSIFICATION_OVERRIDES: Readonly<Record<string, { capability: boolean; justification: string }>> = {",
    ...overrideLines,
    "}",
    "",
    "// Snapshot models with no capability evidence anywhere (no RSC record,",
    "// no models.md efforts, no models page Reasoning bit). They behave as",
    "// non-reasoning and land in this bucket until evidence arrives — the",
    "// next refresh moves them into MODEL_REASONING_CAPABILITY with zero code.",
    "export const MODEL_REASONING_PENDING: ReadonlyArray<string> = [",
    ...pendingLines,
    "]",
    "",
    "export const MODEL_REASONING_CAPABILITY: Readonly<Record<string, boolean>> = {",
    ...capabilityLines,
    "}",
    "",
  ].join("\n")
}

/**
 * Full pipeline: parse the per-plan payloads + page evidence, derive the
 * sparse map + pending list, build the module text. Pure apart from the
 * shape-gate throws (missing records are pending, never loud).
 *
 * @param {{ goatRsc: string, proRsc: string, lastRefreshed: string, effortsById?: Record<string, string[]>, modelsPageHtml?: string, overrides?: Record<string, { capability: boolean, justification: string }> }} args
 * @returns {{ module: string, entryCount: number }} the module text and the
 *   number of emitted classification entries
 */
export function emitClassificationModuleFromRsc({
  goatRsc,
  proRsc,
  lastRefreshed,
  effortsById,
  modelsPageHtml,
  overrides = CLASSIFICATION_OVERRIDES,
}) {
  const module = buildClassificationModule({
    goatRsc,
    proRsc,
    lastRefreshed,
    effortsById,
    modelsPageHtml,
    overrides,
  })
  const entryCount = (module.match(/^  "[^"]+": (?:true|false),$/gm) ?? []).length
  return { module, entryCount }
}

async function main() {
  // Page subset: the classification generator consumes the per-plan pages
  // only — the pricing-limits page is not fetched (no extra network).
  const fixturesMode = process.argv.includes("--fixtures")
  const urls = {}
  for (const key of ["goat", "pro"]) {
    const page = RSC_PAGES[key]
    const override = process.env[page.env]
    if (override) urls[key] = override
  }
  let goatRsc
  let proRsc
  try {
    ;({ goat: goatRsc, pro: proRsc } = await loadRscPages({
      keys: ["goat", "pro"],
      mode: fixturesMode ? "fixtures" : "live",
      urls,
      fixturesDir: argValue("--fixtures-dir"),
      prefix: "refresh-classification",
    }))
  } catch (error) {
    // A 4xx (RscHttpError) is a config error — fail loudly, write nothing.
    console.error(
      `refresh-classification: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }

  // Efforts evidence: the snapshot module (membership + models.md efforts).
  const snapshotPath = argValue("--snapshot-path") ?? DEFAULT_SNAPSHOT_PATH
  let effortsById = {}
  try {
    effortsById = snapshotEvidenceFromText(await readFile(snapshotPath, "utf-8")).effortsById
  } catch (error) {
    console.error(
      `refresh-classification: could not read snapshot for efforts evidence (${snapshotPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(1)
  }

  // Page evidence: the models page index (Caps Reasoning bit). In fixtures
  // mode read the committed fixture (captured by refresh:fixtures before
  // this step in `npm run refresh`); live mode fetches with a note-only
  // degrade — the page is enrichment, never a gate.
  let modelsPageHtml
  if (fixturesMode) {
    try {
      modelsPageHtml = await readFile(
        resolve(argValue("--fixtures-dir") ?? FIXTURES_DIR, "models-page.html"),
        "utf-8",
      )
    } catch {
      modelsPageHtml = undefined
    }
  } else {
    const url = process.env.COMMANDCODE_MODELS_PAGE_URL ?? DEFAULT_MODELS_PAGE_URL
    try {
      const response = await fetch(url, { headers: { accept: "text/html" } })
      if (response.ok) modelsPageHtml = await response.text()
      else
        console.log(
          `refresh-classification: note — models page returned ${response.status}; page evidence skipped`,
        )
    } catch (error) {
      console.log(
        `refresh-classification: note — models page unreachable; page evidence skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  const out = argValue("--out") ?? DEFAULT_OUT
  let module
  let entryCount = 0
  try {
    ;({ module, entryCount } = emitClassificationModuleFromRsc({
      goatRsc,
      proRsc,
      effortsById,
      modelsPageHtml,
      lastRefreshed: new Date().toISOString().split("T")[0],
    }))
  } catch (error) {
    // Shape-gate failures are loud: exit non-zero without writing anything.
    console.error(
      `refresh-classification: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, module, "utf-8")
  console.log(`refresh-classification: wrote ${entryCount} classification entries to ${out}`)
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(
      `refresh-classification: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  })
}
