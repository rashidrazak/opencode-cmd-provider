// tests/parse-facts.test.ts — models.md facts parser (facts auto-sync design,
// issue #130: models.md-primary Snapshot membership + ship-bar)
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  parseCatalogMarkdown,
  parseContextCell,
  parseFactsMarkdown,
  parsePriceCell,
} from "../scripts/parse-facts.mjs"
import { assert, assertEqual, run, throws } from "./harness.js"

const FIXTURE = join(import.meta.dirname, "fixtures", "models.md")

const A_ROW = (overrides: Record<string, string> = {}) =>
  [
    "| `a/model` | A Model | 1M | low, medium | $1/$2 · cache $0.1 (write $0.2) | Go and above | best |",
    "| `b/model` | B Model | 256K | — | $3/$4 · cache $0.3 | Go and above | best |",
    "| `c/model` | C Model | 1.05M | — | — | Go and above | best |",
  ].join("\n")

run([
  [
    "parses efforts and flat costs from the fixture (pre-#130 compat surface)",
    async () => {
      const md = await readFile(FIXTURE, "utf-8")
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.efforts["claude-sonnet-5"], ["low", "medium", "high", "xhigh", "max"])
      assertEqual(facts.efforts["Qwen/Qwen3.8-Max"], ["low", "medium", "xhigh"])
      assertEqual(facts.efforts["moonshotai/Kimi-K3"], undefined)
      assertEqual(facts.costs["claude-sonnet-5"], {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
      })
      assertEqual(facts.costs["Qwen/Qwen3.8-Max"], {
        input: 2,
        output: 6,
        cacheRead: 0.25,
        cacheWrite: 2.5,
      })
    },
  ],

  [
    "models without a cache-write rate get cacheWrite 0",
    async () => {
      const md = await readFile(FIXTURE, "utf-8")
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.costs["moonshotai/Kimi-K3"], {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 0,
      })
    },
  ],

  [
    "free models parse to all-zero rates",
    async () => {
      const md = await readFile(FIXTURE, "utf-8")
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.costs["poolside/laguna-s-2.1-free"], {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })
    },
  ],

  [
    "fine-grained contributor rates parse exactly (moved from artifact value pins, issue #108 story 8)",
    async () => {
      const md = await readFile(FIXTURE, "utf-8")
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.costs["meta/muse-spark-1.2-contributor"], {
        input: 0.1,
        output: 0.2,
        cacheRead: 0.002,
        cacheWrite: 0,
      })
      assertEqual(facts.costs["meta/muse-spark-1.1"], {
        input: 1.25,
        output: 4.25,
        cacheRead: 0.15,
        cacheWrite: 0,
      })
    },
  ],

  [
    "parseCatalogMarkdown parses id, name, decimal context, efforts, and cost per row",
    () => {
      const { rows } = parseCatalogMarkdown(A_ROW())
      assertEqual(rows, [
        {
          id: "a/model",
          name: "A Model",
          contextLength: 1000000,
          efforts: ["low", "medium"],
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        },
        {
          id: "b/model",
          name: "B Model",
          contextLength: 256000,
          efforts: undefined,
          cost: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 },
        },
        {
          id: "c/model",
          name: "C Model",
          contextLength: 1050000,
          efforts: undefined,
          cost: undefined,
        },
      ])
    },
  ],

  [
    "coarse Context tokens convert deterministically through the pinned decimal table",
    () => {
      // Table pins (issue #129 decision): K × 1000, M × 1000000;
      // 1.05M → 1050000, 1M → 1000000, 262K → 262000, 256K → 256000,
      // 500K → 500000, 400K → 400000, 200K → 200000.
      assertEqual(parseContextCell("1.05M"), 1050000)
      assertEqual(parseContextCell("1M"), 1000000)
      assertEqual(parseContextCell("262K"), 262000)
      assertEqual(parseContextCell("256K"), 256000)
      assertEqual(parseContextCell("500K"), 500000)
      assertEqual(parseContextCell("400K"), 400000)
      assertEqual(parseContextCell("200K"), 200000)
    },
  ],

  [
    "a missing Context cell (em dash) is a signal, not a number — parseContextCell returns undefined",
    () => {
      assertEqual(parseContextCell("—"), undefined)
      assertEqual(parseContextCell("-"), undefined)
      assertEqual(parseContextCell(""), undefined)
      assertEqual(parseContextCell("   "), undefined)
    },
  ],

  [
    "an unknown Context token fails loudly (pinned table — shape change is parser work)",
    () => {
      throws(() => parseContextCell("1.5G"), /could not parse context cell "1\.5G"/)
      throws(() => parseContextCell("1050000"), /could not parse context cell "1050000"/)
      throws(() => parseContextCell("1.05"), /could not parse context cell "1\.05"/)
      throws(() => parseContextCell("M"), /could not parse context cell "M"/)
    },
  ],

  [
    "a missing price cell (em dash) is a signal — cost ladder may engage later; missing never zero-fills",
    () => {
      assertEqual(parsePriceCell("—"), undefined)
      assertEqual(parsePriceCell("-"), undefined)
      assertEqual(parsePriceCell(""), undefined)
      // An explicitly-all-zero cell stays a zero cost (explicitly free),
      // never a missing signal.
      assertEqual(parsePriceCell("$0/$0 · cache $0"), {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })
    },
  ],

  [
    "an unparseable price cell fails loudly (missing uses an em dash; anything else is a shape change)",
    () => {
      throws(() => parsePriceCell("$nope/$1 · cache $0.2"), /could not parse price cell/)
      throws(() => parsePriceCell("$1..2/$3 · cache $0.1"), /could not parse price cell/)
      throws(() => parsePriceCell("free"), /could not parse price cell/)
    },
  ],

  [
    "rows with a missing Context cell carry contextLength undefined — parseCatalogMarkdown keeps the row (ship-bar pending)",
    () => {
      const { rows } = parseCatalogMarkdown(
        "| `x/y` | X Y | — | low | $1/$2 · cache $0.1 | Go | best |\n",
      )
      assertEqual(rows.length, 1)
      assertEqual(rows[0].contextLength, undefined)
      assertEqual(rows[0].cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 })
    },
  ],

  [
    "rows with a missing price cell keep the row with cost undefined — the refresh walks its cost ladder",
    () => {
      const { rows } = parseCatalogMarkdown(A_ROW())
      const missing = rows.find((row) => row.id === "c/model")
      assertEqual(missing.cost, undefined)
      assertEqual(missing.contextLength, 1050000)
    },
  ],

  [
    "unparseable pricing rows fail loudly",
    () => {
      const md = "| `x/y` | X Y | 1M | low | $nope/$1 · cache $0.2 | Go | best |\n"
      throws(() => parseFactsMarkdown(md), /could not parse price cell/)
    },
  ],

  [
    "table rows missing a backticked id fail loudly",
    () => {
      const md = "| x/y | X Y | 1M | low | $1/$1 · cache $0.1 | Go | best |\n"
      throws(() => parseFactsMarkdown(md), /could not parse row: \| x\/y \|/)
    },
  ],

  [
    "non-finite parsed prices fail loudly",
    () => {
      const md = "| `x/y` | X Y | 1M | low | $1..2/$3 · cache $0.1 | Go | best |\n"
      throws(() => parseFactsMarkdown(md), /could not parse price cell/)
    },
  ],

  [
    "a double-missing row (Context AND price cells missing) parses both pending signals — unshippable-row loud failure engages only after the #132 ladder",
    () => {
      const md = "| `double/missing` | Double Missing | — | — | — | Go and above | best |\n"
      const { rows } = parseCatalogMarkdown(md)
      assertEqual(rows.length, 1)
      assertEqual(rows[0].contextLength, undefined)
      assertEqual(rows[0].efforts, undefined)
      assertEqual(rows[0].cost, undefined)
      // The parser-level contract: a missing price cell never zero-fills
      // (missing ≠ all-zero) and never throws — it is ladder-ready.
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.costs, {})
      assertEqual(facts.efforts, {})
    },
  ],
])
