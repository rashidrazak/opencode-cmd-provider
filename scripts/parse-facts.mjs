// scripts/parse-facts.mjs — parse models.md (command-code npm package bundled
// catalog) into the Snapshot membership rows: id, name, decimal context
// length, reasoning efforts, and flat per-1M-token rates.
//
// Since the models.md-primary flip (issue #130) the package table is the
// sole membership authority for the Snapshot: every row must ship, and the
// ship-bar fields (id, name, context, cost) parse from this one table. The
// listing API decides nothing and wins no field.
//
// Column format (verified against command-code@1.49.1):
//   | `id` | Name | Context | Efforts | $in/$out · cache $read (write $write) | Min plan | Best for |
// Efforts: comma-separated levels or "—" (model decides its own depth).
// Pricing: "$0.66/$1.98 · cache $0.022" with optional "(write $2.5)".
//
// Cell-level signals (issue #130):
//   - Context: coarse decimal tokens convert deterministically through a
//     pinned table (K × 1000, M × 1000000) — "1.05M" → 1050000,
//     "1M" → 1000000, "262K" → 262000. A missing cell ("—") parses to a
//     `context: undefined` signal so the refresh's fallback ladder can
//     engage (issue #132). An unknown token fails loudly: a shape change
//     upstream must be parser work, never a silent number.
//   - Price: a missing cell ("—") is a distinct signal from an unparseable
//     one. Missing means the cost fallback ladder may engage later;
//     unparseable fails loudly (a shape change). Missing never zero-fills —
//     a zero rate means explicitly free, nothing else.

// Context tokens → tokens: pinned decimal table (issue #129 decision:
// "1.05M" → 1050000-class values, deterministic, reviewable flip-day diffs).
// Upstream emits K/M suffixes with at most one decimal place; anything not
// in this shape is a shape change and must fail loudly.
const CONTEXT_TOKEN_RE = /^(\d+)(?:\.(\d+))?([KM])$/

/**
 * Parses a coarse Context cell ("1.05M", "256K") into tokens.
 * Returns undefined for a missing cell ("—" or empty). Throws for any
 * other value — the decimal table is pinned, so an unknown token is a
 * loud shape failure (never a silent default).
 */
export function parseContextCell(cell) {
  const trimmed = String(cell).trim()
  if (trimmed === "—" || trimmed === "-" || trimmed === "") return undefined
  const match = trimmed.match(CONTEXT_TOKEN_RE)
  if (!match) {
    throw new Error(
      `could not parse context cell "${trimmed}": unknown token (pinned decimal table K×1000, M×1000000)`,
    )
  }
  const whole = Number(match[1])
  const fracDigits = match[2] ?? ""
  const frac = fracDigits.length > 0 ? Number(`0.${fracDigits}`) : 0
  const scale = match[3] === "K" ? 1000 : 1000000
  const value = Math.round((whole + frac) * scale)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`could not parse context cell "${trimmed}": non-positive value`)
  }
  return value
}

// A missing price cell — "—" (or an empty cell). The parser distinguishes
// this from an unparseable cell: missing may engage the cost fallback
// ladder (issue #132), unparseable is a loud shape failure.
const PRICE_CELL_RE = /^\$([0-9.]+)\/\$([0-9.]+) · cache \$([0-9.]+)(?: \(write \$([0-9.]+)\))?$/

/**
 * Parses a "$in/$out · cache $read (write $write)" price cell.
 * Returns undefined for a missing cell ("—" or empty). Throws for any
 * other value — a price shape change must fail loudly (never a silent
 * zero-fill: a zero rate means explicitly free, nothing else).
 */
export function parsePriceCell(cell) {
  const trimmed = String(cell).trim()
  if (trimmed === "—" || trimmed === "-" || trimmed === "") return undefined
  const match = trimmed.match(PRICE_CELL_RE)
  if (!match) {
    throw new Error(
      `could not parse price cell "${trimmed}": unparseable (missing cells must use "—")`,
    )
  }
  const input = Number(match[1])
  const output = Number(match[2])
  const cacheRead = Number(match[3])
  const cacheWrite = match[4] === undefined ? 0 : Number(match[4])
  if (![input, output, cacheRead, cacheWrite].every(Number.isFinite)) {
    throw new Error(`could not parse price cell "${trimmed}": non-finite rate`)
  }
  return { input, output, cacheRead, cacheWrite }
}

const EFFORTS_MISSING = new Set(["—", "-", ""])

function parseEffortsCell(cell) {
  const trimmed = String(cell).trim()
  if (EFFORTS_MISSING.has(trimmed)) return undefined
  return trimmed.split(",").map((level) => level.trim())
}

/**
 * Parses a single models.md row into a Snapshot row. A row that doesn't
 * start with a backticked id is not a model row (header/separator/etc).
 * Row cells (after the leading id):
 *   0 Name | 1 Context | 2 Efforts | 3 Price | 4 Min plan | 5 Best for
 */
function parseRow(trimmed) {
  const cells = trimmed
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim())
  if (cells.length < 6) {
    throw new Error(`could not parse row: ${trimmed}`)
  }
  const id = cells[0].replace(/^`|`$/g, "")
  if (!id || id.length === 0) {
    throw new Error(`could not parse row: ${trimmed}`)
  }
  const name = cells[1]
  if (!name || name.length === 0) {
    throw new Error(`could not parse row for ${id}: empty name cell`)
  }
  const contextLength = parseContextCell(cells[2])
  const efforts = parseEffortsCell(cells[3])
  const cost = parsePriceCell(cells[4])
  return { id, name, contextLength, efforts, cost }
}

/**
 * Parses the models.md table into Snapshot membership rows. Every row in
 * the table is a member (the package table is the sole membership
 * authority — issue #130); missing ship-bar cells surface as
 * `contextLength: undefined` / `cost: undefined` signals, unparseable
 * cells fail loudly.
 *
 * @returns {{ rows: Array<{id:string,name:string,contextLength:number|undefined,efforts:string[]|undefined,cost:({input:number,output:number,cacheRead:number,cacheWrite:number}|undefined)}> }}
 */
export function parseCatalogMarkdown(markdown) {
  const rows = []
  const lines = markdown.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed.startsWith("| ")) continue
    if (isSeparatorRow(trimmed)) continue
    if (trimmed.startsWith("| `")) {
      rows.push(parseRow(trimmed))
      continue
    }
    if (isSeparatorRow((lines[i + 1] ?? "").trim())) continue
    throw new Error(`could not parse row: ${trimmed}`)
  }
  return { rows }
}

function isSeparatorRow(trimmed) {
  return /^\|\s*:?-+:?\s*\|/.test(trimmed)
}

/**
 * Backward-compatible models.md facts parser (efforts + flat costs maps).
 * Kept for the pre-#130 consumers/tests; the refresh now consumes
 * parseCatalogMarkdown and derives the maps itself.
 *
 * Missing context/price cells parse to `undefined` (a valid row signal);
 * an unknown context token or an unparseable price cell still fails
 * loudly. Rows whose id is empty still fail.
 */
export function parseFactsMarkdown(markdown) {
  const { rows } = parseCatalogMarkdown(markdown)
  const efforts = {}
  const costs = {}
  for (const row of rows) {
    if (row.efforts !== undefined && row.efforts.length > 0) efforts[row.id] = row.efforts
    if (row.cost !== undefined) costs[row.id] = row.cost
  }
  return { efforts, costs }
}
