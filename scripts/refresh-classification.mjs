// scripts/refresh-classification.mjs — regenerate src/catalog/classification.ts
// (the Core-side reasoning classification module, issue #110).
//
// The per-model reasoning capability is **derived**: read once from the
// `reasoning` flag on the Command Code docs' RSC slug records (plans/goat +
// plans/pro — the per-plan pages; the pricing-limits page is not fetched),
// slug-id aliasing applied, keyed by snapshot id — the same records the
// Deals generator consumes. Classification is a Core provider concern, so
// the module lives in the catalog layer (never the excisable Deals slice).
//
// Usage: node scripts/refresh-classification.mjs [--out path] [--fixtures]
//   --fixtures       regenerate from the committed tests/fixtures/rsc-*.txt
//                    fixtures (offline) — the cron path inside
//                    `npm run refresh` (ordered after fixture capture, so
//                    no extra network is needed)
//   --allow-partial  do not fail on snapshot models missing from the RSC
//                    records (off for the standalone refresh so a partial
//                    classification can never be committed silently)
//   env COMMANDCODE_RSC_GOAT_URL   overrides the RSC goat plan URL
//   env COMMANDCODE_RSC_PRO_URL    overrides the RSC pro plan URL
//
// Live fetch semantics (ADR-0005, via the shared record source
// scripts/rsc-source.mjs): 5xx / network failure → fall back to the
// committed fixtures; 4xx → fail loudly and write nothing.
//
// Loud-by-design failure classes (never a silent default):
//   - a snapshot model with no RSC record → the coverage gate aborts the
//     refresh naming the missing models (a partial classification silently
//     under-advertises those models' reasoning capability);
//   - a consumed record missing any required slug-record field (including
//     the `reasoning` flag) → a loud shape failure naming the model;
//     upstream renames need parser work, not a silent non-reasoning default;
//   - a note-less or capability-less override entry → rejected at
//     generation time (scripts/classification-overrides.mjs).
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { extractPlanPageRsc, missingFields, REQUIRED_SLUG_RECORD_FIELDS } from "./parse-rsc.mjs"
import { RSC_PAGES, loadRscPages, missingSnapshotModels } from "./rsc-source.mjs"
import {
  CLASSIFICATION_OVERRIDES,
  applyClassificationOverride,
  validateClassificationOverrides,
} from "./classification-overrides.mjs"
import { snapshotIndex } from "./snapshot-index.mjs"

const DEFAULT_OUT = resolve(import.meta.dirname, "..", "src", "catalog", "classification.ts")

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/**
 * Derives the per-model capability map from snapshot-keyed slug records.
 * Loud shape gate: every consumed record must satisfy the required
 * slug-record fields (which include the `reasoning` flag). Records whose
 * id doesn't resolve to a snapshot id are dropped — they are new upstream
 * models the snapshot doesn't carry yet (the coverage gate separately
 * guarantees the converse: every snapshot model has a record).
 *
 * @param {Map<string, Record<string, unknown>>} bySnapshotId
 * @param {Record<string, { capability: boolean, justification: string }>} [overrides]
 * @returns {Record<string, boolean>} sorted model id → capability
 */
export function deriveCapabilityMap(bySnapshotId, overrides = CLASSIFICATION_OVERRIDES) {
  validateClassificationOverrides(overrides)
  const { byId: snapshotIds } = snapshotIndex()
  const capability = {}
  for (const [sid, record] of bySnapshotId) {
    if (!snapshotIds.has(sid)) continue
    const missing = missingFields(record, REQUIRED_SLUG_RECORD_FIELDS)
    if (missing.length > 0) {
      throw new Error(
        `refresh-classification: shape failure — snapshot model ${sid} is missing required ` +
          `slug-record field(s): ${missing.join(", ")}. The Command Code RSC schema changed; ` +
          `this needs parser work, not a silent default-to-non-reasoning.`,
      )
    }
    const upstream = record.reasoning === true
    capability[sid] = applyClassificationOverride(sid, upstream, overrides)
  }
  // Deterministic bytes: sorted ids.
  return Object.fromEntries(Object.entries(capability).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Builds the classification module text from snapshot-keyed slug records.
 * The derivation (with its loud shape gate) and the override validation
 * run here, so the emit step can't drift from the gates.
 *
 * @param {{ bySnapshotId: Map<string, Record<string, unknown>>, lastRefreshed: string, overrides?: Record<string, { capability: boolean, justification: string }> }} args
 * @returns {string}
 */
export function buildClassificationModule({
  bySnapshotId,
  lastRefreshed,
  overrides = CLASSIFICATION_OVERRIDES,
}) {
  validateClassificationOverrides(overrides)
  const capability = deriveCapabilityMap(bySnapshotId, overrides)
  const capabilityLines = Object.entries(capability).map(
    ([id, value]) => `  ${JSON.stringify(id)}: ${value},`,
  )
  const overrideLines = Object.entries(overrides)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([id, entry]) =>
        `  ${JSON.stringify(id)}: { capability: ${entry.capability}, justification: ${JSON.stringify(entry.justification)} },`,
    )
  return [
    "// src/catalog/classification.ts — GENERATED by scripts/refresh-classification.mjs. Do not edit.",
    "//",
    "// Per-model reasoning capability, derived from the `reasoning` flag on",
    "// the Command Code docs' RSC slug records (plans/goat + plans/pro,",
    "// slug-id aliasing applied, keyed by snapshot id) — the same",
    "// snapshot-keyed records the Deals catalog consumes. Classification is",
    "// upstream-managed and derived, never hand-maintained; the only human",
    "// seam is CLASSIFICATION_OVERRIDES, whose entries each carry a written",
    "// justification naming the upstream disagreement (see ADR-0006).",
    "// Regenerate with `npm run refresh` (offline:",
    "// `npm run refresh:classification -- --fixtures`).",
    "",
    `export const CLASSIFICATION_SOURCE_URLS: ReadonlyArray<string> = [`,
    `  ${JSON.stringify(RSC_PAGES.goat.defaultUrl)},`,
    `  ${JSON.stringify(RSC_PAGES.pro.defaultUrl)},`,
    `]`,
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
    "export const MODEL_REASONING_CAPABILITY: Readonly<Record<string, boolean>> = {",
    ...capabilityLines,
    "}",
    "",
  ].join("\n")
}

/**
 * Full RSC → module-text pipeline (pure apart from the gates' throws):
 * parse the per-plan payloads, run the coverage gate, derive the map,
 * build the module text.
 *
 * @param {{ goatRsc: string, proRsc: string, lastRefreshed: string, allowPartial?: boolean, overrides?: Record<string, { capability: boolean, justification: string }> }} args
 * @returns {{ module: string, entryCount: number }} the module text and
 *   the number of emitted classification entries
 */
export function emitClassificationModuleFromRsc({
  goatRsc,
  proRsc,
  lastRefreshed,
  allowPartial = false,
  overrides = CLASSIFICATION_OVERRIDES,
}) {
  const goatSlug = extractPlanPageRsc(goatRsc ?? "")
  const proSlug = extractPlanPageRsc(proRsc ?? "")
  const bySnapshotId = new Map([...goatSlug, ...proSlug])
  if (!allowPartial) {
    const { missing, covered } = missingSnapshotModels(bySnapshotId)
    if (missing.length > 0) {
      throw new Error(
        `refresh-classification: aborting — ${missing.length} snapshot model(s) have no RSC record ` +
          `(${covered}/${covered + missing.length} covered): ${missing.join(", ")}. ` +
          `The docs may have added models without exposing them in the RSC, or the RSC fixtures ` +
          `are stale. Re-run against live docs or refresh the RSC fixtures before regenerating; ` +
          `the generated classification would silently under-advertise these models.`,
      )
    }
  }
  const capability = deriveCapabilityMap(bySnapshotId, overrides)
  return {
    module: buildClassificationModule({ bySnapshotId, lastRefreshed, overrides }),
    entryCount: Object.keys(capability).length,
  }
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

  const out = argValue("--out") ?? DEFAULT_OUT
  let module
  let entryCount = 0
  try {
    ;({ module, entryCount } = emitClassificationModuleFromRsc({
      goatRsc,
      proRsc,
      lastRefreshed: new Date().toISOString().split("T")[0],
      allowPartial: process.argv.includes("--allow-partial"),
    }))
  } catch (error) {
    // Coverage-gate and shape-gate failures are loud: exit non-zero
    // without writing anything.
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
