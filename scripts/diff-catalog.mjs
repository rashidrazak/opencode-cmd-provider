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
 */

/**
 * @typedef {Object} DiffOptions
 * @property {string} [label]
 * @property {string} [beforeDate]
 * @property {string} [afterDate]
 * @property {string} [dateLabel]
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

/**
 * Build the per-model diff lines for a `snapshot` kind. Reports
 * `name` and `contextLength` changes (id changes are reported as
 * add+remove, not as a per-field change).
 *
 * @param {string} id
 * @param {CatalogModel} before
 * @param {CatalogModel} after
 * @returns {string[]}
 */
function snapshotModelDiffLines(id, before, after) {
  const lines = []
  if (before.name !== after.name) {
    lines.push(`- \`${id}\`: name \`${before.name}\` → \`${after.name}\``)
  }
  if (before.contextLength !== after.contextLength) {
    lines.push(
      `- \`${id}\`: contextLength \`${before.contextLength}\` → \`${after.contextLength}\``,
    )
  }
  return lines
}

/**
 * Build the per-model diff lines for a `deals` kind. Reports every
 * field-level change. Ignores `id` (id changes are add+remove).
 *
 * @param {string} id
 * @param {ModelDeals} before
 * @param {ModelDeals} after
 * @returns {string[]}
 */
function dealsModelDiffLines(id, before, after) {
  const lines = []
  if (before.tier !== after.tier) {
    lines.push(`- \`${id}\`: tier \`${before.tier ?? "—"}\` → \`${after.tier ?? "—"}\``)
  }
  if (before.free !== after.free) {
    lines.push(`- \`${id}\`: free \`${String(before.free)}\` → \`${String(after.free)}\``)
  }
  if (!ratesEqual(before.was, after.was)) {
    lines.push(`- \`${id}\`: was ${rateString(before.was)} → ${rateString(after.was)}`)
  }
  if (!ratesEqual(before.now, after.now)) {
    lines.push(`- \`${id}\`: now ${rateString(before.now)} → ${rateString(after.now)}`)
  }
  if (!discountEqual(before.discount, after.discount)) {
    lines.push(
      `- \`${id}\`: discount ${discountString(before.discount)} → ${discountString(after.discount)}`,
    )
  }
  if (!allowanceEqual(before.allowance, after.allowance)) {
    lines.push(
      `- \`${id}\`: allowance ${allowanceString(before.allowance)} → ${allowanceString(after.allowance)}`,
    )
  }
  if (!peakOffPeakEqual(before.peakOffPeak, after.peakOffPeak)) {
    lines.push(
      `- \`${id}\`: peakOffPeak ${peakOffPeakString(before.peakOffPeak)} → ${peakOffPeakString(after.peakOffPeak)}`,
    )
  }
  if (!ratesEqual4(before.overContext, after.overContext)) {
    lines.push(
      `- \`${id}\`: overContext ${dealRatesString(before.overContext)} → ${dealRatesString(after.overContext)}`,
    )
  }
  if (!benchmarkEqual(before.benchmark, after.benchmark)) {
    const beforeStr = before.benchmark
      ? `intelligence ${before.benchmark.intelligence ?? "—"}, tok/s ${before.benchmark.tokPerSec ?? "—"}`
      : "—"
    const afterStr = after.benchmark
      ? `intelligence ${after.benchmark.intelligence ?? "—"}, tok/s ${after.benchmark.tokPerSec ?? "—"}`
      : "—"
    lines.push(`- \`${id}\`: benchmark ${beforeStr} → ${afterStr}`)
  }
  return lines
}

function ratesEqual(a, b) {
  return (
    (a === undefined && b === undefined) ||
    (a !== undefined &&
      b !== undefined &&
      a.input === b.input &&
      a.output === b.output &&
      a.cacheRead === b.cacheRead)
  )
}

function ratesEqual4(a, b) {
  return (
    (a === undefined && b === undefined) ||
    (a !== undefined &&
      b !== undefined &&
      a.input === b.input &&
      a.output === b.output &&
      a.cacheRead === b.cacheRead &&
      a.cacheWrite === b.cacheWrite)
  )
}

function discountEqual(a, b) {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return a.pct === b.pct && (a.endsAt ?? null) === (b.endsAt ?? null)
}

function allowanceEqual(a, b) {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()
  if (ak.length !== bk.length) return false
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false
    if (a[ak[i]] !== b[bk[i]]) return false
  }
  return true
}

function peakOffPeakEqual(a, b) {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return (
    (a.windows ?? "") === (b.windows ?? "") &&
    ratesEqual4(a.peak, b.peak) &&
    ratesEqual4(a.offPeak, b.offPeak)
  )
}

function benchmarkEqual(a, b) {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return (
    (a.intelligence ?? null) === (b.intelligence ?? null) &&
    (a.tokPerSec ?? null) === (b.tokPerSec ?? null)
  )
}

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
  if (category.kind === "efforts") return `efforts model (\`${category.levels.join(", ")}\`)`
  if (category.kind === "reasoning") return "reasoning-without-efforts"
  return "non-reasoning"
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
  if (beforeCategory.kind === afterCategory.kind) {
    if (
      beforeCategory.kind !== "efforts" ||
      afterCategory.kind !== "efforts" ||
      beforeCategory.levels.join(",") === afterCategory.levels.join(",")
    ) {
      return ""
    }
  }
  const b = categoryLabel(beforeCategory)
  const a = categoryLabel(afterCategory)
  if (beforeCategory.kind === "none") return `- \`${id}\`: new reasoning model (${a})`
  if (afterCategory.kind === "none") return `- \`${id}\`: no longer reasoning (was ${b})`
  return `- \`${id}\`: ${b} → ${a}`
}

/**
 * Builds the "Reasoning classification" section body (the part after the
 * header/date lines). Deterministic: ids sorted, same inputs → same bytes.
 * Present-in-both models render flips/promotions; a model present only on
 * the before side renders as retired (when it was reasoning); a model
 * present only on the after side renders as a new reasoning model.
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
  const lines = []
  for (const id of ids) {
    const beforeCategory = classificationCategory(id, before.capability, before.efforts)
    const afterCategory = classificationCategory(id, after.capability, after.efforts)
    if (!afterIds.has(id)) {
      // Retired upstream — only a classification change if it was reasoning.
      if (beforeCategory.kind !== "none") {
        lines.push(`- retired: \`${id}\` (was ${categoryLabel(beforeCategory)})`)
      }
      continue
    }
    if (!beforeIds.has(id)) {
      // New upstream — only a classification change if it is reasoning.
      if (afterCategory.kind !== "none") {
        lines.push(`- new reasoning model: \`${id}\` (${categoryLabel(afterCategory)})`)
      }
      continue
    }
    const line = classificationChangeLine(id, beforeCategory, afterCategory)
    if (line) lines.push(line)
  }
  if (lines.length === 0) return ["No changes.", ""]
  lines.push("")
  return lines
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
    const beforeCategory = classificationCategory(id, b.capability, b.efforts)
    const afterCategory = classificationCategory(id, a.capability, a.efforts)
    if (
      beforeCategory.kind !== afterCategory.kind ||
      (beforeCategory.kind === "efforts" &&
        afterCategory.kind === "efforts" &&
        beforeCategory.levels.join(",") !== afterCategory.levels.join(","))
    ) {
      return true
    }
  }
  return false
}

/**
 * Render the diff between two catalogs as a Markdown string.
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
  const added = []
  const removed = []
  const changed = []
  for (const id of beforeIndex.keys()) {
    if (!afterIndex.has(id)) removed.push(id)
  }
  for (const id of afterIndex.keys()) {
    if (!beforeIndex.has(id)) {
      added.push(id)
    } else {
      const beforeEntry = beforeIndex.get(id)
      const afterEntry = afterIndex.get(id)
      const diffLines =
        kind === "snapshot"
          ? snapshotModelDiffLines(
              id,
              /** @type {CatalogModel} */ (beforeEntry),
              /** @type {CatalogModel} */ (afterEntry),
            )
          : dealsModelDiffLines(
              id,
              /** @type {ModelDeals} */ (beforeEntry),
              /** @type {ModelDeals} */ (afterEntry),
            )
      if (diffLines.length > 0) changed.push(...diffLines)
    }
  }
  added.sort()
  removed.sort()
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    sections.push("No changes.", "")
    return sections.join("\n")
  }
  if (added.length > 0) {
    sections.push(`### Added models (${added.length})`, "")
    for (const id of added) sections.push(`- \`${id}\``)
    sections.push("")
  }
  if (removed.length > 0) {
    sections.push(`### Removed models (${removed.length})`, "")
    for (const id of removed) sections.push(`- \`${id}\``)
    sections.push("")
  }
  if (changed.length > 0) {
    sections.push(
      `### Changed models (${changed.length} field${changed.length === 1 ? "" : "s"})`,
      "",
    )
    for (const line of changed) sections.push(line)
    sections.push("")
  }
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
  const { readFile } = await import("node:fs/promises")
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
  if (kind === "classification") {
    const { readFile: readJson } = await import("node:fs/promises")
    const mergeFacts = async (payload, factsPath) => {
      if (!factsPath) return payload
      try {
        const facts = JSON.parse(await readJson(factsPath, "utf-8"))
        return { ...payload, efforts: facts.MODEL_EFFORTS ?? facts.efforts ?? payload.efforts }
      } catch {
        return payload
      }
    }
    before = await mergeFacts(before, options.beforeFactsPath)
    after = await mergeFacts(after, options.afterFactsPath)
  }
  process.stdout.write(diffCatalogs({ kind, before, after, ...options }))
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`diff-catalog: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
