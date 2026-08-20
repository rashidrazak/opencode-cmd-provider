// tests/html-tables.test.ts — seam: HTML → table rows (parse-docs relies on this)
import { readFileSync } from "node:fs"
import { extractTables, parseMoney } from "../scripts/html-tables.mjs"
import { assert, assertEqual, run } from "./harness.js"

const GOAT_HTML = readFileSync(new URL("./fixtures/goat.html", import.meta.url), "utf-8")

run([
  [
    "extractTables returns rows of cells stripped of tags",
    () => {
      const html = `<table><tr><th>A</th><th>B</th></tr><tr><td>  <b>hello</b>  </td><td>world<br>next</td></tr></table>`
      const tables = extractTables(html)
      assertEqual(tables.length, 1)
      assertEqual(tables[0][0], ["A", "B"])
      assertEqual(tables[0][1], ["hello", "world next"])
    },
  ],
  [
    "extractTables returns empty for html with no tables",
    () => {
      assertEqual(extractTables("<html><body>no tables</body></html>"), [])
      assertEqual(extractTables(""), [])
    },
  ],
  [
    "extractTables handles fixtures: goat page has 4+ tables with allowance tables",
    () => {
      const tables = extractTables(GOAT_HTML)
      assert(tables.length >= 4, `goat page must have 4+ tables, got ${tables.length}`)
      const allowanceTables = tables.filter(
        (t) => t[0]?.[0] === "Model" && t[0].includes("Monthly credits"),
      )
      assert(allowanceTables.length >= 2, "must find 2 allowance tables")
      assertEqual(allowanceTables[0][0], [
        "Model",
        "Input",
        "Output",
        "Cache Read",
        "Cache Write",
        "Monthly credits",
      ])
      assertEqual(allowanceTables[0][1][0], "GPT-5.6 Sol")
      assertEqual(allowanceTables[0][1][5], "$70")
    },
  ],
  [
    "parseMoney handles dollars, decimals, and dashes",
    () => {
      assertEqual(parseMoney("$70"), 70)
      assertEqual(parseMoney("$0.435"), 0.435)
      assertEqual(parseMoney("$1,000"), 1000)
      assertEqual(parseMoney("$70.00"), 70)
      assertEqual(parseMoney("  $70  "), 70)
      assertEqual(parseMoney("—"), null)
      assertEqual(parseMoney("Free"), null)
      assertEqual(parseMoney("free"), null)
      assertEqual(parseMoney(""), null)
      assertEqual(parseMoney(undefined), null)
      assertEqual(parseMoney("not money"), null)
    },
  ],
  [
    "parseMoney strips commas",
    () => {
      assertEqual(parseMoney("$1,234,567"), 1234567)
    },
  ],
])
