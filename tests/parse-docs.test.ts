// tests/parse-docs.test.ts — seam: HTML/fixtures → typed records (refresh-deals depends on this)
import { readFileSync } from "node:fs"
import {
  benchmarkFor,
  endsAtFor,
  extractModelRecords,
  extractPlanAllowances,
  num,
  ratesFor,
} from "../scripts/parse-docs.mjs"
import { assert, assertEqual, run } from "./harness.js"

const GOAT_HTML = readFileSync(new URL("./fixtures/goat.html", import.meta.url), "utf-8")
const PRO_HTML = readFileSync(new URL("./fixtures/pro.html", import.meta.url), "utf-8")
const PRICING_HTML = readFileSync(
  new URL("./fixtures/pricing-limits.html", import.meta.url),
  "utf-8",
)

run([
  [
    "extractModelRecords parses 60 records from goat fixture",
    () => {
      const recs = extractModelRecords(GOAT_HTML)
      assertEqual(recs.size, 60)
      const m = recs.get("MiniMaxAI/MiniMax-M3")
      assert(m, "MiniMax M3 must exist")
      assertEqual(m.name, "MiniMax M3")
      assertEqual(m.category, "opensource")
      assertEqual(m.deal.discountPercent, 50)
      assertEqual(m.intelligenceIndex, 45.4)
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
    "extractPlanAllowances extracts GOAT allowances from goat tables",
    () => {
      const map = extractPlanAllowances(GOAT_HTML)
      assertEqual(map.get("GPT-5.6 Sol"), 70)
      assertEqual(map.get("GLM-5.2"), 70)
      assertEqual(map.get("Tencent Hy3"), 70)
      assert(map.size >= 28, `goat allowances must be 28+, got ${map.size}`)
    },
  ],
  [
    "extractPlanAllowances extracts PRO allowances from pro fixture",
    () => {
      const map = extractPlanAllowances(PRO_HTML)
      assert(map.size >= 20, `pro allowances must be 20+, got ${map.size}`)
      // Pro allowances are generally $20 for most models via fixtures
      const has20 = [...map.values()].some((v) => v === 20)
      assert(has20, "pro must have at least one $20 allowance")
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
