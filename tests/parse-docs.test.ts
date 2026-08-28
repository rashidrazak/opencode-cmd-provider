// tests/parse-docs.test.ts — seam: HTML/fixtures → typed records (refresh-deals depends on this)
import {
  benchmarkFor,
  endsAtFor,
  extractModelRecords,
  extractPlanAllowances,
  num,
  ratesFor,
} from "../scripts/parse-docs.mjs"
import { assert, assertEqual, run } from "./harness.js"

// Inline synthetic HTML fixtures. The HTML parser helpers in parse-docs.mjs
// are kept as a documented fallback for air-gapped environments (per the
// wayfinder spec at #77), but the refresh script no longer reads HTML
// fixtures. These strings exercise the helpers' happy paths without
// requiring the committed tests/fixtures/*.html files (deleted in ticket
// #83).

// Flight-payload fragment: four `{"slug":"..."}` records scattered
// through the page, with the same escape rules the live HTML uses
// (\\" → ", \\n → newline, \\u0026 → &).
const GOAT_HTML = `<html><body><script>
1:HL["x",[],null,{"slug":"x","id":"MiniMaxAI/MiniMax-M3","name":"MiniMax M3","category":"opensource","deal":{"discountPercent":50},"intelligenceIndex":45.4}]
</script><script>
1:HL["x",[],null,{"slug":"x","id":"x2","name":"Model Two","category":"premium"}]
</script><script>
1:HL["x",[],null,{"slug":"x","id":"x3","name":"Model Three","category":"opensource","deal":{"discountPercent":25}}
</script><script>
1:HL["x",[],null,{"slug":"hy4-preview","id":"tencent/hy4-preview","name":"Tencent Hy4 Preview","category":"opensource","tiers":[{"rates":{"input":0.834,"output":2.501,"cacheRead":0.042}}],"deal":"$undefined"}]
</script></body></html>`

// Rendered allowance table: 4 models with PRO allowances. extractTables
// needs the table to have `<th>Model</th>` in the first cell and a header
// containing "Monthly credits".
const PRO_HTML = `<html><body>
<table>
<thead><tr><th>Model</th><th>Plan</th><th>Tier</th><th>Context</th><th>Output</th><th>Monthly credits</th></tr></thead>
<tbody>
<tr><td>GPT-5.6 Sol</td><td>PRO</td><td>premium</td><td>200K</td><td>32K</td><td>$80</td></tr>
<tr><td>GLM-5.2</td><td>PRO</td><td>opensource</td><td>128K</td><td>16K</td><td>$80</td></tr>
<tr><td>Tencent Hy3</td><td>PRO</td><td>opensource</td><td>256K</td><td>32K</td><td>$20</td></tr>
<tr><td>Tencent Hy4 Preview</td><td>PRO</td><td>opensource</td><td>1024K</td><td>64K</td><td>$30</td></tr>
</tbody>
</table>
</body></html>`

// Empty pricing-limits page (no embedded records and no allowance tables).
const PRICING_HTML = "<html><body></body></html>"

run([
  [
    "extractModelRecords parses records from inline goat fixture",
    () => {
      const recs = extractModelRecords(GOAT_HTML)
      assertEqual(recs.size, 4)
      const m = recs.get("MiniMaxAI/MiniMax-M3")
      assert(m, "MiniMax M3 must exist")
      assertEqual(m.name, "MiniMax M3")
      assertEqual(m.category, "opensource")
      assertEqual(m.deal.discountPercent, 50)
      assertEqual(m.intelligenceIndex, 45.4)
      const hy4 = recs.get("tencent/hy4-preview")
      assert(hy4, "Tencent Hy4 Preview must exist")
      assertEqual(hy4.name, "Tencent Hy4 Preview")
      assertEqual(hy4.category, "opensource")
      assertEqual(hy4.tiers[0].rates, { input: 0.834, output: 2.501, cacheRead: 0.042 })
    },
  ],
  [
    "extractModelRecords returns empty for pricing-limits (no embedded records)",
    () => {
      const recs = extractModelRecords(PRICING_HTML)
      assertEqual(recs.size, 0)
    },
  ],
  [
    "extractPlanAllowances extracts PRO allowances from inline fixture",
    () => {
      const map = extractPlanAllowances(PRO_HTML)
      assertEqual(map.get("GPT-5.6 Sol"), 80)
      assertEqual(map.get("GLM-5.2"), 80)
      assertEqual(map.get("Tencent Hy3"), 20)
      assertEqual(map.get("Tencent Hy4 Preview"), 30)
      assertEqual(map.size, 4)
    },
  ],
  [
    "extractPlanAllowances returns empty for pages with no allowance tables",
    () => {
      const map = extractPlanAllowances(GOAT_HTML)
      assertEqual(map.size, 0, "goat fixture has no rendered tables, must yield no allowances")
    },
  ],
  [
    "num handles numbers, strings, and undefined tokens",
    () => {
      assertEqual(num(5), 5)
      assertEqual(num("52"), 52)
      assertEqual(num("52.5"), 52.5)
      assertEqual(num("$undefined"), undefined)
      assertEqual(num("undefined"), undefined)
      assertEqual(num("null"), undefined)
      assertEqual(num(null), undefined)
      assertEqual(num(undefined), undefined)
      assertEqual(num("bad"), undefined)
      assertEqual(num(NaN), undefined)
      assertEqual(num(Infinity), undefined)
      assertEqual(num({}), undefined)
    },
  ],
  [
    "endsAtFor maps deal terms to dates",
    () => {
      assertEqual(endsAtFor({ free: true }), "while capacity lasts")
      assertEqual(endsAtFor({ term: "permanent deal" }), undefined)
      assertEqual(endsAtFor({ expires: "2026-12-31T23:59:59Z" }), "2026-12-31")
      assertEqual(
        endsAtFor({ term: "ends December", expires: "2026-12-31T23:59:59Z" }),
        "2026-12-31",
      )
      assertEqual(endsAtFor(null), undefined)
      assertEqual(endsAtFor({}), undefined)
    },
  ],
  [
    "ratesFor parses tier rates with cacheRead default",
    () => {
      assertEqual(ratesFor({ rates: { input: 1, output: 2, cacheRead: 0.1 } }), {
        input: 1,
        output: 2,
        cacheRead: 0.1,
      })
      assertEqual(ratesFor({ rates: { input: "1", output: "2" } }), {
        input: 1,
        output: 2,
        cacheRead: 0,
      })
      assertEqual(ratesFor({ rates: { input: 1 } }), undefined, "missing output → undefined")
      assertEqual(ratesFor({}), undefined)
      assertEqual(ratesFor(null), undefined)
      assertEqual(ratesFor({ rates: { input: "$undefined", output: 2 } }), undefined)
    },
  ],
  [
    "benchmarkFor extracts intelligence and tok/s",
    () => {
      assertEqual(benchmarkFor({ intelligenceIndex: "52", outputTokensPerSec: "100" }), {
        intelligence: 52,
        tokPerSec: 100,
      })
      assertEqual(benchmarkFor({ intelligenceIndex: 52 }), { intelligence: 52 })
      assertEqual(benchmarkFor({ outputTokensPerSec: 339.4 }), { tokPerSec: 339.4 })
      assertEqual(
        benchmarkFor({ intelligenceIndex: "$undefined", outputTokensPerSec: "$undefined" }),
        undefined,
      )
      assertEqual(benchmarkFor({}), undefined)
    },
  ],
])
