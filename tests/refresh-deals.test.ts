// tests/refresh-deals.test.ts — seam: record → ModelDeals + HTML → deals.ts
import { readFileSync } from "node:fs"
import { extractModelRecords } from "../scripts/parse-docs.mjs"
import {
  discountFor,
  emitDealsModule,
  missingDealsModels,
  modelDealEntry,
  peakOffPeakFor,
} from "../scripts/refresh-deals.mjs"
import { assert, assertEqual, run } from "./harness.js"

const GOAT_HTML = readFileSync(new URL("./fixtures/goat.html", import.meta.url), "utf-8")
const PRO_HTML = readFileSync(new URL("./fixtures/pro.html", import.meta.url), "utf-8")
const PRICING_HTML = readFileSync(
  new URL("./fixtures/pricing-limits.html", import.meta.url),
  "utf-8",
)

run([
  [
    "discountFor maps deal terms to pct and endsAt",
    () => {
      assertEqual(
        discountFor({ deal: { free: true, discountPercent: 100 } }),
        undefined,
        "free → no discount",
      )
      assertEqual(discountFor({ deal: { discountPercent: 50, term: "permanent" } }), { pct: 50 })
      assertEqual(discountFor({ deal: { discountPercent: 50, expires: "2026-12-31T23:59:59Z" } }), {
        pct: 50,
        endsAt: "2026-12-31",
      })
      assertEqual(discountFor({ deal: { discountPercent: "$undefined" } }), undefined)
      assertEqual(discountFor({}), undefined)
      assertEqual(discountFor({ deal: null }), undefined)
    },
  ],
  [
    "peakOffPeakFor extracts windows and rates",
    () => {
      const rec = {
        timeOfDay: {
          peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
          offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
          windows: "01–04 & 06–10 UTC",
        },
      }
      assertEqual(peakOffPeakFor(rec), {
        peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
        offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
        windows: "01–04 & 06–10 UTC",
      })
      assertEqual(peakOffPeakFor({}), undefined)
      assertEqual(peakOffPeakFor({ timeOfDay: null }), undefined)
      assertEqual(
        peakOffPeakFor({ timeOfDay: { peak: { input: 1 } } }),
        undefined,
        "missing output → undefined",
      )
    },
  ],
  [
    "modelDealEntry: Qwen 3.6 Plus has overContext (long-context tier)",
    () => {
      const rec = [...extractModelRecords(GOAT_HTML).values()].find(
        (r) => r.name === "Qwen 3.6 Plus",
      )
      assert(rec, "Qwen 3.6 Plus must exist")
      assertEqual(modelDealEntry(rec), {
        tier: "opensource",
        benchmark: { intelligence: 40.5 },
        overContext: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
        free: false,
      })
    },
  ],
  [
    "modelDealEntry: Gemini 3.7 Flash has discount/was/now/benchmark",
    () => {
      const rec = [...extractModelRecords(GOAT_HTML).values()].find(
        (r) => r.name === "Gemini 3.7 Flash",
      )
      assert(rec, "Gemini must exist")
      assertEqual(modelDealEntry(rec), {
        tier: "opensource",
        discount: { pct: 50, endsAt: "2026-12-31" },
        was: { input: 1.5, output: 7.5, cacheRead: 0.15 },
        now: { input: 0.75, output: 3.75, cacheRead: 0.075 },
        benchmark: { intelligence: 56, tokPerSec: 339.4 },
        free: false,
      })
    },
  ],
  [
    "modelDealEntry: DeepSeek V4 Flash has peakOffPeak",
    () => {
      const rec = [...extractModelRecords(GOAT_HTML).values()].find(
        (r) => r.name === "DeepSeek V4 Flash (latest)",
      )
      assert(rec, "DeepSeek must exist")
      const entry = modelDealEntry(rec)
      assertEqual(entry.tier, "opensource")
      assertEqual(entry.peakOffPeak, {
        peak: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
        offPeak: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
        windows: "01–04 & 06–10 UTC",
      })
      assertEqual(entry.free, false)
    },
  ],
  [
    "modelDealEntry: MiniMax M3 has discount/was/now but no overContext (identical tier)",
    () => {
      const rec = extractModelRecords(GOAT_HTML).get("MiniMaxAI/MiniMax-M3")
      assert(rec, "MiniMax M3 must exist")
      assertEqual(modelDealEntry(rec), {
        tier: "opensource",
        discount: { pct: 50 },
        was: { input: 0.6, output: 2.4, cacheRead: 0.12 },
        now: { input: 0.3, output: 1.2, cacheRead: 0.06 },
        benchmark: { intelligence: 45.4, tokPerSec: 104.4 },
        free: false,
      })
    },
  ],
  [
    "modelDealEntry: Laguna free model has only tier+free",
    () => {
      const rec = [...extractModelRecords(GOAT_HTML).values()].find(
        (r) => r.name === "Laguna S 2.1",
      )
      assert(rec, "Laguna must exist")
      assertEqual(modelDealEntry(rec), { tier: "opensource", free: true })
    },
  ],
  [
    "emitDealsModule emits valid deals module from fixtures",
    () => {
      const out = emitDealsModule({
        pricingLimitsHtml: PRICING_HTML,
        goatHtml: GOAT_HTML,
        proHtml: PRO_HTML,
        lastRefreshed: "2026-08-20",
        packageVersion: "docs",
      })
      assert(out.includes("export const MODEL_DEALS"), "must emit MODEL_DEALS")
      assert(out.includes('"Qwen/Qwen3.8-27B"'), "must include Qwen")
      assert(out.includes('"google/gemini-3.7-flash"'), "must include gemini")
      assert(out.includes('"goat":70'), "must include GOAT allowance 70")
      assert(out.includes("export const PLAN_CATALOG"), "must emit PLAN_CATALOG")
      assert(out.includes('export const DEAL_LAST_REFRESHED = "2026-08-20"'))
      assert(out.includes('export const DEAL_PACKAGE_VERSION = "docs"'))
      // overContext must be present for Qwen 3.7 Plus etc, absent for MiniMax identical tier
      assert(
        out.includes("Qwen/Qwen3.7-Plus") && out.includes("overContext"),
        "Qwen 3.7 Plus must have overContext",
      )
      // count entries: should be 56 from goat
      const entries = (out.match(/": \{ /g) ?? []).length
      assert(entries >= 50, `must emit 50+ entries, got ${entries}`)
    },
  ],
  [
    "missingDealsModels: fresh fixtures cover every snapshot model",
    () => {
      const recs = extractModelRecords(GOAT_HTML)
      const { missing, covered } = missingDealsModels(recs)
      assertEqual(missing, [], `missing: ${missing.join(", ")}`)
      assert(covered >= 58, `expected >= 58 covered, got ${covered}`)
    },
  ],
  [
    "missingDealsModels flags stale fixtures that lack new models",
    () => {
      // A docs source missing Ox Alpha / DeepSeek V4 Flash Vision (exp) must
      // be reported so refresh aborts instead of emitting a partial catalog.
      const recs = extractModelRecords(GOAT_HTML)
      const without = new Map(
        [...recs].filter(
          ([, r]) => r.name !== "Ox Alpha" && r.name !== "DeepSeek V4 Flash Vision (exp)",
        ),
      )
      const { missing, covered } = missingDealsModels(without)
      assertEqual(
        missing.sort(),
        ["deepseek/deepseek-v4-flash-vision-exp", "stealth/ox-alpha"],
        "must report the two models the docs source lacks",
      )
      assertEqual(covered, 58)
    },
  ],
  [
    "emitDealsModule tolerates empty pages",
    () => {
      const out = emitDealsModule({
        pricingLimitsHtml: "<html></html>",
        goatHtml: "<html></html>",
        proHtml: "<html></html>",
        lastRefreshed: "2026-08-20",
        packageVersion: "docs",
      })
      assert(
        out.includes("export const MODEL_DEALS: Readonly<Record<string, ModelDeals>> = {"),
        "must emit header",
      )
      assert(out.includes("PLAN_CATALOG"), "must still emit catalog")
      // No model entries with empty input
      const lines = out.split("\n").filter((l) => l.trim().startsWith('"'))
      assertEqual(lines.length, 0, "empty input must emit no model lines")
    },
  ],
])
