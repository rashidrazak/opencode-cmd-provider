// scripts/classification-overrides.mjs — per-model reasoning-capability
// overrides (issue #110, ADR-0006).
//
// Upstream-managed classification is **derived**: the reasoning flag on
// the RSC slug records is the source of truth, and no hand-maintained set
// duplicates it. This module is the only human seam — a pinned map used
// *only* when upstream's own surfaces contradict each other (e.g. the RSC
// flag says reasoning-capable while models.md's Efforts column and blurb
// say otherwise). Every entry carries a written justification naming the
// disagreement; a note-less entry is a loud generation-time failure, not
// a silent pin.
//
// **Override list last reviewed: 2026-09-03** (issue #110 — the map starts
// empty: the three-way audit on spec #108 found zero upstream
// self-contradictions across all 61 Snapshot models). When a disagreement
// surfaces, add an entry here and update the "last reviewed" date in the
// commit message and this comment. Active entries are rendered into the
// refresh PR body by the diff tool, so pinned judgment calls rot visibly.
//
// Why a snapshot-id key (not a slug id): the override has to survive the
// RSC's id renames, exactly like TIER_OVERRIDES in tier-overrides.mjs —
// records from `extractPlanPageRsc` already carry the aliased id.
//
// @type {Record<string, { capability: boolean, justification: string }>}
export const CLASSIFICATION_OVERRIDES = {}

/**
 * Validates the override map. Throws — loudly, naming the offending model
 * and the reason — when any entry lacks a boolean `capability` or a
 * non-empty written `justification`. Runs at generation time so a
 * note-less pin can never silently ship.
 *
 * @param {Record<string, { capability: unknown, justification: unknown }>} overrides
 */
export function validateClassificationOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") {
    throw new Error("classification-overrides: the override map must be an object")
  }
  for (const [id, entry] of Object.entries(overrides)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(
        `classification-overrides: ${id} — entry must be an object with { capability, justification }`,
      )
    }
    if (typeof entry.capability !== "boolean") {
      throw new Error(
        `classification-overrides: ${id} — capability must be a boolean (true = reasoning-capable), got ${JSON.stringify(entry.capability)}`,
      )
    }
    if (typeof entry.justification !== "string" || entry.justification.trim().length === 0) {
      throw new Error(
        `classification-overrides: ${id} — every override entry requires a written justification ` +
          `naming the upstream disagreement (the entry is rendered into the refresh PR body)`,
      )
    }
  }
}

/**
 * Returns the effective reasoning capability for a model: the override
 * wins when one exists; otherwise the upstream RSC flag passes through.
 * Pure: no I/O, no mutation.
 *
 * @param {string} id snapshot id
 * @param {boolean} upstreamCapability the record's `reasoning` flag
 * @param {Record<string, { capability: boolean, justification: string }>} [overrides]
 * @returns {boolean}
 */
export function applyClassificationOverride(
  id,
  upstreamCapability,
  overrides = CLASSIFICATION_OVERRIDES,
) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id].capability
  }
  return upstreamCapability
}
