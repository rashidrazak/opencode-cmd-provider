// tests/html-tables.test.ts — seam: HTML → table rows (parse-docs relies on this)
import { extractTables, parseMoney } from "../scripts/html-tables.mjs"
import { assert, assertEqual, run } from "./harness.js"

// Inline synthetic HTML. The HTML tables helper is kept as a documented
// fallback for air-gapped environments (per the wayfinder spec at #77),
// but the refresh script no longer reads HTML fixtures. This fixture
// mirrors the goat page's table layout: 4 tables, 2 of which are
// allowance tables (one per model group), so the helper's happy paths
// are still exercised without depending on the deleted
// tests/fixtures/*.html files.
const GOAT_HTML = `
<table>
<thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th><th>Monthly credits</th></tr></thead>
<tbody>
<tr><td>GPT-5.6 Sol</td><td>3</td><td>15</td><td>0.3</td><td>3.75</td><td>$70</td></tr>
<tr><td>GLM-5.2</td><td>0.6</td><td>2.4</td><td>0.06</td><td>0.75</td><td>$70</td></tr>
</tbody>
</table>
<table>
<thead><tr><th>Notes</th></tr></thead>
<tbody><tr><td>Some notes</td></tr></tbody>
</table>
<table>
<thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th><th>Monthly credits</th></tr></thead>
<tbody><tr><td>Tencent Hy3</td><td>0.16</td><td>0.47</td><td>0.016</td><td>0.058</td><td>$70</td></tr></tbody>
</table>
<table>
<thead><tr><th>Footnotes</th></tr></thead>
<tbody><tr><td>various</td></tr></tbody>
</table>
`

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
    "extractTables handles goat-like fixture: 4 tables, 2 allowance tables",
    () => {
      const tables = extractTables(GOAT_HTML)
      assert(tables.length >= 4, `inline fixture must have 4+ tables, got ${tables.length}`)
      const allowanceTables = tables.filter(
        (t) => t[0]?.[0] === "Model" && t[0].includes("Monthly credits"),
      )
      assertEqual(allowanceTables.length, 2, "must find 2 allowance tables")
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
