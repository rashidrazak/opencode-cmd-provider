// tests/refresh-deals.test.ts — seam: record → ModelDeals + RSC → deals.ts
//
// The modelDealEntry tests below use **synthetic** RSC records (hand-built
// objects with the same shape the live docs page emits). This keeps the
// tests independent of upstream data changes: when Command Code ends a
// deal, adjusts a benchmark number, or re-categorises a model, the
// committed fixtures move but the test pins don't break. The
// "real RSC" tests below (emitDealsModuleFromRsc, missingDealsModelsFromRsc)
// exercise the end-to-end pipeline against the committed fixtures as
// shape/contract smoke tests — they assert on the parser's behavior, not
// on specific upstream values.
//
// Why this matters for the cron (issue #89 + the catalog-refresh.yml
// "without breaking" criterion): when upstream changes a transient
// value (a deal's pct, a benchmark's tokPerSec, a tier reclassification),
// the catalog-refresh cron must still be able to ship a PR. Pinning
// upstream data in tests made the cron fail on every legitimate value
// change and required a human to update the pins before the cron could
// proceed. The synthetic-record approach below keeps the parser's
// behavior pinned while the values stay fluid.
import { readFileSync } from "node:fs"
import { extractPlanPageRsc, extractPricingLimitsRsc } from "../scripts/parse-rsc.mjs"
import {
  discountFor,
  emitDealsModuleFromRsc,
  missingDealsModelsFromRsc,
  modelDealEntry,
  peakOffPeakFor,
} from "../scripts/refresh-deals.mjs"
import { assert, assertEqual, run } from "./harness.js"

const RSC_PRICING = readFileSync(
  new URL("./fixtures/rsc-pricing-limits.txt", import.meta.url),
  "utf-8",
)
const RSC_GOAT = readFileSync(new URL("./fixtures/rsc-goat.txt", import.meta.url), "utf-8")
const RSC_PRO = readFileSync(new URL("./fixtures/rsc-pro.txt", import.meta.url), "utf-8")

// The per-plan RSC slug records (used by the smoke tests below) are the
// source of truth for the snapshot id and per-model data. The records
// carry the same `tiers`, `deal`, `caps`, `intelligenceIndex`, and
// `outputTokensPerSec` fields the old HTML path extracted —
// modelDealEntry is happy to consume either.
const RSC_RECORDS = extractPlanPageRsc(RSC_GOAT)

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
    "modelDealEntry: a record with deal+listRates+benchmark produces discount/was/now/benchmark (synthetic)",
    () => {
      // Synthetic record with an active deal (50% off, expires),
      // `listRates` (the pre-deal price), and benchmark data. This
      // exercises the same code path the Gemini 3.7 Flash test used
      // to pin against the live RSC, but the values are owned by the
      // test — upstream data changes can't break the pin.
      //
      // The `id` here is *not* in TIER_OVERRIDES (the override is
      // applied by buildRscInputs before the entry reaches
      // modelDealEntry in the real pipeline — modelDealEntry itself
      // is a pure pass-through of `record.category` to `tier`).
      const rec = {
        id: "vendor/example-model",
        category: "opensource",
        deal: {
          discountPercent: 50,
          free: false,
          expires: "2026-12-31T23:59:59Z",
        },
        tiers: [
          {
            rates: { input: 0.75, output: 3.75, cacheRead: 0.075 },
            listRates: { input: 1.5, output: 7.5, cacheRead: 0.15 },
          },
        ],
        intelligenceIndex: 56,
        outputTokensPerSec: 365.9,
      }
      assertEqual(modelDealEntry(rec), {
        tier: "opensource",
        discount: { pct: 50, endsAt: "2026-12-31" },
        was: { input: 1.5, output: 7.5, cacheRead: 0.15 },
        now: { input: 0.75, output: 3.75, cacheRead: 0.075 },
        benchmark: { intelligence: 56, tokPerSec: 365.9 },
        free: false,
      })
    },
  ],
  [
    "modelDealEntry: a record with deal+listRates but no benchmark keeps the discount shape (synthetic)",
    () => {
      // The discount/was/now branch must still fire when benchmark
      // data is missing — the deal metadata is independent of
      // intelligence/tokPerSec. The MiniMax M3 test used to cover
      // this; the synthetic version below owns the values.
      const rec = {
        id: "MiniMaxAI/MiniMax-M3",
        category: "opensource",
        deal: { discountPercent: 50, free: false, term: "" },
        tiers: [
          {
            rates: { input: 0.3, output: 1.2, cacheRead: 0.06 },
            listRates: { input: 0.6, output: 2.4, cacheRead: 0.12 },
          },
        ],
        intelligenceIndex: 45.4,
        outputTokensPerSec: 111.3,
      }
      assertEqual(modelDealEntry(rec), {
        tier: "opensource",
        discount: { pct: 50 },
        was: { input: 0.6, output: 2.4, cacheRead: 0.12 },
        now: { input: 0.3, output: 1.2, cacheRead: 0.06 },
        benchmark: { intelligence: 45.4, tokPerSec: 111.3 },
        free: false,
      })
    },
  ],
  [
    "modelDealEntry: a record without a deal produces no discount (synthetic)",
    () => {
      // The no-deal branch (the case the cron hit on 2026-08-31 when
      // the Gemini 3.7 Flash deal ended): no `was` (no listRates),
      // no `discount`, no `now` (now only surfaces alongside a deal
      // or listRates). The benchmark still surfaces if present. This
      // is the path every paid model that's never had a deal takes.
      const rec = {
        id: "vendor/example-model",
        category: "opensource",
        tiers: [{ rates: { input: 1.5, output: 7.5, cacheRead: 0.15 } }],
        intelligenceIndex: 56,
        outputTokensPerSec: 365.9,
      }
      const entry = modelDealEntry(rec)
      assertEqual(entry.tier, "opensource")
      assertEqual(entry.discount, undefined)
      assertEqual(entry.was, undefined)
      assertEqual(entry.now, undefined)
      assertEqual(entry.benchmark, { intelligence: 56, tokPerSec: 365.9 })
      assertEqual(entry.free, false)
    },
  ],
  [
    "modelDealEntry: a record with deal=undefined sentinel (RSC per-plan shape) still treats it as no deal (synthetic)",
    () => {
      // The per-plan RSC slug records carry `deal: "$undefined"` (a
      // string sentinel) when the deal has ended, rather than
      // omitting the field. discountFor already handles this — the
      // modelDealEntry smoke test pins the same behavior here.
      const rec = {
        id: "vendor/example-model",
        category: "opensource",
        deal: "$undefined",
        tiers: [{ rates: { input: 1.5, output: 7.5, cacheRead: 0.15 } }],
        intelligenceIndex: 56,
        outputTokensPerSec: 365.9,
      }
      const entry = modelDealEntry(rec)
      assertEqual(entry.tier, "opensource")
      assertEqual(entry.discount, undefined)
      assertEqual(entry.was, undefined)
      assertEqual(entry.free, false)
    },
  ],
  [
    "modelDealEntry: a record with two tiers of different rates emits overContext (synthetic)",
    () => {
      // The Qwen 3.6 Plus test used to cover this against the live
      // RSC. The synthetic version below owns the values: a
      // short-context tier at the regular rate plus a long-context
      // tier with different rates triggers `overContext`.
      const rec = {
        id: "Qwen/Qwen3.6-Plus",
        category: "opensource",
        tiers: [
          { rates: { input: 0.5, output: 3, cacheRead: 0.1 } },
          { rates: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 } },
        ],
        intelligenceIndex: 40.5,
      }
      assertEqual(modelDealEntry(rec), {
        tier: "opensource",
        benchmark: { intelligence: 40.5 },
        overContext: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
        free: false,
      })
    },
  ],
  [
    "modelDealEntry: a record with two identical tiers suppresses overContext (synthetic)",
    () => {
      // The cron hit this case on 2026-08-29 (MiniMax M3): the
      // long-context tier is byte-identical to the short-context
      // tier, so overContext is dropped (no useful information).
      const rec = {
        id: "MiniMaxAI/MiniMax-M3",
        category: "opensource",
        deal: { discountPercent: 50, free: false, term: "" },
        tiers: [
          { rates: { input: 0.3, output: 1.2, cacheRead: 0.06 } },
          { rates: { input: 0.3, output: 1.2, cacheRead: 0.06 } },
        ],
      }
      const entry = modelDealEntry(rec)
      assertEqual(entry.overContext, undefined, "identical tier must suppress overContext")
      assertEqual(entry.discount, { pct: 50 })
    },
  ],
  [
    "modelDealEntry: a record with timeOfDay emits peakOffPeak (synthetic)",
    () => {
      // The DeepSeek V4 Flash test used to cover this against the
      // live RSC. The synthetic version owns the rates: peak and
      // off-peak are surfaced with `cacheWrite: 0` and the
      // `windows` string carries through.
      const rec = {
        id: "deepseek/deepseek-v4-flash",
        category: "opensource",
        timeOfDay: {
          peak: { input: 0.44, output: 1.32, cacheRead: 0.014 },
          offPeak: { input: 0.22, output: 0.66, cacheRead: 0.007 },
          windows: "01–04 & 06–10 UTC",
        },
        tiers: [{ rates: { input: 0.22, output: 0.66, cacheRead: 0.007 } }],
      }
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
    "modelDealEntry: a free record emits only tier+free (synthetic)",
    () => {
      // The Laguna free-variant test used to cover this against the
      // live RSC. The synthetic version owns the shape: zero rates
      // + `free: true` short-circuits the deal/benchmark branches.
      const rec = {
        id: "poolside/laguna-s-2.1-free",
        category: "opensource",
        deal: { free: true, discountPercent: 100 },
        tiers: [{ rates: { input: 0, output: 0, cacheRead: 0 } }],
      }
      assertEqual(modelDealEntry(rec), { tier: "opensource", free: true })
    },
  ],
  [
    "modelDealEntry: a premium record passes through without an override (synthetic)",
    () => {
      // claude-fable-5 is a real premium model — the TIER_OVERRIDES
      // map must not pin it. The category pass-through covers any
      // premium model not in the override list.
      const rec = {
        id: "claude-fable-5",
        category: "premium",
        tiers: [{ rates: { input: 1, output: 2, cacheRead: 0.1 } }],
      }
      const entry = modelDealEntry(rec)
      assertEqual(entry.tier, "premium")
      assertEqual(entry.free, false)
    },
  ],
  [
    "modelDealEntry: an empty record emits free:false with no other fields (synthetic)",
    () => {
      // Defensive: a record that lacks every optional field must
      // not throw and must emit the minimum shape (free: false
      // always surfaces so downstream consumers see a stable flag).
      const entry = modelDealEntry({ id: "x" })
      assertEqual(entry.free, false)
      assertEqual(entry.discount, undefined)
      assertEqual(entry.was, undefined)
      assertEqual(entry.now, undefined)
      assertEqual(entry.benchmark, undefined)
      assertEqual(entry.peakOffPeak, undefined)
      assertEqual(entry.overContext, undefined)
      assertEqual(entry.tier, undefined)
    },
  ],
  [
    "modelDealEntry: the RSC fixtures parse cleanly (smoke test against the real RSC)",
    () => {
      // End-to-end smoke test: every per-plan slug record the live
      // RSC emits must produce a `modelDealEntry` without throwing.
      // We don't pin values here — the synthetic-record tests above
      // own the value semantics. This is a structural check that the
      // parser handles the full real RSC: the cron relies on it.
      for (const [id, record] of RSC_RECORDS) {
        const entry = modelDealEntry(record)
        assertEqual(
          typeof entry.free,
          "boolean",
          `${id}: modelDealEntry must always emit a boolean free flag`,
        )
      }
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
      // overContext must be present for Qwen 3.7 Plus etc, absent for MiniMax identical tier
      assert(
        out.includes("Qwen/Qwen3.7-Plus") && out.includes("overContext"),
        "Qwen 3.7 Plus must have overContext",
      )
      // count entries: should be 60+ from merged goat + pro slug records
      const entries = (out.match(/": \{ /g) ?? []).length
      assert(entries >= 55, `must emit 55+ entries, got ${entries}`)
    },
  ],
  [
    "emitDealsModuleFromRsc carries the RSC's planAllowanceUsd directly into MODEL_DEALS",
    () => {
      // The RSC's `planAllowanceUsd` is the source of truth for
      // per-model plan allowances — every paid model. The test pins
      // that data flows through: a model with allowance in the
      // compact array must surface in the output.
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
