// scripts/tier-overrides.mjs — RSC `category` → snapshot `tier` overrides.
//
// The RSC's `category` field is the source of truth for whether a model
// is "premium" or "opensource" in the TUI sidebar. Command Code
// occasionally flips a model's category, and the sidebar's tier badge is
// a user-facing feature: a flip in the RSC isn't always a flip we want to
// ship immediately. This module is the one place the deals generator
// overrides upstream data — every entry here is reviewed on every release.
//
// Tickets #82 wires the call into refresh-deals.mjs; ticket #86 fills
// in the actual entries once the spec research lands them. Until #86
// ships, the map is empty and the function is an identity pass-through,
// so the RSC's `category` flows through unchanged.
import { applySlugIdAlias } from "./parse-rsc.mjs"

/**
 * The override map. Keys are snapshot ids (after the slug-id alias is
 * applied — i.e. the form the deals catalog uses); values are the tier
 * the override forces. Empty until #86 lands the eight known flips.
 *
 * @type {Record<string, "opensource" | "premium">}
 */
export const TIER_OVERRIDES = {}

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
