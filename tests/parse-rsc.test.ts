// tests/parse-rsc.test.ts — seam: RSC text → typed records (the
// refresh-deals RSC path depends on this). Pure-function tests against
// the committed RSC text fixtures under tests/fixtures/rsc-*.txt.
import { readFileSync } from "node:fs"
import {
  applySlugIdAlias,
  extractPlanPageRsc,
  extractPricingLimitsRsc,
  missingFields,
  REQUIRED_AVAILABILITY_FIELDS,
  REQUIRED_COMPACT_FIELDS,
  REQUIRED_SLUG_RECORD_FIELDS,
  SLUG_ID_TO_SNAPSHOT_ID,
} from "../scripts/parse-rsc.mjs"
import { assert, assertEqual, run } from "./harness.js"

const RSC_PRICING = readFileSync(
  new URL("./fixtures/rsc-pricing-limits.txt", import.meta.url),
  "utf-8",
)
const RSC_GOAT = readFileSync(new URL("./fixtures/rsc-goat.txt", import.meta.url), "utf-8")
const RSC_PRO = readFileSync(new URL("./fixtures/rsc-pro.txt", import.meta.url), "utf-8")

run([
  [
    "extractPricingLimitsRsc returns the availability and compact arrays",
    () => {
      const { availability, compact } = extractPricingLimitsRsc(RSC_PRICING)
      assert(availability, "availability array must be present")
      assert(compact, "compact array must be present")
      assert(availability.length > 0, "availability must be non-empty")
      assert(compact.length > 0, "compact must be non-empty")
    },
  ],
  [
    "availability array has required fields for kimi-k3 (tiers[0].rates + caps.vision)",
    () => {
      const { availability } = extractPricingLimitsRsc(RSC_PRICING)
      const kimi = availability.find((r) => r.id === "kimi-k3")
      assert(kimi, "kimi-k3 must exist in availability")
      assertEqual(kimi.caps.vision, true)
      assertEqual(kimi.caps.text, true)
      // The spec example uses `glm-5.3-flash` (fictional) — pin the equivalent
      // shape on a real, currently-shipped model.
      assertEqual(kimi.tiers[0].rates.input, 3)
      assertEqual(kimi.tiers[0].rates.output, 15)
      assertEqual(kimi.tiers[0].rates.cacheRead, 0.3)
    },
  ],
  [
    "availability array has every required field on a known model",
    () => {
      const { availability } = extractPricingLimitsRsc(RSC_PRICING)
      const m = availability.find(
        (r) => r.tiers && r.tiers[0] && r.tiers[0].rates && r.tiers[0].rates.input > 0,
      )
      assert(m, "expected a paid model in availability with non-zero rates")
      const missing = missingFields(m, REQUIRED_AVAILABILITY_FIELDS)
      assertEqual(missing, [])
    },
  ],
  [
    "compact array has planAllowanceUsd with goat/pro for a known model",
    () => {
      const { compact } = extractPricingLimitsRsc(RSC_PRICING)
      const m = compact.find((r) => r.planAllowanceUsd)
      assert(m, "expected a compact record with planAllowanceUsd")
      const missing = missingFields(m, REQUIRED_COMPACT_FIELDS)
      assertEqual(missing, [])
      assert(typeof m.planAllowanceUsd.goat === "number", "goat allowance must be numeric")
      assert(typeof m.planAllowanceUsd.pro === "number", "pro allowance must be numeric")
    },
  ],
  [
    "extractPlanPageRsc returns goat/pro slug records keyed by snapshot id",
    () => {
      const goat = extractPlanPageRsc(RSC_GOAT)
      const pro = extractPlanPageRsc(RSC_PRO)
      assert(goat.size > 0, "goat slug records must be present")
      assert(pro.size > 0, "pro slug records must be present")
      // Vendor-prefixed free variants pass through unchanged, so at
      // least one Map key must still carry the `/` separator.
      const hasVendorPrefixed = [...goat.keys()].some((id) => id.includes("/"))
      assert(hasVendorPrefixed, "goat Map must contain at least one vendor-prefixed id")
      // Spot-check the shape contract on any record.
      const sample = goat.values().next().value
      assert(sample, "goat must have at least one record")
      const missing = missingFields(sample, REQUIRED_SLUG_RECORD_FIELDS)
      assertEqual(missing, [])
    },
  ],
  [
    "extractPlanPageRsc returns empty Map for an empty input",
    () => {
      const out = extractPlanPageRsc("")
      assertEqual(out.size, 0)
    },
  ],
  [
    "extractPricingLimitsRsc returns {} for input missing the arrays",
    () => {
      // Garbage text with no recognizable JSON arrays at all.
      const out = extractPricingLimitsRsc("no json here, just text")
      assertEqual(out.availability, undefined)
      assertEqual(out.compact, undefined)
    },
  ],
  [
    "missingFields returns the full list for a non-object record",
    () => {
      assertEqual(missingFields(null, ["a", "b"]), ["a", "b"])
      assertEqual(missingFields(undefined, ["a"]), ["a"])
      assertEqual(missingFields("not an object", ["a"]), ["a"])
    },
  ],
  [
    "missingFields returns empty when every field is present",
    () => {
      const m = { a: 1, b: 2, c: 3 }
      assertEqual(missingFields(m, ["a", "b", "c"]), [])
      // Extra fields in the record are allowed — only presence matters.
      assertEqual(missingFields(m, ["a"]), [])
    },
  ],
  [
    "shape-pinning: every required availability field is present on a real record",
    () => {
      // This is the "fails loudly if schema changes" test. If Command Code
      // renames or drops any of the fields the deals catalog depends on,
      // this test will start failing and the cron will not silently ship
      // bad data.
      const { availability } = extractPricingLimitsRsc(RSC_PRICING)
      const sample = availability.find((r) => r.tiers && r.tiers[0] && r.tiers[0].rates)
      assert(sample, "expected a paid model in availability")
      for (const field of REQUIRED_AVAILABILITY_FIELDS) {
        assert(
          sample[field] !== undefined,
          `availability record must still carry field ${field} (schema change?)`,
        )
      }
    },
  ],
  [
    "REQUIRED_SLUG_RECORD_FIELDS pins the reasoning flag (derived classification source)",
    () => {
      // The classification generator (scripts/refresh-classification.mjs)
      // reads the per-model `reasoning` flag off every slug record. The
      // flag joins the required-fields pin so an upstream rename or drop
      // is a loud shape failure — never a silent default-to-non-reasoning
      // (spec #108, user story 14).
      assert(
        REQUIRED_SLUG_RECORD_FIELDS.includes("reasoning"),
        "reasoning must be a required slug-record field",
      )
    },
  ],
  [
    "applySlugIdAlias maps claude-haiku-4-5 to the date-suffixed snapshot id",
    () => {
      // The snapshot ships `claude-haiku-4-5-20251001`; the RSC's slug
      // records carry the unsuffixed `claude-haiku-4-5`. The alias map
      // closes that gap so the deals catalog can join RSC records to
      // snapshot ids without a second pass.
      assertEqual(SLUG_ID_TO_SNAPSHOT_ID["claude-haiku-4-5"], "claude-haiku-4-5-20251001")
      assertEqual(applySlugIdAlias("claude-haiku-4-5"), "claude-haiku-4-5-20251001")
    },
  ],
  [
    "applySlugIdAlias leaves un-aliased ids unchanged (vendor prefix preserved)",
    () => {
      // Free variants and vendor-prefixed ids must pass through
      // untouched — the alias map only covers known date-suffixed
      // mismatches, never rewrites the id structure.
      assertEqual(applySlugIdAlias("poolside/laguna-s-2.1-free"), "poolside/laguna-s-2.1-free")
      assertEqual(applySlugIdAlias("MiniMaxAI/MiniMax-M3"), "MiniMaxAI/MiniMax-M3")
      assertEqual(applySlugIdAlias("kimi-k3"), "kimi-k3")
    },
  ],
  [
    "extractPlanPageRsc keys the goat Map by the snapshot id (claude-haiku alias applied)",
    () => {
      const goat = extractPlanPageRsc(RSC_GOAT)
      // The RSC's id is `claude-haiku-4-5`; after applying the alias the
      // Map must expose it under the snapshot id `claude-haiku-4-5-20251001`.
      assert(
        goat.has("claude-haiku-4-5-20251001"),
        "goat Map must expose claude-haiku under the snapshot id",
      )
      assert(
        !goat.has("claude-haiku-4-5"),
        "goat Map must NOT expose the raw RSC id (would re-introduce the mismatch)",
      )
      const record = goat.get("claude-haiku-4-5-20251001")
      assert(record, "snapshot-keyed record must be retrievable")
      assertEqual(record.id, "claude-haiku-4-5-20251001", "record.id must be the snapshot id")
    },
  ],
  [
    "extractPlanPageRsc leaves vendor-prefixed free variants untouched (no alias)",
    () => {
      const goat = extractPlanPageRsc(RSC_GOAT)
      // poolside/laguna-s-2.1-free is the free variant; the alias map
      // never strips the vendor prefix. The Map must still expose it
      // under its raw RSC id.
      assert(
        goat.has("poolside/laguna-s-2.1-free"),
        "goat Map must expose the free variant under its raw RSC id",
      )
      const record = goat.get("poolside/laguna-s-2.1-free")
      assert(record, "free-variant record must be retrievable")
      assertEqual(record.id, "poolside/laguna-s-2.1-free", "free-variant id must not be rewritten")
    },
  ],
])
