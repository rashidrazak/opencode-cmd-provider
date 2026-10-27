// scripts/parse-catalog.mjs — parse the Command Code model catalog
// (`GET /provider/v1/models?view=client`) into Snapshot membership rows.
//
// Since ADR-0024 this endpoint is the Snapshot's membership authority: it is
// what the Command Code CLI itself resolves models from, so a model the CLI
// offers is a model this plugin offers. `models.md` — the previous authority —
// is a rendering of this catalog's non-`hidden` rows, which is why it lagged
// every catalog change by a package release (gpt-6.1-terra launched 2026-10-27
// and reached no package until later).
//
// Shape discipline (ADR-0008's parser rule survives the source change): a
// required field that is missing or has the wrong type is a loud shape failure
// naming the model — never a silent default. Optional-but-present fields are
// validated too, so upstream renaming one is parser work rather than a
// quietly wrong catalog. `hidden` records are excluded from membership but are
// not an error: they are the catalog's own "not selectable" marker.
//
// Two normalizations happen here rather than in the emitters:
//   - the thinking-ladder `off` is dropped from `reasoningEfforts` (ADR-0019:
//     it means "send nothing", never an advertised effort, and the generated
//     MODEL_EFFORTS drives the variant cycle which pins the no-`off` contract);
//   - `cacheWriteCost` absent means the provider bills no cache write, so it
//     ships as an explicit 0 (matching the models.md-era rows).

/** The thinking-ladder level that is never an advertised reasoning effort. */
const NON_VOCABULARY_EFFORTS = new Set(["off"])

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

/**
 * A finite, non-negative rate. Absent is handled by the caller; a present but
 * unusable rate is a shape failure — a guessed number would bill wrongly.
 */
function rate(value, id, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${id}.${field} is not a non-negative number (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * The catalog record's pricing block → a Snapshot cost row, or null when the
 * record carries no pricing at all (a free/stealth record or an upstream gap:
 * the refresh's cost ladder then engages, exactly as a blank models.md price
 * cell used to).
 */
function parsePricing(value, id) {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) {
    throw new Error(`${id}.pricing is not an object (got ${JSON.stringify(value)})`)
  }
  // cacheWriteCost is genuinely absent on most models (the provider bills no
  // write), which is an explicit 0 — distinct from a missing input/output.
  const cacheWrite =
    value.cacheWriteCost === undefined || value.cacheWriteCost === null
      ? 0
      : rate(value.cacheWriteCost, id, "pricing.cacheWriteCost")
  return {
    input: rate(value.inputCost, id, "pricing.inputCost"),
    output: rate(value.outputCost, id, "pricing.outputCost"),
    cacheRead: rate(value.cacheReadCost, id, "pricing.cacheReadCost"),
    cacheWrite,
  }
}

/**
 * The catalog record's reasoning efforts → the advertised vocabulary, or null
 * when nothing usable remains ("the model decides its own depth").
 *
 * A null/absent list is the normal "no advertised levels" case. A list that is
 * not an array of strings is a shape failure: the efforts feed both the
 * variant cycle and the reasoning classification.
 */
function parseEfforts(value, id) {
  if (value === undefined || value === null) return null
  if (!isStringArray(value)) {
    throw new Error(`${id}.reasoningEfforts is not a string array (got ${JSON.stringify(value)})`)
  }
  const levels = value.filter((level) => !NON_VOCABULARY_EFFORTS.has(level))
  return levels.length > 0 ? levels : null
}

/**
 * The catalog record's input modalities → the Snapshot's modality facts, or
 * undefined when the record advertises none (the runtime falls back to text).
 *
 * `null` is upstream's "unspecified" and is tolerated; any other non-string
 * array is a shape failure. Only `text`/`image` are meaningful to the runtime,
 * so an unknown modality is dropped rather than shipped as an unusable value.
 */
function parseModalities(value, id) {
  if (value === undefined || value === null) return undefined
  if (!isStringArray(value)) {
    throw new Error(`${id}.inputModalities is not a string array (got ${JSON.stringify(value)})`)
  }
  const modalities = value.filter((entry) => entry === "text" || entry === "image")
  return modalities.length > 0 ? modalities : undefined
}

/**
 * One catalog record → a membership row, or null when the record is `hidden`
 * (the catalog's own "do not offer this" marker: free variants, retired
 * aliases, stealth previews).
 */
function parseRecord(record) {
  if (!isRecord(record)) {
    throw new Error(`catalog entry is not an object (got ${JSON.stringify(record)})`)
  }
  const { id, name, context_length: contextLength } = record
  if (!isNonEmptyString(id)) {
    throw new Error(`catalog entry has no usable id (got ${JSON.stringify(record)})`)
  }
  if (record.hidden !== undefined && typeof record.hidden !== "boolean") {
    throw new Error(`${id}.hidden is not a boolean (got ${JSON.stringify(record.hidden)})`)
  }
  if (record.hidden === true) return null
  if (!isNonEmptyString(name)) {
    throw new Error(`${id}.name is not a non-empty string (got ${JSON.stringify(name)})`)
  }
  // Absent/null is a gap the refresh's context ladder resolves (RSC
  // contextWindow → carried-forward), exactly as a blank models.md cell was.
  // Present but unusable is a shape change: a guessed window would break the
  // host's context limit silently.
  let parsedContext = null
  if (contextLength !== undefined && contextLength !== null) {
    if (
      typeof contextLength !== "number" ||
      !Number.isInteger(contextLength) ||
      contextLength <= 0
    ) {
      throw new Error(
        `${id}.context_length is not a positive integer (got ${JSON.stringify(contextLength)})`,
      )
    }
    parsedContext = contextLength
  }
  if (record.display !== undefined && !isRecord(record.display)) {
    throw new Error(`${id}.display is not an object (got ${JSON.stringify(record.display)})`)
  }
  return {
    id,
    name,
    contextLength: parsedContext,
    contextSource: parsedContext === null ? null : "catalog",
    efforts: parseEfforts(record.reasoningEfforts, id),
    cost: parsePricing(record.pricing, id),
    costSource: record.pricing === undefined || record.pricing === null ? null : "catalog",
    modalities: parseModalities(record.inputModalities, id),
  }
}

/**
 * Parses a client-view catalog payload into Snapshot membership rows.
 *
 * @returns {{
 *   rows: Array<{id: string, name: string, contextLength: number,
 *     contextSource: string, efforts: string[]|null,
 *     cost: {input: number, output: number, cacheRead: number, cacheWrite: number}|null,
 *     costSource: string|null, modalities: ("text"|"image")[]|undefined}>,
 *   hidden: string[],
 *   catalogVersion: string,
 *   refreshAfterSeconds: number|undefined,
 * }}
 */
export function parseModelCatalog(payload) {
  if (!isRecord(payload)) {
    throw new Error(`catalog payload is not an object (got ${JSON.stringify(payload)})`)
  }
  if (!isNonEmptyString(payload.catalogVersion)) {
    throw new Error(
      `catalog payload has no catalogVersion (got ${JSON.stringify(payload.catalogVersion)})`,
    )
  }
  if (!Array.isArray(payload.data)) {
    throw new Error(`catalog payload has no data array (got ${JSON.stringify(payload.data)})`)
  }
  const rows = []
  const hidden = []
  for (const record of payload.data) {
    const row = parseRecord(record)
    if (row === null) {
      hidden.push(record.id)
      continue
    }
    rows.push(row)
  }
  const ids = new Set(rows.map((row) => row.id))
  if (ids.size !== rows.length) {
    throw new Error("catalog payload contains duplicate model ids")
  }
  if (rows.length === 0) {
    throw new Error("catalog payload contains no selectable model rows")
  }
  return {
    rows,
    hidden,
    catalogVersion: payload.catalogVersion,
    refreshAfterSeconds:
      typeof payload.refreshAfterSeconds === "number" ? payload.refreshAfterSeconds : undefined,
  }
}
