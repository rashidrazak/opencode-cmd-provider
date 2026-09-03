// scripts/diff-catalog.mjs — pure Markdown diff for the cron PR body.
//
// The catalog-refresh workflow (`.github/workflows/catalog-refresh.yml`,
// ticket #85) opens a daily PR when the generated snapshot/deals modules
// drift from `main`. The PR body needs a human-readable summary of the
// drift so a reviewer can decide whether to merge in one click. This
// module is the single source of that summary.
//
// Two flavours of catalog are diffed:
//
//   - `snapshot` — the model-id catalog (MODEL_SNAPSHOT). An entry is
//     `{ id, name, contextLength }`. We surface added/removed models and
//     per-model `name` / `contextLength` changes. The package's
//     FACTS_LAST_REFRESHED date is also surfaced (top-level field on
//     `src/catalog/facts.ts`).
//
//   - `deals` — the per-model deal intelligence (MODEL_DEALS). An entry
//     is a `ModelDeals` (allowance/discount/was/now/peakOffPeak/
//     overContext/benchmark/tier/free). We surface added/removed models
//     and the per-field changes (allowance, discount.pct, discount.endsAt,
//     tier, free, plus the numeric rate fields). The DEAL_LAST_REFRESHED
//     date is also surfaced (top-level field on `src/deals/catalog.ts`).
//
// The output is stable, deterministic Markdown. Same inputs always
// produce the same bytes (keys are sorted before iteration), so a test
// can assert on the exact output without flake. Section headers use
// `##` so the Markdown renders as H2 inside GitHub's PR comment.
//
// The function is pure: no network, no file I/O, no mutation. Callers
// pass in the parsed module objects (or their file contents as strings,
// when invoked from the cron). Tests exercise the function against
// inline synthetic data so the test file has no fixtures of its own.
import { readFile } from "node:fs/promises"

/**
 * @typedef {Object} CatalogModel
 * @property {string} id
 * @property {string} name
 * @property {number} contextLength
 */

/**
 * @typedef {Object} ModelDeals
 * @property {{[k: string]: number}=} allowance
 * @property {{pct: number, endsAt?: string}=} discount
 * @property {{input:number, output:number, cacheRead:number}=} was
 * @property {{input:number, output:number, cacheRead:number}=} now
 * @property {{peak:{input:number,output:number,cacheRead:number,cacheWrite:number},offPeak:{input:number,output:number,cacheRead:number,cacheWrite:number},windows:string}=} peakOffPeak
 * @property {{input:number,output:number,cacheRead:number,cacheWrite:number}=} overContext
 * @property {{intelligence?:number,tokPerSec?:number}=} benchmark
 * @property {"opensource"|"premium"=} tier
 * @property {boolean} free
 */

/**
 * @typedef {"snapshot" | "deals" | "classification"} DiffKind
 */

/**
 * @typedef {Object} ClassificationPayload
 * A normalized classification payload: what the cron extracts from the
 * generated classification module (MODEL_REASONING_CAPABILITY) plus the
 * generated facts (MODEL_EFFORTS) and the module's embedded overrides.
 * Both the cron's wrapper keys and the bare names are accepted.
 * @property {boolean} missing    true when the before module was absent (first refresh)
 * @property {Record<string, boolean>} capability
 * @property {Record<string, string[]>} efforts
 * @property {Record<string, {capability: boolean, justification: string}>} overrides
 */

/**
 * @typedef {Object} DiffInput
 * @property {string} [label]              Optional section title (e.g. "Model catalog", "Deals intelligence"). Defaults are derived from `kind`.
 * @property {unknown} before              The "before" catalog (parsed module object, or its array/record portion).
 * @property {unknown} after               The "after" catalog.
 * @property {string} [beforeDate]         Last-refreshed date from the "before" side (e.g. FACTS_LAST_REFRESHED). Optional.
 * @property {string} [afterDate]          Last-refreshed date from the "after" side. Optional.
 * @property {string} [dateLabel]          Human label for the date pair (e.g. "FACTS_LAST_REFRESHED"). Defaults to "Last refreshed".
 * @property {unknown} [beforeFacts]       The "before" facts payload (MODEL_COSTS / MODEL_EFFORTS) — the snapshot kind diffs base pricing and efforts when provided.
 * @property {unknown} [afterFacts]        The "after" facts payload.
 */

/**
 * @typedef {Object} DiffOptions
 * @property {string} [label]
 * @property {string} [beforeDate]
 * @property {string} [afterDate]
 * @property {string} [dateLabel]
 * @property {string} [beforeFactsPath]
 * @property {string} [afterFactsPath]
 */

const DEFAULT_LABELS = {
  snapshot: "Model catalog",
  deals: "Deals intelligence",
  classification: "Reasoning classification",
}

const DEFAULT_DATE_LABELS = {
  snapshot: "FACTS_LAST_REFRESHED",
  deals: "DEAL_LAST_REFRESHED",
  classification: "CLASSIFICATION_LAST_REFRESHED",
}

function asRecord(value) {
  return value !== null && typeof value === "object"
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

/**
 * Index a catalog into `Map<id, record>`. Accepts three shapes:
 *   1. The `readonly CatalogModel[]` shape (snapshot) — indexed by
 *      each entry's `id` field.
 *   2. The `Readonly<Record<string, ModelDeals>>` shape (deals) —
 *      indexed by the record's key.
 *   3. A wrapping module-export shape `{ MODEL_SNAPSHOT: [...] }` or
 *      `{ MODEL_DEALS: {...} }` — the wrapper is unwrapped to the
 *      underlying catalog. The cron (`.github/workflows/
 *      catalog-refresh.yml`, ticket #85) extracts the generated .ts
 *      files as `{MODEL_SNAPSHOT: [...]}` / `{MODEL_DEALS: {...}}`
 *      via `tsx`, so the wrapping shape is the most common CLI input.
 *
 * @param {unknown} catalog
 * @param {(value: unknown, key: string) => string | undefined} idOf
 * @returns {Map<string, unknown>}
 */
function indexCatalog(catalog, idOf) {
  // Unwrap the module-export shape (the cron's `tsx` extract writes
  // `{MODEL_SNAPSHOT: [...]}` / `{MODEL_DEALS: {...}}` to disk).
  const record = asRecord(catalog)
  if (record && (record.MODEL_SNAPSHOT !== undefined || record.MODEL_DEALS !== undefined)) {
    catalog = record.MODEL_SNAPSHOT ?? record.MODEL_DEALS
  }
  const index = new Map()
  if (Array.isArray(catalog)) {
    for (const entry of catalog) {
      const id = idOf(entry, "")
      if (typeof id === "string" && id.length > 0) index.set(id, entry)
    }
  } else if (asRecord(catalog)) {
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (catalog))) {
      const id = idOf(value, key)
      if (typeof id === "string" && id.length > 0) index.set(id, value)
    }
  }
  return index
}

const snapshotIdOf = (entry) => /** @type {{id?: unknown}} */ (entry)?.id
const dealsIdOf = (_entry, key) => key

function rateString(rates) {
  if (!rates || typeof rates !== "object") return "—"
  const r = /** @type {Record<string, unknown>} */ (rates)
  const input = typeof r.input === "number" ? r.input : Number(r.input)
  const output = typeof r.output === "number" ? r.output : Number(r.output)
  const cacheRead = typeof r.cacheRead === "number" ? r.cacheRead : Number(r.cacheRead)
  if (!Number.isFinite(input) || !Number.isFinite(output) || !Number.isFinite(cacheRead)) {
    return JSON.stringify(rates)
  }
  return `in ${input} / out ${output} / cache ${cacheRead}`
}

function dealRatesString(rates) {
  if (!rates || typeof rates !== "object") return "—"
  const r = /** @type {Record<string, unknown>} */ (rates)
  const input = typeof r.input === "number" ? r.input : Number(r.input)
  const output = typeof r.output === "number" ? r.output : Number(r.output)
  const cacheRead = typeof r.cacheRead === "number" ? r.cacheRead : Number(r.cacheRead)
  const cacheWrite = typeof r.cacheWrite === "number" ? r.cacheWrite : Number(r.cacheWrite)
  if (
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    !Number.isFinite(cacheRead) ||
    !Number.isFinite(cacheWrite)
  ) {
    return JSON.stringify(rates)
  }
  return `in ${input} / out ${output} / cacheRead ${cacheRead} / cacheWrite ${cacheWrite}`
}

function discountString(discount) {
  if (!discount || typeof discount !== "object") return "—"
  const d = /** @type {Record<string, unknown>} */ (discount)
  const pct = typeof d.pct === "number" ? d.pct : Number(d.pct)
  if (!Number.isFinite(pct)) return JSON.stringify(discount)
  return d.endsAt ? `${pct}% off (ends ${d.endsAt})` : `${pct}% off`
}

function allowanceString(allowance) {
  if (!allowance || typeof allowance !== "object") return "—"
  const parts = Object.entries(/** @type {Record<string, unknown>} */ (allowance))
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .map(([plan, v]) => `${plan}: ${v}`)
    .sort(([a], [b]) => a.localeCompare(b))
  return parts.length === 0 ? "—" : parts.join(", ")
}

function peakOffPeakString(pop) {
  if (!pop || typeof pop !== "object") return "—"
  const p = /** @type {Record<string, unknown>} */ (pop)
  const peak = /** @type {Record<string, unknown> | undefined} */ (asRecord(p.peak))
  const offPeak = /** @type {Record<string, unknown> | undefined} */ (asRecord(p.offPeak))
  const windows = typeof p.windows === "string" ? p.windows : ""
  if (!peak || !offPeak) return JSON.stringify(pop)
  const peakStr = dealRatesString(peak)
  const offStr = dealRatesString(offPeak)
  return windows
    ? `peak ${peakStr} · off-peak ${offStr} (${windows})`
    : `peak ${peakStr} · off-peak ${offStr}`
}

// ---------------------------------------------------------------------------
// Markdown table rendering. Tables are the release-notes contract (issue:
// "the auto-release must state which models were added, removed, and
// changed — pricing, efforts, etc."). The renderer emits tables already in
// Prettier's normal form — pipe-padded to the widest cell per column — so
// the release pipeline's `format:check` passes on the emitted CHANGELOG
// without a Prettier run inside the workflow. Verified against Prettier's
// markdown table normalization: `| --- |` separators, no leading/trailing
// pipes dropped, one space inside each cell border.
// ---------------------------------------------------------------------------

/**
 * Renders rows as a padded Markdown table. `rows[0]` is the header.
 * Deterministic: same rows → same bytes. An empty row list returns [].
 *
 * @param {string[][]} rows header + body rows; every row must have the
 *   same column count as the header
 * @returns {string[]}
 */
function renderTable(rows) {
  if (rows.length === 0) return []
  const columns = rows[0].length
  const widths = []
  for (const row of rows) {
    if (row.length !== columns) {
      throw new Error(
        `renderTable: row has ${row.length} cells, expected ${columns}: ${JSON.stringify(row)}`,
      )
    }
    for (let c = 0; c < columns; c++) {
      widths[c] = Math.max(widths[c] ?? 0, row[c].length)
    }
  }
  const pad = (cell, width) => ` ${cell.padEnd(width)} `
  const out = []
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map((cell, c) => pad(cell, widths[c]))
    out.push(`|${cells.join("|")}|`)
    if (r === 0) {
      out.push(`|${widths.map((w) => ` ${"-".repeat(Math.max(w, 1))} `).join("|")}|`)
    }
  }
  return out
}

/**
 * Formats a base-pricing entry (`MODEL_COSTS` shape) as
 * `in X / out Y / cache Z / write W`. The `—` placeholder keeps the table
 * column aligned when a side lacks the entry.
 *
 * @param {unknown} rates
 * @returns {string}
 */
function baseCostString(rates) {
  if (!rates || typeof rates !== "object") return "—"
  const r = /** @type {Record<string, unknown>} */ (rates)
  const parts = ["input", "output", "cacheRead", "cacheWrite"].map((key) =>
    typeof r[key] === "number" ? `${key} ${r[key]}` : null,
  )
  const present = parts.filter((part) => part !== null)
  return present.length > 0 ? present.join(" / ") : "—"
}

/**
 * Normalizes a raw extracted facts payload into { missing, costs,
 * efforts }. Accepts the cron's module-export wrapper keys and the bare
 * names. A payload without either map is "missing".
 *
 * @param {unknown} value
 * @returns {{ missing: boolean, costs: Record<string, unknown>, efforts: Record<string, string[]> }}
 */
function factsPayloadOf(value) {
  const rec = asRecord(value)
  if (!rec) return { missing: true, costs: {}, efforts: {} }
  const costs = asRecord(rec.MODEL_COSTS ?? rec.costs) ?? {}
  const efforts = asRecord(rec.MODEL_EFFORTS ?? rec.efforts) ?? {}
  const missing =
    (rec.MODEL_COSTS ?? rec.costs) === undefined && (rec.MODEL_EFFORTS ?? rec.efforts) === undefined
  return { missing, costs, efforts: /** @type {Record<string, string[]>} */ (efforts) }
}

/**
 * Build the change rows for a `snapshot` kind. Reports `name`,
 * `contextLength`, base pricing (from the facts payload when provided),
 * and efforts (likewise). Added/removed models are one row each with the
 * full row visible on its new side.
 *
 * @param {Map<string, unknown>} beforeIndex
 * @param {Map<string, unknown>} afterIndex
 * @param {{ before: ReturnType<typeof factsPayloadOf>, after: ReturnType<typeof factsPayloadOf> }} facts
 * @returns {{ rows: string[][], empty: boolean }}
 */
function snapshotChangeRows(beforeIndex, afterIndex, facts) {
  const ids = [...new Set([...beforeIndex.keys(), ...afterIndex.keys()])].sort((a, b) =>
    a.localeCompare(b),
  )
  const rows = []
  for (const id of ids) {
    const before = /** @type {CatalogModel | undefined} */ (beforeIndex.get(id))
    const after = /** @type {CatalogModel | undefined} */ (afterIndex.get(id))
    const nameOf = (model) => (model ? model.name : "—")
    const ctxOf = (model) => (model ? String(model.contextLength) : "—")
    const beforeCost = facts.before.costs[id]
    const afterCost = facts.after.costs[id]
    const beforeEfforts = facts.before.efforts[id]
    const afterEfforts = facts.after.efforts[id]
    const costChanged = JSON.stringify(beforeCost ?? null) !== JSON.stringify(afterCost ?? null)
    const effortsChanged =
      JSON.stringify(beforeEfforts ?? null) !== JSON.stringify(afterEfforts ?? null)
    if (!before) {
      rows.push([`\`${id}\``, "added", "—", `${nameOf(after)} · ${ctxOf(after)} ctx`])
      continue
    }
    if (!after) {
      rows.push([`\`${id}\``, "removed", `${nameOf(before)} · ${ctxOf(before)} ctx`, "—"])
      continue
    }
    const nameChanged = before.name !== after.name
    const ctxChanged = before.contextLength !== after.contextLength
    if (nameChanged || ctxChanged) {
      rows.push([
        `\`${id}\``,
        [nameChanged ? "renamed" : null, ctxChanged ? "context" : null]
          .filter((part) => part !== null)
          .join(" + "),
        `${nameOf(before)} · ${ctxOf(before)} ctx`,
        `${nameOf(after)} · ${ctxOf(after)} ctx`,
      ])
    }
    if (costChanged) {
      rows.push([`\`${id}\``, "pricing", baseCostString(beforeCost), baseCostString(afterCost)])
    }
    if (effortsChanged) {
      rows.push([
        `\`${id}\``,
        "efforts",
        beforeEfforts ? beforeEfforts.join(", ") : "—",
        afterEfforts ? afterEfforts.join(", ") : "—",
      ])
    }
  }
  return { rows, empty: rows.length === 0 }
}

/**
 * Build the per-model diff lines for a `deals` kind. Reports every
 * field-level change. Ignores `id` (id changes are add+remove).
 *
 * @param {Map<string, unknown>} beforeIndex
 * @param {Map<string, unknown>} afterIndex
 * @returns {{ rows: string[][], empty: boolean }}
 */
function dealsChangeRows(beforeIndex, afterIndex) {
  const ids = [...new Set([...beforeIndex.keys(), ...afterIndex.keys()])].sort((a, b) =>
    a.localeCompare(b),
  )
  const rows = []
  for (const id of ids) {
    const before = /** @type {ModelDeals | undefined} */ (beforeIndex.get(id))
    const after = /** @type {ModelDeals | undefined} */ (afterIndex.get(id))
    const tierOf = (deal) => `${deal?.tier ?? "—"}${deal?.free ? " (free)" : ""}`
    if (!before) {
      rows.push([`\`${id}\``, "added", "—", tierOf(after)])
      continue
    }
    if (!after) {
      rows.push([`\`${id}\``, "removed", tierOf(before), "—"])
      continue
    }
    const fieldRows = [
      ["tier", tierOf(before), tierOf(after)],
      ["free", String(before.free), String(after.free)],
      ["was rates", rateString(before.was), rateString(after.was)],
      ["now rates", rateString(before.now), rateString(after.now)],
      ["discount", discountString(before.discount), discountString(after.discount)],
      ["allowance", allowanceString(before.allowance), allowanceString(after.allowance)],
      ["peakOffPeak", peakOffPeakString(before.peakOffPeak), peakOffPeakString(after.peakOffPeak)],
      ["overContext", dealRatesString(before.overContext), dealRatesString(after.overContext)],
      ["benchmark", benchmarkString(before.benchmark), benchmarkString(after.benchmark)],
    ]
    for (const [field, beforeStr, afterStr] of fieldRows) {
      if (beforeStr !== afterStr) {
        rows.push([`\`${id}\``, field, beforeStr, afterStr])
      }
    }
  }
  return { rows, empty: rows.length === 0 }
}

/**
 * Canonical `tier` string (the old prose renderer wrapped it in backticks;
 * the table keeps plain text).
 *
 * @param {ModelDeals | undefined} deal
 * @returns {string}
 */
function dealsTierString(deal) {
  return deal?.tier ?? "—"
}

/**
 * Canonical benchmark string.
 *
 * @param {ModelDeals["benchmark"]} benchmark
 * @returns {string}
 */
function benchmarkString(benchmark) {
  if (!benchmark || typeof benchmark !== "object") return "—"
  const b = /** @type {Record<string, unknown>} */ (benchmark)
  return `intelligence ${b.intelligence ?? "—"}, tok/s ${b.tokPerSec ?? "—"}`
}

// Field changes are detected by comparing the canonical strings (below)
// — one comparison shape for every field, no per-field equality helpers.

// ---------------------------------------------------------------------------
// Classification diff (issue #112). Semantic sections rendered from
// before/after classification payloads: reasoning-without-efforts ↔ efforts
// flips (with the effort levels), new reasoning models, retirements, and the
// active classification overrides with their justification notes. The
// classification-changed boolean (classificationChanged below) is exposed
// for a future auto-merge policy and deliberately unconsumed by the cron.
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw extracted payload into { missing, capability, efforts,
 * overrides }. Accepts both the bare payload shape and the cron's
 * module-export wrapper keys. A payload without any capability map is
 * "missing" (the first-refresh case: the before side has no generated
 * classification module).
 *
 * @param {unknown} value
 * @returns {ClassificationPayload}
 */
function classificationPayloadOf(value) {
  const rec = asRecord(value)
  if (!rec) return { missing: true, capability: {}, efforts: {}, overrides: {} }
  const rawCapability = rec.MODEL_REASONING_CAPABILITY ?? rec.capability
  const capabilityRec = asRecord(rawCapability)
  const effortsRec = asRecord(rec.MODEL_EFFORTS ?? rec.efforts) ?? {}
  const overridesRec = asRecord(rec.CLASSIFICATION_OVERRIDES ?? rec.overrides) ?? {}
  return {
    missing: capabilityRec === null,
    capability: capabilityRec ?? {},
    efforts: /** @type {Record<string, string[]>} */ (/** @type {unknown} */ (effortsRec)),
    overrides: /** @type {ClassificationPayload["overrides"]} */ (
      /** @type {unknown} */ (overridesRec)
    ),
  }
}

/**
 * Derives a model's classification category from the capability map and
 * the efforts facts: efforts entry wins (efforts precedence, mirroring the
 * runtime derivation), then the capability flag, then non-reasoning.
 *
 * @param {string} id
 * @param {Record<string, boolean>} capability
 * @param {Record<string, string[]>} efforts
 * @returns {{ kind: "efforts", levels: string[] } | { kind: "reasoning" } | { kind: "none" }}
 */
function classificationCategory(id, capability, efforts) {
  const levels = efforts[id]
  if (Array.isArray(levels) && levels.length > 0) {
    return { kind: "efforts", levels: levels.map((level) => String(level)) }
  }
  if (capability[id] === true) return { kind: "reasoning" }
  return { kind: "none" }
}

function categoryLabel(category) {
  if (category.kind === "efforts") return `efforts model (${category.levels.join(", ")})`
  if (category.kind === "reasoning") return "reasoning-without-efforts"
  return "non-reasoning"
}

/**
 * Whether two classification categories represent a semantic move — a kind
 * flip, or an efforts model whose level list changed. The single source of
 * the comparison, shared by the section renderer and the
 * classification-changed boolean.
 *
 * @param {ReturnType<typeof classificationCategory>} a
 * @param {ReturnType<typeof classificationCategory>} b
 * @returns {boolean}
 */
function categoryMoved(a, b) {
  if (a.kind !== b.kind) return true
  return a.kind === "efforts" && b.kind === "efforts" && a.levels.join(",") !== b.levels.join(",")
}

/**
 * The plain-language change line for a model present on both sides whose
 * category moved, or "" when the category is unchanged.
 *
 * @param {string} id
 * @param {ReturnType<typeof classificationCategory>} beforeCategory
 * @param {ReturnType<typeof classificationCategory>} afterCategory
 * @returns {string}
 */
function classificationChangeLine(id, beforeCategory, afterCategory) {
  if (!categoryMoved(beforeCategory, afterCategory)) return ""
  const b = categoryLabel(beforeCategory)
  const a = categoryLabel(afterCategory)
  if (beforeCategory.kind === "none") return `- \`${id}\`: new reasoning model (${a})`
  if (afterCategory.kind === "none") return `- \`${id}\`: no longer reasoning (was ${b})`
  return `- \`${id}\`: ${b} → ${a}`
}

/**
 * Builds the "Reasoning classification" section body as a fixed Markdown
 * table (Model / Change / Before / After). Deterministic: ids sorted,
 * same inputs → same bytes. Present-in-both models render flips and
 * promotions; a model present only on the before side renders as retired
 * (when it was reasoning); a model present only on the after side renders
 * as a new reasoning model.
 *
 * @param {ClassificationPayload} before
 * @param {ClassificationPayload} after
 * @returns {string[]}
 */
function classificationSectionLines(before, after) {
  if (before.missing) {
    return ["_first refresh — no classification data on the before side._", ""]
  }
  const beforeIds = new Set([...Object.keys(before.capability), ...Object.keys(before.efforts)])
  const afterIds = new Set([...Object.keys(after.capability), ...Object.keys(after.efforts)])
  const ids = [...new Set([...beforeIds, ...afterIds])].sort((a, b) => a.localeCompare(b))
  const rows = []
  for (const id of ids) {
    const beforeCategory = classificationCategory(id, before.capability, before.efforts)
    const afterCategory = classificationCategory(id, after.capability, after.efforts)
    if (!afterIds.has(id)) {
      // Retired upstream — only a classification change if it was reasoning.
      if (beforeCategory.kind !== "none") {
        rows.push([`\`${id}\``, "retired", categoryLabel(beforeCategory), "—"])
      }
      continue
    }
    if (!beforeIds.has(id)) {
      // New upstream — only a classification change if it is reasoning.
      if (afterCategory.kind !== "none") {
        rows.push([`\`${id}\``, "new", "—", categoryLabel(afterCategory)])
      }
      continue
    }
    if (!categoryMoved(beforeCategory, afterCategory)) continue
    rows.push([
      `\`${id}\``,
      "classification",
      categoryLabel(beforeCategory),
      categoryLabel(afterCategory),
    ])
  }
  if (rows.length === 0) return ["No changes.", ""]
  return [...renderTable([["Model", "Change", "Before", "After"], ...rows]), ""]
}

/**
 * Renders the active classification overrides (with their justification
 * notes) as the section's sub-block. An empty override map renders
 * nothing — pinned judgment calls rot visibly, silence means there are
 * none.
 *
 * @param {ClassificationPayload} after
 * @returns {string[]}
 */
function overridesSectionLines(after) {
  const entries = Object.entries(after.overrides).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return []
  return [
    `### Active classification overrides (${entries.length})`,
    "",
    ...entries.map(
      ([id, entry]) => `- \`${id}\`: capability ${entry.capability} — ${entry.justification}`,
    ),
    "",
  ]
}

/**
 * Whether the classification data changed semantically between two
 * payloads: any category flip, promotion, or retirement — ignoring the
 * refreshed date (date-only churn is not a classification change) and the
 * override justifications (a note-only edit changes no emitted data).
 * Machine-readable signal for a future auto-merge policy; deliberately
 * unconsumed by the cron today.
 *
 * @param {{ before: unknown, after: unknown }} args
 * @returns {boolean}
 */
export function classificationChanged({ before, after }) {
  const b = classificationPayloadOf(before)
  const a = classificationPayloadOf(after)
  // Data presence changed (first refresh, or the module vanished) — count
  // it as a change so a future consumer stays conservative.
  if (b.missing !== a.missing) return true
  if (b.missing && a.missing) return false
  const ids = new Set([
    ...Object.keys(b.capability),
    ...Object.keys(b.efforts),
    ...Object.keys(a.capability),
    ...Object.keys(a.efforts),
  ])
  for (const id of ids) {
    if (
      categoryMoved(
        classificationCategory(id, b.capability, b.efforts),
        classificationCategory(id, a.capability, a.efforts),
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * Render the diff between two catalogs as a Markdown string: a fixed
 * Model / Change / Before / After table per kind (issue: "the release
 * notes must state which models were added, removed, and changed —
 * pricing, efforts, etc."). The snapshot kind additionally diffs base
 * pricing and efforts when a facts payload is supplied via
 * `beforeFacts` / `afterFacts` (MODEL_COSTS / MODEL_EFFORTS).
 *
 * @param {{kind: DiffKind} & DiffInput} args
 * @returns {string}
 */
export function diffCatalogs(args) {
  const { kind, before, after } = args
  if (kind !== "snapshot" && kind !== "deals" && kind !== "classification") {
    throw new Error(
      `diffCatalogs: unknown kind "${String(kind)}" (expected "snapshot", "deals", or "classification")`,
    )
  }
  const label = args.label ?? DEFAULT_LABELS[kind]
  const dateLabel = args.dateLabel ?? DEFAULT_DATE_LABELS[kind]
  const sections = [`## ${label}`, ""]
  const hasDates = typeof args.beforeDate === "string" && typeof args.afterDate === "string"
  if (hasDates) {
    sections.push(`- **${dateLabel}**: \`${args.beforeDate}\` → \`${args.afterDate}\``)
  }
  if (kind === "classification") {
    const beforePayload = classificationPayloadOf(before)
    const afterPayload = classificationPayloadOf(after)
    sections.push(...classificationSectionLines(beforePayload, afterPayload))
    sections.push(...overridesSectionLines(afterPayload))
    return sections.join("\n")
  }
  const idOf = kind === "snapshot" ? snapshotIdOf : dealsIdOf
  const beforeIndex = indexCatalog(before, idOf)
  const afterIndex = indexCatalog(after, idOf)
  const facts = {
    before: factsPayloadOf(args.beforeFacts ?? {}),
    after: factsPayloadOf(args.afterFacts ?? {}),
  }
  const changeRows =
    kind === "snapshot"
      ? snapshotChangeRows(beforeIndex, afterIndex, facts)
      : dealsChangeRows(beforeIndex, afterIndex)
  if (changeRows.empty) {
    sections.push("No changes.", "")
    return sections.join("\n")
  }
  sections.push(...renderTable([["Model", "Change", "Before", "After"], ...changeRows.rows]), "")
  return sections.join("\n")
}

// CLI entry point. `node scripts/diff-catalog.mjs <kind> <before.json> <after.json>
//   [--before-date YYYY-MM-DD] [--after-date YYYY-MM-DD] [--label "Title"]`
//
// For the `classification` kind the before/after JSONs are the cron's
// extracted classification-module payloads; the generated facts (which
// carry MODEL_EFFORTS, needed for the efforts category) are merged in via
// --before-facts / --after-facts when provided.
//
// Reads the two JSON files, diffs them, and prints the Markdown to
// stdout. The cron workflow uses this for the PR body (ticket #85).
async function main() {
  const args = process.argv.slice(2)
  if (args.length < 3) {
    console.error(
      "usage: node scripts/diff-catalog.mjs <snapshot|deals|classification> <before.json> <after.json> " +
        "[--before-date YYYY-MM-DD] [--after-date YYYY-MM-DD] [--label Title] [--date-label Label] " +
        "[--before-facts before-facts.json] [--after-facts after-facts.json]",
    )
    process.exit(2)
  }
  const kind = args[0]
  if (kind !== "snapshot" && kind !== "deals" && kind !== "classification") {
    console.error(
      `diff-catalog: unknown kind "${kind}" (expected "snapshot", "deals", or "classification")`,
    )
    process.exit(2)
  }
  const beforePath = args[1]
  const afterPath = args[2]
  let before, after
  try {
    before = JSON.parse(await readFile(beforePath, "utf-8"))
  } catch (error) {
    console.error(
      `diff-catalog: could not read before json (${beforePath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(1)
  }
  try {
    after = JSON.parse(await readFile(afterPath, "utf-8"))
  } catch (error) {
    console.error(
      `diff-catalog: could not read after json (${afterPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(1)
  }
  const options = {}
  for (let i = 3; i < args.length; i++) {
    if (args[i] === "--before-date" && i + 1 < args.length) options.beforeDate = args[++i]
    else if (args[i] === "--after-date" && i + 1 < args.length) options.afterDate = args[++i]
    else if (args[i] === "--label" && i + 1 < args.length) options.label = args[++i]
    else if (args[i] === "--date-label" && i + 1 < args.length) options.dateLabel = args[++i]
    else if (args[i] === "--before-facts" && i + 1 < args.length)
      options.beforeFactsPath = args[++i]
    else if (args[i] === "--after-facts" && i + 1 < args.length) options.afterFactsPath = args[++i]
  }
  // The classification kind merges the generated facts (MODEL_EFFORTS)
  // into the extracted classification payloads so the efforts category
  // renders with its levels. A missing facts file degrades to no efforts
  // data (the capability flag alone still renders).
  // The snapshot kind reads the same facts files as its beforeFacts /
  // afterFacts inputs so base pricing (MODEL_COSTS) and efforts diff
  // alongside the snapshot models.
  const readFacts = async (factsPath) => {
    if (!factsPath) return undefined
    try {
      return JSON.parse(await readFile(factsPath, "utf-8"))
    } catch {
      return undefined
    }
  }
  if (kind === "classification") {
    const mergeFacts = async (payload, factsPath) => {
      if (!factsPath) return payload
      try {
        const facts = JSON.parse(await readFile(factsPath, "utf-8"))
        return { ...payload, efforts: facts.MODEL_EFFORTS ?? facts.efforts ?? payload.efforts }
      } catch {
        return payload
      }
    }
    before = await mergeFacts(before, options.beforeFactsPath)
    after = await mergeFacts(after, options.afterFactsPath)
  } else if (kind === "snapshot") {
    options.beforeFacts = await readFacts(options.beforeFactsPath)
    options.afterFacts = await readFacts(options.afterFactsPath)
  }
  process.stdout.write(diffCatalogs({ kind, before, after, ...options }))
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`diff-catalog: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
