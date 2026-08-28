// scripts/tier-overrides.mjs — RSC `category` → snapshot `tier` overrides.
//
// The RSC's `category` field is the source of truth for whether a model
// is "premium" or "opensource" in the TUI sidebar. Command Code
// occasionally flips a model's category, and the sidebar's tier badge is
// a user-facing feature: a flip in the RSC isn't always a flip we want to
// ship immediately. This module is the one place the deals generator
// overrides upstream data — every entry here is reviewed on every release.
//
// **Override list last reviewed: 2026-08-28** (ticket #86 — see the
// wayfinder map at #78). The map was populated from the spec research
// at #77: 7 known disagreement points between the per-plan RSC pages
// and the pricing-limits RSC's availability array. When a new flip
// surfaces (e.g. the TUI sidebar's tier badge visibly disagrees with
// the RSC), add an entry here and update the "last reviewed" date in
// the commit message and this comment.
//
// Tickets #82 wires the call into refresh-deals.mjs; ticket #86 fills
// in the actual entries from the spec research. The override is the
// one "judgment" the deals generator makes — every other field is
// pass-through from the RSC.
//
// Why a snapshot-id key (not a slug id): the override has to survive
// the RSC's id renames. Records from `extractPlanPageRsc` already
// carry the aliased id (per `SLUG_ID_TO_SNAPSHOT_ID` in
// `scripts/parse-rsc.mjs`); records from `extractPricingLimitsRsc`
// carry the raw RSC id, so `applyTierOverride` re-applies the alias
// before the lookup. The result: an entry keyed by snapshot id works
// for records from either source.
import { applySlugIdAlias } from "./parse-rsc.mjs"

/**
 * The override map. Keys are snapshot ids (the form the deals catalog
 * uses); values are the tier the override forces. Review this list on
 * every release. New flips get added when the TUI badge visibly
 * disagrees with the RSC.
 *
 * The 7 entries below are the flips the spec research at #77
 * identified. All are pinned to `"opensource"` — the per-plan RSC
 * pages list them as opensource, but the pricing-limits availability
 * array either disagrees (gpt-5.6-luna, gpt-5.6-sol — listed as
 * premium in the current availability array) or lacks a `category`
 * field at all (gemini-3.7-flash, xai/grok-4.5, xai/grok-4.6,
 * meta/muse-spark-1.2, meta/muse-spark-1.2-contributor — not in the
 * availability array's 64-record set as of the committed fixtures).
 * The override pins the tier so a future RSC reshuffle can't flip
 * the TUI badge without a code change.
 *
 * @type {Record<string, "opensource" | "premium">}
 */
export const TIER_OVERRIDES = {
  "gpt-5.6-luna": "opensource",
  "gpt-5.6-sol": "opensource",
  "google/gemini-3.7-flash": "opensource",
  "xai/grok-4.5": "opensource",
  "xai/grok-4.6": "opensource",
  "meta/muse-spark-1.2": "opensource",
  "meta/muse-spark-1.2-contributor": "opensource",
}

/**
 * Returns the tier a record should carry in MODEL_DEALS. Pure: no I/O,
 * no mutation. When the record's snapshot id is in TIER_OVERRIDES, the
 * override wins; otherwise the RSC's `category` field is passed through
 * (mapped to `"opensource"` / `"premium"` / `undefined` to match the
 * ModelDeals `tier` field type).
 *
 * @param {Record<string, unknown>} record
 * @returns {"opensource" | "premium" | undefined}
 */
export function applyTierOverride(record) {
  if (!record || typeof record !== "object") return undefined
  // The override key is the snapshot id; records from extractPlanPageRsc
  // already carry the aliased id. Records from extractPricingLimitsRsc
  // carry the raw RSC id, so we apply the alias here too.
  const sid = typeof record.id === "string" ? applySlugIdAlias(record.id) : undefined
  if (sid && Object.prototype.hasOwnProperty.call(TIER_OVERRIDES, sid)) {
    return TIER_OVERRIDES[sid]
  }
  if (record.category === "premium") return "premium"
  if (record.category === "opensource") return "opensource"
  return undefined
}
