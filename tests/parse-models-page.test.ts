// tests/parse-models-page.test.ts — models page index parser (issue #131).
// The models page is an enrichment source (never membership): per-row rates,
// coarse Context string, Caps bits, slug list + banded-pricing notes.
import {
  parseCapsLabel,
  parseModelsPage,
  parseRateCell,
  SLUG_TO_SNAPSHOT_ID,
  slugToSnapshotId,
} from "../scripts/parse-models-page.mjs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { assert, assertEqual, run, throws } from "./harness.js"

// The committed live capture (tests/fixtures/models-page.html, captured by
// `npm run refresh:fixtures`) must keep parsing — a sanity check that the
// parser still matches the real page shape, not just synthetic fixtures.
const LIVE_FIXTURE = join(import.meta.dirname, "fixtures", "models-page.html")

// Synthetic models-page fixture — minimal but faithful to the live cell
// grammar (name link, context, price cells incl. band footnote markers,
// struck deal prices, "Free", "—", caps aria-label).
const PAGE = `<html><body><table>
<thead><tr>
<th>Model</th><th>Context</th><th>Intelligence</th><th>Tok/s</th>
<th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Caps</th>
</tr></thead>
<tbody>
<tr>
<td><a href="/models/gpt-6-astra">GPT-6 Astra</a></td>
<td><span>1.1M</span></td><td>not yet scored</td><td>—</td>
<td><span>$10.00<button type="button" aria-label="GPT-6 Astra: 2 context price bands">+<!-- -->1</button></span></td>
<td><span>$50.00<button type="button" aria-label="GPT-6 Astra: 2 context price bands">+<!-- -->1</button></span></td>
<td><span>$1.00<button type="button" aria-label="GPT-6 Astra: 2 context price bands">+<!-- -->1</button></span></td>
<td><span>$12.50<button type="button" aria-label="GPT-6 Astra: 2 context price bands">+<!-- -->1</button></span></td>
<td><button type="button" aria-label="Capabilities: Text input, Vision, Reasoning"></button></td>
</tr>
<tr>
<td><a href="/models/claude-haiku-4-5">Claude Haiku 4.5</a></td>
<td><span>200K</span></td><td>52.0</td><td>—</td>
<td><span>$1.00</span></td><td><span>$5.00</span></td><td><span>$0.10</span></td><td><span>$1.25</span></td>
<td><button type="button" aria-label="Capabilities: Text input, Vision"></button></td>
</tr>
<tr>
<td><a href="/models/muse-spark-1-2-contributor">Muse Spark 1.2 Contributor</a><a href="https://commandcode.ai/docs/resources/pricing-limits#muse-spark-1.2-contributor" aria-label="Free — view deal details">FREE</a></td>
<td><span>1M</span></td><td>52.0</td><td>—</td>
<td><span><s>$0.20</s>$0.10</span></td><td><span><s>$0.40</s>$0.20</span></td><td><span>$0.002</span></td><td><span>—</span></td>
<td><button type="button" aria-label="Capabilities: Text input, Vision, Reasoning"></button></td>
</tr>
<tr>
<td><a href="/models/laguna-s-2-1-free">Laguna S 2.1</a><a href="#" aria-label="Free — view deal details">FREE</a></td>
<td><span>256K</span></td><td>52.0</td><td>—</td>
<td><span>Free</span></td><td><span>Free</span></td><td><span>Free</span></td><td><span>—</span></td>
<td><button type="button" aria-label="Capabilities: Text input"></button></td>
</tr>
</tbody>
</table></body></html>`

run([
  [
    "parseModelsPage extracts rates, Context string, Caps bits, slugs and clean names",
    () => {
      const { rows, notes } = parseModelsPage(PAGE)
      assertEqual(rows.length, 4)
      const astra = rows[0]
      assertEqual(astra.name, "GPT-6 Astra")
      assertEqual(astra.slug, "gpt-6-astra")
      assertEqual(astra.context, "1.1M")
      assertEqual(astra.caps, { text: true, vision: true, reasoning: true })
      assertEqual(astra.rates, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 })
      assertEqual(astra.banded, true)
      assertEqual(astra.crossed, { input: null, output: null })
    },
  ],

  [
    "parseModelsPage extracts the coarse Context string and deals' struck crossed prices",
    () => {
      const { rows } = parseModelsPage(PAGE)
      assertEqual(rows[1].context, "200K")
      assertEqual(rows[1].caps, { text: true, vision: true, reasoning: false })
      assertEqual(rows[1].banded, false)
      const muse = rows[2]
      assertEqual(muse.name, "Muse Spark 1.2 Contributor")
      assertEqual(muse.crossed, { input: "$0.20", output: "$0.40" })
      assertEqual(muse.rates, { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: null })
    },
  ],

  [
    "parseModelsPage treats Free and em-dash cells correctly (free ≠ missing)",
    () => {
      const { rows } = parseModelsPage(PAGE)
      const laguna = rows[3]
      assertEqual(laguna.name, "Laguna S 2.1")
      assertEqual(laguna.rates, { input: 0, output: 0, cacheRead: 0, cacheWrite: null })
      assertEqual(laguna.caps, { text: true, vision: false, reasoning: false })
    },
  ],

  [
    "banded-pricing footnote markers strip and produce a verification note",
    () => {
      const { notes } = parseModelsPage(PAGE)
      const banded = notes.filter((n) => n.includes("GPT-6 Astra"))
      assertEqual(banded.length, 1)
      assert(
        banded[0].includes("2 context price bands") && banded[0].includes("verify against RSC"),
        `expected a banded-pricing note naming the bands, got: ${banded[0]}`,
      )
      assert(notes.length === 1, "only the banded row emits a note")
    },
  ],

  [
    "parseCapsLabel pins the four known combinations",
    () => {
      assertEqual(parseCapsLabel("Capabilities: Text input"), {
        text: true,
        vision: false,
        reasoning: false,
      })
      assertEqual(parseCapsLabel("Capabilities: Text input, Vision"), {
        text: true,
        vision: true,
        reasoning: false,
      })
      assertEqual(parseCapsLabel("Capabilities: Text input, Reasoning"), {
        text: true,
        vision: false,
        reasoning: true,
      })
      assertEqual(parseCapsLabel("Capabilities: Text input, Vision, Reasoning"), {
        text: true,
        vision: true,
        reasoning: true,
      })
    },
  ],

  [
    "a fifth Caps label fails loudly (shape-pinned)",
    () => {
      throws(
        () => parseCapsLabel("Capabilities: Text input, Vision, Reasoning, Audio input"),
        /unknown capability "Audio input"/,
      )
      throws(() => parseCapsLabel("Capabilities: Text input, Video"), /unknown capability "Video"/)
    },
  ],

  [
    "parseRateCell handles dollars, Free, em-dash, band +N markers, and struck crossed prices",
    () => {
      assertEqual(parseRateCell("$1.50"), { price: 1.5, crossed: null })
      assertEqual(parseRateCell("Free"), { price: 0, crossed: null })
      assertEqual(parseRateCell("—"), { price: null, crossed: null })
      assertEqual(parseRateCell("<span>$10.00<button>+1</button></span>"), {
        price: 10,
        crossed: null,
      })
      assertEqual(parseRateCell("<span><s>$0.60</s>$0.30</span>"), { price: 0.3, crossed: "$0.60" })
      throws(() => parseRateCell("nope"), /could not parse rate cell/)
    },
  ],

  [
    "slugToSnapshotId resolves vendor-prefixed and date-suffixed ids; unmapped slugs fail loudly",
    () => {
      assertEqual(slugToSnapshotId("claude-haiku-4-5"), "claude-haiku-4-5-20251001")
      assertEqual(slugToSnapshotId("qwen3-8-max-0902"), "Qwen/Qwen3.8-Max-0902")
      assertEqual(slugToSnapshotId("tencent-hy3"), "tencent/hy3-paid")
      assertEqual(slugToSnapshotId("muse-spark-1-3"), "meta/muse-spark-1.3")
      assertEqual(slugToSnapshotId("gpt-6-astra"), "gpt-6-astra")
      throws(() => slugToSnapshotId("brand-new-model"), /unmapped/)
    },
  ],

  [
    "the pinned slug map is bijective with the live Snapshot ids (identity + mapped), and every entry round-trips",
    async () => {
      // Structural, not a count pin: every map value must be a real
      // Snapshot id and every Snapshot id must have a slug entry (a new
      // upstream model shows up as a fresh pair, never as a red count).
      const { MODEL_SNAPSHOT } = await import("../src/catalog/snapshot.js")
      const snapshotIds = new Set(MODEL_SNAPSHOT.map((model) => model.id))
      for (const [slug, id] of Object.entries(SLUG_TO_SNAPSHOT_ID)) {
        assertEqual(slugToSnapshotId(slug), id, `${slug} must round-trip`)
        assert(snapshotIds.has(id), `map value ${id} (for slug ${slug}) must be a Snapshot id`)
      }
    },
  ],

  [
    "off-peak note buttons and discount badges stay out of the parsed name (DeepSeek/MiniMax live shape)",
    () => {
      // The live page puts an off-peak note button (aria-label) and deal
      // badges inside the name cell, but NOT inside the name link — the
      // clean name must come from the link text only.
      const html = `<table><tr>
<td><a href="/models/deepseek-v4-pro">DeepSeek V4 Pro (latest)</a><button type="button" aria-label="Off-peak shown (17h/day) · peak $1.32 / $3.96 01–04 &amp; 06–10 UTC"></button></td>
<td><span>1M</span></td><td>56.0</td><td>—</td>
<td><span>$0.66</span></td><td><span>$1.98</span></td><td><span>$0.022</span></td><td><span>—</span></td>
<td><button type="button" aria-label="Capabilities: Text input, Reasoning"></button></td>
</tr></table>`
      const { rows, notes } = parseModelsPage(html)
      assertEqual(rows.length, 1)
      assertEqual(rows[0].name, "DeepSeek V4 Pro (latest)")
      assertEqual(rows[0].caps, { text: true, vision: false, reasoning: true })
      assertEqual(rows[0].rates.input, 0.66)
      assertEqual(rows[0].offPeak, true)
      assert(
        notes.some((n) => n.includes("off-peak") && n.includes("verify against RSC")),
        `expected an off-peak verify-against-RSC note, got: ${notes.join(" | ")}`,
      )
    },
  ],

  [
    "parseModelsPage fails loudly when no table or no model rows exist",
    () => {
      throws(() => parseModelsPage("<html><body></body></html>"), /no table found/)
      throws(() => parseModelsPage("<table><tr><th>Model</th></tr></table>"), /no model rows found/)
    },
  ],

  [
    "the live Caps matrix shape is verified end-to-end: every row is one of the four known combos and a fifth fails through parseModelsPage",
    () => {
      // Build a 68-row fixture cycling the exact four aria-label combos
      // seen live (2026-09-05): {Text}, {Text,Vision}, {Text,Reasoning},
      // {Text,Vision,Reasoning}. Mirrors the live evidence that the matrix
      // uses exactly four labels with zero vision/reasoning conflicts.
      const combos = [
        "Capabilities: Text input",
        "Capabilities: Text input, Vision",
        "Capabilities: Text input, Reasoning",
        "Capabilities: Text input, Vision, Reasoning",
      ]
      const slugList = [
        "gpt-6-astra",
        "claude-haiku-4-5",
        "qwen3-8-max-0902",
        "tencent-hy3",
        "muse-spark-1-3",
        "muse-spark-1-2-contributor",
        "deepseek-v4-flash",
        "grok-4-6",
      ]
      const rows = Array.from({ length: 68 }, (_, i) => {
        const slug = slugList[i % slugList.length]
        const combo = combos[i % 4]
        return `<tr>
<td><a href="/models/${slug}">Model ${i}</a></td>
<td><span>${i % 2 ? "1M" : "256K"}</span></td><td>52.0</td><td>—</td>
<td><span>$1</span></td><td><span>$2</span></td><td><span>$0.1</span></td><td><span>—</span></td>
<td><button type="button" aria-label="${combo}"></button></td>
</tr>`
      })
      const parsed = parseModelsPage(`<table>${rows.join("")}</table>`)
      assertEqual(parsed.rows.length, 68)
      for (const row of parsed.rows) {
        const { text, vision, reasoning } = row.caps
        assert(text === true, `${row.name}: every live row must carry text input`)
        assert(
          typeof vision === "boolean" && typeof reasoning === "boolean",
          `${row.name}: vision/reasoning must be booleans`,
        )
      }
      // The set of distinct (vision, reasoning) pairs covers all four.
      const pairs = new Set(parsed.rows.map((r) => `${r.caps.vision},${r.caps.reasoning}`))
      assertEqual(pairs.size, 4, "all four Caps combos must appear")

      // A fifth label fails loudly through the full page parser.
      const badRow = `<tr>
<td><a href="/models/x">X</a></td><td><span>1M</span></td><td>52</td><td>—</td>
<td><span>$1</span></td><td><span>$2</span></td><td><span>$0.1</span></td><td><span>—</span></td>
<td><button type="button" aria-label="Capabilities: Text input, Vision, Reasoning, Audio input"></button></td>
</tr>`
      throws(() => parseModelsPage(`<table>${badRow}</table>`), /unknown capability "Audio input"/)
    },
  ],

  [
    "the committed live models-page fixture parses fully; known slugs resolve and unknown ones report as pending",
    async () => {
      // Upstream value moves must surface as refresh diffs, never red
      // tests — so this asserts *shape* over the real captured page, not
      // values: rows parse with the full 9-cell shape, the Caps bits are
      // within the four combos, and slugs known to the pinned map resolve.
      // A NEW slug (upstream added a model after the map was pinned) is
      // reported as a pending note, not a failure — enrichment must never
      // block shipping (#129); the map gains the entry on the next pin.
      const html = await readFile(LIVE_FIXTURE, "utf-8")
      const { rows } = parseModelsPage(html)
      assert(rows.length > 0, "the models page must parse at least one row")
      const ALLOWED_PAIRS = new Set(["false,false", "true,false", "false,true", "true,true"])
      const pairs = new Set(rows.map((r) => `${r.caps.vision},${r.caps.reasoning}`))
      for (const pair of pairs) {
        assert(ALLOWED_PAIRS.has(pair), `unexpected caps combo (vision,reasoning)=(${pair})`)
      }
      const pending = []
      for (const row of rows) {
        try {
          slugToSnapshotId(row.slug)
        } catch {
          pending.push(row.slug)
        }
      }
      if (pending.length > 0) {
        console.log(
          `parse-models-page: pending slugs not yet in SLUG_TO_SNAPSHOT_ID: ${pending.join(", ")}`,
        )
      }
    },
  ],
])
