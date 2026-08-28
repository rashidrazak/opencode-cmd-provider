// tests/tier-overrides.test.ts — seam: RSC `category` → `tier` override
// (the deals catalog's TUI-badge source of truth). The override list is
// the one place the deals generator (refresh-deals.mjs) overrides
// upstream data; every entry is reviewed on every release per the
// wayfinder spec at #77 / ticket #86. Tests pin the behavior of the
// 7 known flips and the no-override pass-through.
import { applyTierOverride, TIER_OVERRIDES } from "../scripts/tier-overrides.mjs"
import { assert, assertEqual, run } from "./harness.js"

run([
  [
    "TIER_OVERRIDES has the 7 entries from the spec research (wayfinder ticket #86)",
    () => {
      // The 7 known flips per the spec at #77 / the handoff notes.
      // If Command Code adds or removes a flip, the maintainer updates
      // this list in the same commit as the TIER_OVERRIDES change.
      assertEqual(TIER_OVERRIDES["gpt-5.6-luna"], "opensource")
      assertEqual(TIER_OVERRIDES["gpt-5.6-sol"], "opensource")
      assertEqual(TIER_OVERRIDES["google/gemini-3.7-flash"], "opensource")
      assertEqual(TIER_OVERRIDES["xai/grok-4.5"], "opensource")
      assertEqual(TIER_OVERRIDES["xai/grok-4.6"], "opensource")
      assertEqual(TIER_OVERRIDES["meta/muse-spark-1.2"], "opensource")
      assertEqual(TIER_OVERRIDES["meta/muse-spark-1.2-contributor"], "opensource")
      assertEqual(Object.keys(TIER_OVERRIDES).length, 7)
    },
  ],
  [
    "applyTierOverride: gpt-5.6-luna returns 'opensource' even when the RSC says 'premium'",
    () => {
      // The spec research found the pricing-limits availability
      // array lists gpt-5.6-luna as `premium`; the per-plan RSC
      // pages and the shipped catalog both list it as
      // `opensource`. The override pins the tier so a future RSC
      // reshuffle can't flip the TUI badge without a code change.
      const rscRecord = { id: "gpt-5.6-luna", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "opensource")
    },
  ],
  [
    "applyTierOverride: gpt-5.6-sol returns 'opensource' even when the RSC says 'premium'",
    () => {
      const rscRecord = { id: "gpt-5.6-sol", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "opensource")
    },
  ],
  [
    "applyTierOverride: google/gemini-3.7-flash returns 'opensource' when the RSC says 'premium'",
    () => {
      const rscRecord = { id: "google/gemini-3.7-flash", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "opensource")
    },
  ],
  [
    "applyTierOverride: xai/grok-4.5 returns 'opensource' when the RSC says 'premium'",
    () => {
      const rscRecord = { id: "xai/grok-4.5", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "opensource")
    },
  ],
  [
    "applyTierOverride: xai/grok-4.6 returns 'opensource' when the RSC says 'premium'",
    () => {
      const rscRecord = { id: "xai/grok-4.6", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "opensource")
    },
  ],
  [
    "applyTierOverride: meta/muse-spark-1.2 returns 'opensource' when the RSC says 'premium'",
    () => {
      const rscRecord = { id: "meta/muse-spark-1.2", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "opensource")
    },
  ],
  [
    "applyTierOverride: meta/muse-spark-1.2-contributor returns 'opensource' when the RSC says 'premium'",
    () => {
      const rscRecord = { id: "meta/muse-spark-1.2-contributor", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "opensource")
    },
  ],
  [
    "applyTierOverride: claude-fable-5 is a real premium model (no override) — returns 'premium'",
    () => {
      // claude-fable-5 is NOT in the override map. The function
      // must pass the RSC's category through unchanged, so a
      // `premium` record stays `premium`.
      const rscRecord = { id: "claude-fable-5", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "premium")
    },
  ],
  [
    "applyTierOverride: a non-overridden opensource model stays 'opensource' (pass-through)",
    () => {
      // Kimi K3 is an opensource model per the per-plan RSC and
      // isn't in the override map. The function must pass the
      // RSC's category through unchanged.
      const rscRecord = { id: "moonshotai/Kimi-K3", category: "opensource" }
      assertEqual(applyTierOverride(rscRecord), "opensource")
    },
  ],
  [
    "applyTierOverride: an unknown record (no id, no category) returns undefined",
    () => {
      // Defensive — a record that lacks both `id` and `category`
      // should return `undefined` (the function doesn't throw).
      assertEqual(applyTierOverride({}), undefined)
      assertEqual(applyTierOverride(null), undefined)
      assertEqual(applyTierOverride(undefined), undefined)
    },
  ],
  [
    "applyTierOverride: an unknown category (not premium or opensource) returns undefined",
    () => {
      // The function only passes through "premium" and
      // "opensource"; anything else is treated as "no category"
      // and returns undefined.
      const rscRecord = { id: "unknown-model", category: "experimental" }
      assertEqual(applyTierOverride(rscRecord), undefined)
    },
  ],
  [
    "applyTierOverride: applies the slug-id alias for records keyed by the raw RSC id",
    () => {
      // claude-haiku-4-5 is the RSC's id for the snapshot
      // claude-haiku-4-5-20251001 (per SLUG_ID_TO_SNAPSHOT_ID in
      // parse-rsc.mjs). The function re-applies the alias so the
      // override lookup works for records from either source
      // (extractPlanPageRsc returns snapshot-keyed records;
      // extractPricingLimitsRsc returns raw RSC-id records).
      // claude-haiku-4-5 is NOT in TIER_OVERRIDES, so the lookup
      // miss falls through to the category pass-through.
      const rscRecord = { id: "claude-haiku-4-5", category: "premium" }
      assertEqual(applyTierOverride(rscRecord), "premium")
    },
  ],
])
