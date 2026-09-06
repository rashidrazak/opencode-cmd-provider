// scripts/parse-models-page.mjs — the Command Code models page index parser
// (issue #131). The models page (`https://commandcode.ai/models`) is an
// **enrichment source** since the models.md-primary flip (issue #130): it
// never decides Snapshot membership and never wins a ship-bar field. Its
// outputs are:
//
//   - per-row display rates (Input/Output/Cache read/Cache write) — the
//     cost ladder may consult these when models.md's price cell is missing
//     (issue #132);
//   - the coarse Context string (display-level, e.g. "1M", "1.1M", "262K");
//     the Snapshot's precise decimal parse is models.md's job (#130);
//   - the Caps capability bits (Text input / Vision / Reasoning) — feed the
//     reasoning any-true-wins derivation and the modalities fallback ladder
//     (issue #132);
//   - the per-row slug list, joined to Snapshot membership via the pinned
//     slug-to-id map below (date-suffixed and vendor-prefixed ids resolve;
//     an unmapped slug fails loudly — a shape change needs parser work).
//
// Rate-cell footnote markers (the `+N` context-price-band buttons) strip at
// parse time; their presence emits a banded-pricing verification note routed
// through the existing peak/off-peak and over-context fields (no second band
// parser is built — the bands stay in the RSC path, issue #129).
//
// Cell grammar (verified against the live page 2026-09-05):
//   - header: Model | Context | Intelligence | Tok/s | Input | Output |
//     Cache read | Cache write | Caps
//   - name cell: `<a href="/models/<slug>">Name</a>` — extract the clean
//     display name from the link text ONLY (discount badges, off-peak
//     notes and deal markers live in sibling elements of the cell and are
//     not part of the model's name);
//   - context cell: bare text like `1M`, `1.1M`, `262K`, `256K`, `200K`,
//     `400K`, `500K` (no "—" on the live page today);
//   - price cells: `$1.50`, `Free`, `—` (cache-write often —), a struck
//     list-price + new price for deals (`<s>$0.60</s>$0.30`), and an
//     optional band button `+N` whose `aria-label` is
//     `<Name>: N context price bands`;
//   - caps cell: a button with `aria-label="Capabilities: …"` listing the
//     capability tokens. The four known combinations are exactly the
//     present/absent subsets of {Text input, Vision, Reasoning}; a fifth
//     token fails loudly (shape-pinned).

// The four known Caps label tokens. Shape-pinned: an upstream fifth label
// (e.g. "Audio input" or "Video") must be a loud failure, never a silently
// ignored capability.
const KNOWN_CAPS = new Set(["Text input", "Vision", "Reasoning"])

/** Parses a "Capabilities: Text input, Vision, Reasoning" aria-label. */
export function parseCapsLabel(label) {
  const trimmed = String(label).trim()
  const prefix = "Capabilities: "
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`could not parse caps cell: expected "Capabilities: …", got "${trimmed}"`)
  }
  const tokens = trimmed
    .slice(prefix.length)
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  if (tokens.length === 0) {
    throw new Error(
      `could not parse caps cell: no capability tokens in "${label}" (shape-pinned to {Text input, Vision, Reasoning})`,
    )
  }
  for (const token of tokens) {
    if (!KNOWN_CAPS.has(token)) {
      throw new Error(
        `could not parse caps cell: unknown capability "${token}" (shape-pinned to {Text input, Vision, Reasoning})`,
      )
    }
  }
  const has = (token) => tokens.includes(token)
  return { text: has("Text input"), vision: has("Vision"), reasoning: has("Reasoning") }
}

/**
 * Strips a rate cell into { price, crossed }. `banded` is decided by the
 * caller via the presence of a `context price bands` aria-label. The
 * struck list price (`<s>$0.60</s>`) is returned as `crossed` so callers
 * can emit a deal note; the new price is `price`.
 */
export function parseRateCell(cell) {
  const trimmed = String(cell).trim()
  // A missing cell ("—", possibly wrapped in a muted span) is null.
  const textOnly = cleanText(trimmed)
  if (textOnly === "—" || textOnly === "-" || textOnly === "") {
    return { price: null, crossed: null }
  }
  if (/^free$/i.test(textOnly)) return { price: 0, crossed: null }
  const struck = trimmed.match(/<s[^>]*>([\s\S]*?)<\/s>/i)
  const crossed = struck ? cleanText(struck[1]) : null
  const withoutStruck = trimmed.replace(/<s[^>]*>[\s\S]*?<\/s>/i, "")
  const text = cleanText(withoutStruck)
  const match = text.match(/^\$([0-9.]+)(?:\s*\+\s*\d+)?$/)
  if (!match) {
    throw new Error(`could not parse rate cell "${trimmed}"`)
  }
  return { price: Number(match[1]), crossed }
}

const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
const CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
const NAME_LINK_RE = /<a [^>]*href="\/(?:models|model)\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i
const SLUG_RE = /href="\/(?:models|model)\/([^"]+)"/

function cleanText(cell) {
  return cell
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Parses the models page index table.
 *
 * @param {string} html
 * @returns {{ rows: Array<{name: string, slug: string, context: string|null, caps: {text: boolean, vision: boolean, reasoning: boolean}, rates: {input: number|null, output: number|null, cacheRead: number|null, cacheWrite: number|null}, banded: boolean, offPeak: boolean, crossed: {input: string|null, output: string|null}}>, notes: string[] }}
 *   `context` is the raw coarse Context string (null for "—"); `banded`
 *   is true when any price cell carried a context-price-band footnote
 *   marker; `offPeak` is true when the name cell carried an off-peak
 *   footnote marker; `notes` carries one verification note per footnoted
 *   row (banded and/or off-peak).
 */
export function parseModelsPage(html) {
  const table = html.match(/<table[^>]*>[\s\S]*?<\/table>/i)
  if (!table) throw new Error("could not parse models page: no table found")
  const rows = []
  const notes = []
  let seenHeader = false
  for (const rowMatch of table[0].matchAll(ROW_RE)) {
    const cells = [...rowMatch[1].matchAll(CELL_RE)].map((c) => c[1])
    const nameCell = cells[0] ?? ""
    const href = nameCell.match(SLUG_RE)
    // The header row has no model link; every other row must.
    if (!href) {
      if (!seenHeader) {
        seenHeader = true
        continue
      }
      // A body row with no model link (or an over-short row) is a shape
      // change — loud, never a silent drop.
      throw new Error(
        `could not parse models page: a row after the header has no model link (${cleanText(nameCell).slice(0, 60) || "<empty name cell>"})`,
      )
    }
    if (cells.length < 9) {
      throw new Error(
        `could not parse models page: row for "${cleanText(nameCell).slice(0, 60)}" has ${cells.length} cells, expected 9`,
      )
    }
    const slug = href[1]
    const link = nameCell.match(NAME_LINK_RE)
    const name = link ? cleanText(link[1]) : cleanText(nameCell)
    const contextRaw = cleanText(cells[1])
    const context = contextRaw === "—" || contextRaw === "-" ? null : contextRaw
    const capsLabel = cells[8].match(/aria-label="([^"]+)"/)?.[1]
    if (!capsLabel) {
      throw new Error(`could not parse models page: row ${name} has no caps aria-label`)
    }
    const caps = parseCapsLabel(capsLabel)
    const rates = { input: null, output: null, cacheRead: null, cacheWrite: null }
    const crossed = { input: null, output: null }
    let banded = false
    const COLUMNS = [
      [4, "input"],
      [5, "output"],
      [6, "cacheRead"],
      [7, "cacheWrite"],
    ]
    for (const [index, key] of COLUMNS) {
      const parsed = parseRateCell(cells[index])
      rates[key] = parsed.price
      if (key === "input") crossed.input = parsed.crossed
      if (key === "output") crossed.output = parsed.crossed
      if (/context price bands/.test(cells[index])) banded = true
    }
    if (banded) {
      const bandLabel =
        cells[4].match(/aria-label="([^"]*context price bands)"/)?.[1] ??
        cells[5].match(/aria-label="([^"]*context price bands)"/)?.[1] ??
        cells[6].match(/aria-label="([^"]*context price bands)"/)?.[1] ??
        cells[7].match(/aria-label="([^"]*context price bands)"/)?.[1]
      notes.push(
        `models-page: ${name} — banded pricing (${bandLabel ?? "footnote marker"}); base rate shipped, verify against RSC peak/off-peak and over-context fields`,
      )
    }
    // Peak/off-peak footnote marker (the DeepSeek V4 family live shape):
    // a name-cell button whose aria-label says the shown rate is the
    // off-peak rate. The footnote's presence is the marker — the actual
    // peak/off-peak fields live in the RSC records, so this emits a
    // verify-against-RSC note (no second band parser, issue #129).
    const offPeakNote = nameCell.match(/aria-label="(Off-peak[^"]+)"/)?.[1]
    if (offPeakNote) {
      notes.push(
        `models-page: ${name} — ${offPeakNote}; the shipped base rate is the off-peak rate, verify against RSC peak/off-peak fields`,
      )
    }
    rows.push({
      name,
      slug,
      context,
      caps,
      rates,
      banded,
      crossed,
      offPeak: offPeakNote !== undefined,
    })
  }
  if (rows.length === 0) {
    throw new Error("could not parse models page: no model rows found")
  }
  return { rows, notes }
}

/**
 * Pinned slug → Snapshot id join map (issue #131). The models page emits
 * hyphenated page slugs (`muse-spark-1-3`, `glm-5-3-flash`,
 * `qwen3-8-max-0902`) that don't match the Snapshot's vendor-prefixed or
 * date-suffixed ids (`meta/muse-spark-1.3`, `z-ai/glm-5.3-flash`,
 * `Qwen/Qwen3.8-Max-0902`). Keys are the page slugs (verified against the
 * live page 2026-09-05); values are the Snapshot ids. Every slug is listed
 * — identity slugs (page form == Snapshot id) included — so the map is
 * TOTAL and an unmapped slug fails loudly: a new page slug needs an entry
 * here (a shape change, never a silent drop).
 *
 * Date-suffixed/vendor-prefixed examples handled here:
 *   - `claude-haiku-4-5` → `claude-haiku-4-5-20251001` (date suffix);
 *   - `qwen3-8-max-0902` → `Qwen/Qwen3.8-Max-0902` (vendor prefix + date);
 *   - `tencent-hy3`      → `tencent/hy3-paid` (vendor prefix + paid);
 *   - `longcat-2-0-free` → `meituan/LongCat-2.0:free` (vendor + free suffix);
 *   - `minimax-m3`       → `MiniMaxAI/MiniMax-M3` (vendor prefix).
 */
export const SLUG_TO_SNAPSHOT_ID = {
  // Identity slugs (the page slug already equals the Snapshot id). Listed
  // explicitly so the map is TOTAL: an unmapped slug always fails loudly.
  "gpt-6-astra": "gpt-6-astra",
  "claude-fable-5-1": "claude-fable-5-1",
  "claude-fable-5": "claude-fable-5",
  "claude-opus-5": "claude-opus-5",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-sonnet-5": "claude-sonnet-5",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "deepseek-v4-flash-fast": "deepseek/deepseek-v4-flash-fast",
  "deepseek-v4-flash-vision-exp": "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "fugu-ultra": "sakana/fugu-ultra",
  "gemini-3-1-flash-lite": "google/gemini-3.1-flash-lite",
  "gemini-3-5-flash": "google/gemini-3.5-flash",
  "gemini-3-5-flash-lite": "google/gemini-3.5-flash-lite",
  "gemini-3-6-flash": "google/gemini-3.6-flash",
  "gemini-3-7-flash": "google/gemini-3.7-flash",
  "gemini-3-8-flash": "google/gemini-3.8-flash",
  "glm-5": "zai-org/GLM-5",
  "glm-5-1": "zai-org/GLM-5.1",
  "glm-5-2": "zai-org/GLM-5.2",
  "glm-5-2-fast": "zai-org/GLM-5.2-Fast",
  "glm-5-3": "zai-org/GLM-5.3",
  "glm-5-3-flash": "z-ai/glm-5.3-flash",
  "gpt-5-3-codex": "gpt-5.3-codex",
  "gpt-5-4": "gpt-5.4",
  "gpt-5-4-mini": "gpt-5.4-mini",
  "gpt-5-5": "gpt-5.5",
  "gpt-5-6-luna": "gpt-5.6-luna",
  "gpt-5-6-sol": "gpt-5.6-sol",
  "gpt-5-6-terra": "gpt-5.6-terra",
  "grok-4-5": "xai/grok-4.5",
  "grok-4-6": "xai/grok-4.6",
  "hy4-preview": "tencent/hy4-preview",
  inkling: "thinkingmachines/inkling",
  "inkling-small": "thinkingmachines/inkling-small",
  "kimi-k2-5": "moonshotai/Kimi-K2.5",
  "kimi-k2-6": "moonshotai/Kimi-K2.6",
  "kimi-k2-7-code": "moonshotai/Kimi-K2.7-Code",
  "kimi-k2-7-code-highspeed": "moonshotai/Kimi-K2.7-Code-Highspeed",
  "kimi-k3": "moonshotai/Kimi-K3",
  "laguna-s-2-1-free": "poolside/laguna-s-2.1-free",
  "longcat-2-0-free": "meituan/LongCat-2.0:free",
  "mimo-v2-5": "xiaomi/mimo-v2.5",
  "mimo-v2-5-pro": "xiaomi/mimo-v2.5-pro",
  "minimax-m2-5": "MiniMaxAI/MiniMax-M2.5",
  "minimax-m2-7": "MiniMaxAI/MiniMax-M2.7",
  "minimax-m3": "MiniMaxAI/MiniMax-M3",
  "muse-spark-1-1": "meta/muse-spark-1.1",
  "muse-spark-1-2": "meta/muse-spark-1.2",
  "muse-spark-1-2-contributor": "meta/muse-spark-1.2-contributor",
  "muse-spark-1-3": "meta/muse-spark-1.3",
  "muse-spark-1-3-contributor": "meta/muse-spark-1.3-contributor",
  "nemotron-3-ultra-550b-a55b": "nvidia/nemotron-3-ultra-550b-a55b",
  "qwen3-6-max-preview": "Qwen/Qwen3.6-Max-Preview",
  "qwen3-6-plus": "Qwen/Qwen3.6-Plus",
  "qwen3-7-flash": "Qwen/Qwen3.7-Flash",
  "qwen3-7-max": "Qwen/Qwen3.7-Max",
  "qwen3-7-plus": "Qwen/Qwen3.7-Plus",
  "qwen3-8-27b": "Qwen/Qwen3.8-27B",
  "qwen3-8-flash": "Qwen/Qwen3.8-Flash",
  "qwen3-8-max": "Qwen/Qwen3.8-Max",
  "qwen3-8-max-0902": "Qwen/Qwen3.8-Max-0902",
  "step-3-5-flash": "stepfun/Step-3.5-Flash",
  "step-3-7-flash": "stepfun/Step-3.7-Flash",
  "tencent-hy3": "tencent/hy3-paid",
}

/**
 * Resolves a models-page slug to a Snapshot id. The map is TOTAL (every
 * known slug, identity and vendor-prefixed alike, has an entry), so an
 * unmapped slug fails loudly — a new models-page slug is a shape change
 * that needs a map entry, never a silent drop.
 *
 * @param {string} slug
 * @returns {string} the Snapshot id
 */
export function slugToSnapshotId(slug) {
  // Own-key check: a plain-object truthy lookup would let `"constructor"`
  // or `"toString"` resolve to an inherited function, silently bypassing
  // the TOTAL-map contract.
  if (Object.prototype.hasOwnProperty.call(SLUG_TO_SNAPSHOT_ID, slug)) {
    return SLUG_TO_SNAPSHOT_ID[slug]
  }
  throw new Error(
    `could not resolve models-page slug "${String(slug)}": unmapped (add a SLUG_TO_SNAPSHOT_ID entry or pin the shape)`,
  )
}

// ---------------------------------------------------------------------------
// Model detail page parser (issue #132 — the cost ladder's third step). The
// detail page (`https://commandcode.ai/models/<slug>`) is live-fetch-only:
// never pinned as a fixture (issue #129 decision), parsed purely when the
// cost ladder needs it. The page renders a 2×2 pricing grid whose rows are
// self-contained `border-b border-border/60` divs:
//
//   <div class="border-b ..."><div class="... uppercase ...">Input<button
//     type="button" aria-label="Input — Price per 1M input (prompt)
//     tokens." ...>i</button></div>
//   <div class="mt-1 text-[21px] font-semibold tabular-nums">$2.50<!-- -->
//     <span ...>/M</span></div></div>
//
// Verified live 2026-09-05 against /models/gpt-5-4 and /models/gpt-6-astra:
// every label's price cell is the `/M` $n cell in the SAME row div, and
// **Cache write is never a row on real detail pages** (those models carry
// only Input/Output/Cache read; the index's per-row `cacheWrite` often
// renders as "—"). So the parser reads Input/Output/Cache read and leaves
// cacheWrite null-unless-present.
//
// Degradation contract (the refresh cost ladder consumes this): a page with
// NO parseable pricing rows yields all-null (a detail page that did not
// render a price table — the ladder moves to the RSC step). A page whose
// pricing grid has SOME rows but a *malformed* cell (a label whose row has
// no `$n /M` cell) is a loud shape failure — the cost ladder must never
// guess a price from a half-parsed page.
// ---------------------------------------------------------------------------

const DETAIL_ROW_RE =
  /<div class="border-b border-border\/60 px-5 py-\[18px\][\s\S]*?<\/div><\/div>/g

const DETAIL_LABEL_RE =
  /uppercase text-muted-foreground">(Input|Output|Cache read|Cache write)<button/
const DETAIL_PRICE_RE = /text-\[21px\] font-semibold tabular-nums">\$([0-9.]+)/

/**
 * Parses the pricing grid of a model detail page into per-1M rates.
 * Pure: no network, no file I/O.
 *
 * - A rate the page does not render (cache write is nearly always absent)
 *   parses to null.
 * - A page with NO pricing rows yields all-null — the caller treats that
 *   as "the detail page carries no price table" and walks on.
 * - A page whose grid has at least one row where a label lacks its `$n /M`
 *   cell is a loud shape failure (throws, naming the label) — never a
 *   silently guessed price.
 *
 * @param {string} html the detail page HTML
 * @returns {{ input: number|null, output: number|null, cacheRead: number|null, cacheWrite: number|null }}
 */
export function parseModelDetailRates(html) {
  const out = { input: null, output: null, cacheRead: null, cacheWrite: null }
  // Isolate each pricing row div, then read its own label + price cell.
  // A row div that does not carry one of the four labels is unrelated
  // content (benchmark tiles etc) and is skipped.
  let sawPricingRow = false
  for (const rowMatch of html.matchAll(DETAIL_ROW_RE)) {
    const row = rowMatch[0]
    const labelMatch = row.match(DETAIL_LABEL_RE)
    if (!labelMatch) continue
    sawPricingRow = true
    const label = labelMatch[1]
    const priceMatch = row.match(DETAIL_PRICE_RE)
    if (!priceMatch) {
      throw new Error(
        `could not parse model detail rates: "${label}" row present without a price cell`,
      )
    }
    const value = Number(priceMatch[1])
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`could not parse model detail rates: non-numeric "${label}" price`)
    }
    out[
      label === "Input"
        ? "input"
        : label === "Output"
          ? "output"
          : label === "Cache read"
            ? "cacheRead"
            : "cacheWrite"
    ] = value
  }
  // A page that has pricing rows but no Input row is a shape change too
  // (the Input row is the one stable row across every real model).
  if (sawPricingRow && out.input === null) {
    throw new Error("could not parse model detail rates: no Input row found")
  }
  return out
}
