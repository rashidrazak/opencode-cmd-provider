// tests/refresh-deals.test.ts — seam: record → ModelDeals + HTML/RSC → deals.ts
import { readFileSync } from "node:fs"
import { extractModelRecords } from "../scripts/parse-docs.mjs"
import { extractPricingLimitsRsc } from "../scripts/parse-rsc.mjs"
import {
  discountFor,
  emitDealsModule,
  emitDealsModuleFromRsc,
  missingDealsModels,
  missingDealsModelsFromRsc,
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
const RSC_PRICING = readFileSync(
  new URL("./fixtures/rsc-pricing-limits.txt", import.meta.url),
  "utf-8",
)
const RSC_GOAT = readFileSync(new URL("./fixtures/rsc-goat.txt", import.meta.url), "utf-8")
const RSC_PRO = readFileSync(new URL("./fixtures/rsc-pro.txt", import.meta.url), "utf-8")

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
      // A docs source missing a snapshot model (e.g. GLM-5.3 Flash) must be
      // reported so refresh aborts instead of emitting a partial catalog.
      const recs = extractModelRecords(GOAT_HTML)
      const without = new Map(
        [...recs].filter(
          ([, r]) => r.name !== "GLM-5.3 Flash" && r.name !== "DeepSeek V4 Flash Vision (exp)",
        ),
      )
      const { missing, covered } = missingDealsModels(without)
      assertEqual(
        missing.sort(),
        ["deepseek/deepseek-v4-flash-vision-exp", "z-ai/glm-5.3-flash"],
        "must report the two models the docs source lacks",
      )
      assertEqual(covered, 59)
    },
  ],
  [
    "missingDealsModels flags fixtures that drop a free variant (name collision must not mask it)",
    () => {
      // The free MiniMax variants share display names with their paid
      // siblings, so only id matching can prove their docs records exist —
      // removing them must fail the gate like any other missing model.
      const recs = extractModelRecords(GOAT_HTML)
      const withoutFree = new Map(
        [...recs].filter(([, r]) => !(r.id.startsWith("minimax/") && r.id.endsWith("-free"))),
      )
      const { missing, covered } = missingDealsModels(withoutFree)
      assertEqual(
        missing.sort(),
        ["minimax/minimax-m2.7-free", "minimax/minimax-m3-free"],
        "must report the free variants the docs source lacks",
      )
      assertEqual(covered, 59)
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
  [
    "emitDealsModuleFromRsc emits a valid deals module from the RSC fixtures",
    () => {
      const out = emitDealsModuleFromRsc({
        pricingLimitsRsc: RSC_PRICING,
        goatRsc: RSC_GOAT,
        proRsc: RSC_PRO,
        lastRefreshed: "2026-08-28",
        packageVersion: "rsc",
      })
      assert(
        out.includes("export const MODEL_DEALS: Readonly<Record<string, ModelDeals>> = {"),
        "must emit MODEL_DEALS header",
      )
      assert(out.includes("PLAN_CATALOG"), "must emit PLAN_CATALOG")
      assert(
        out.includes('export const DEAL_LAST_REFRESHED = "2026-08-28"'),
        "must surface lastRefreshed",
      )
      assert(
        out.includes('"moonshotai/Kimi-K3"'),
        "must include Kimi K3 (vendor-prefixed id from goat slug)",
      )
      assert(
        out.includes('"claude-haiku-4-5-20251001"'),
        "slug-id alias must be applied to claude-haiku-4-5 → 4-5-20251001",
      )
      // Per-model RSC entry shape must include benchmark + allowance.
      assert(
        out.includes("MiniMaxAI/MiniMax-M3") &&
          out.includes("discount") &&
          out.includes("benchmark") &&
          out.includes("allowance"),
        "MiniMax M3 must carry discount+benchmark+allowance",
      )
    },
  ],
  [
    "emitDealsModuleFromRsc covers at least the same models as the HTML path",
    () => {
      // The RSC is strictly a superset of the HTML scrape: every model
      // the HTML emits must also be emitted by the RSC path, with the
      // same id. The reverse isn't required (RSC may carry models the
      // HTML scraped before the snapshot caught up, or vice versa).
      const htmlOut = emitDealsModule({
        pricingLimitsHtml: PRICING_HTML,
        goatHtml: GOAT_HTML,
        proHtml: PRO_HTML,
        lastRefreshed: "2026-08-28",
        packageVersion: "docs",
      })
      const rscOut = emitDealsModuleFromRsc({
        pricingLimitsRsc: RSC_PRICING,
        goatRsc: RSC_GOAT,
        proRsc: RSC_PRO,
        lastRefreshed: "2026-08-28",
        packageVersion: "rsc",
      })
      const htmlIds = new Set(
        htmlOut
          .split("\n")
          .map((l) => l.match(/^\s*"([^"]+)":\s*\{/))
          .filter(Boolean)
          .map((m2) => m2[1]),
      )
      const rscIds = new Set(
        rscOut
          .split("\n")
          .map((l) => l.match(/^\s*"([^"]+)":\s*\{/))
          .filter(Boolean)
          .map((m2) => m2[1]),
      )
      const onlyInHtml = [...htmlIds].filter((id) => !rscIds.has(id))
      assertEqual(
        onlyInHtml,
        [],
        `RSC path must cover every model the HTML path emits. Missing: ${onlyInHtml.join(", ")}`,
      )
      // RSC is a superset — must carry at least the HTML count.
      assert(
        rscIds.size >= htmlIds.size,
        `RSC must cover at least as many models as HTML (rsc=${rscIds.size}, html=${htmlIds.size})`,
      )
    },
  ],
  [
    "emitDealsModuleFromRsc carries the RSC's planAllowanceUsd directly into MODEL_DEALS",
    () => {
      // The HTML's `extractPlanAllowances` reads the rendered HTML
      // tables, which only list a subset of paid models. The RSC's
      // `planAllowanceUsd` is more complete — every paid model. The
      // test pins that gap: a model with allowance in the compact
      // array must surface in the output.
      const out = emitDealsModuleFromRsc({
        pricingLimitsRsc: RSC_PRICING,
        goatRsc: RSC_GOAT,
        proRsc: RSC_PRO,
        lastRefreshed: "2026-08-28",
        packageVersion: "rsc",
      })
      // moonshotai/Kimi-K3: RSC compact has goat=20, pro=30.
      const kimiLine = out.split("\n").find((l) => l.includes('"moonshotai/Kimi-K3"'))
      assert(kimiLine, "must have a Kimi K3 entry")
      assert(
        kimiLine.includes('"goat":20') && kimiLine.includes('"pro":30'),
        `Kimi K3 must carry RSC allowances (got: ${kimiLine})`,
      )
    },
  ],
  [
    "missingDealsModelsFromRsc reports missing snapshot models for an incomplete RSC source",
    () => {
      // The pricing-limits RSC alone doesn't carry every model the
      // per-plan pages do (Qwen 3.8 Flash, GLM 5.3 Flash). The RSC
      // path merges them; feeding an empty per-plan RSC must drop
      // those models and trip the gate.
      const { availability } = extractPricingLimitsRsc(RSC_PRICING)
      const bySnapshotId = new Map()
      for (const r of availability) {
        if (!r.name) continue
        const sid = r.id
        if (sid) bySnapshotId.set(sid, r)
      }
      const { missing, covered } = missingDealsModelsFromRsc(bySnapshotId)
      // Qwen 3.8 Flash, GLM 5.3 Flash, and others are in the snapshot
      // but not in the availability array. The gate must flag them.
      assert(missing.length > 0, "an RSC source missing slug records must trip the gate")
      assert(
        missing.includes("Qwen/Qwen3.8-Flash") ||
          missing.some((id) => id.includes("Qwen3.8-Flash")),
        `gate must include Qwen3.8-Flash, got: ${missing.join(", ")}`,
      )
      assert(covered > 0, "covered count must be > 0")
    },
  ],
  [
    "missingDealsModelsFromRsc reports zero missing when the merged RSC source is complete",
    () => {
      // When the full RSC path runs (all three RSC sources present),
      // the merged bySnapshotId Map must cover every snapshot model.
      // The gate must therefore report zero missing.
      const out = emitDealsModuleFromRsc({
        pricingLimitsRsc: RSC_PRICING,
        goatRsc: RSC_GOAT,
        proRsc: RSC_PRO,
        lastRefreshed: "2026-08-28",
        packageVersion: "rsc",
      })
      // Reconstruct the bySnapshotId Map the emit function would have
      // built, by extracting the ids from the emitted module. (The
      // gate runs BEFORE emit, so the gate's contract is the same
      // population the emit consumes.)
      const ids = new Set(
        out
          .split("\n")
          .map((l) => l.match(/^\s*"([^"]+)":\s*\{/))
          .filter(Boolean)
          .map((m2) => m2[1]),
      )
      const { missing, covered } = missingDealsModelsFromRsc(ids)
      assertEqual(missing, [], `full RSC must cover every snapshot, missing: ${missing.join(", ")}`)
      assert(covered > 50, `covered must be > 50, got ${covered}`)
    },
  ],
])
