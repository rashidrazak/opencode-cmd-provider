// scripts/check-deals-coverage.mjs — subset + pending report (issue #132).
//
// Deals are a SUBSET of membership since issue #132: every snapshot model
// without a deals record ships core-only (enrichment skipped) with a
// visible pending report — never an exit-1. This script mirrors the
// refresh script's native pending report as a standalone check:
//
//   - snapshot models with no RSC/deals record print as a pending report
//     and exit 0 (the models are usable; enrichment just has nothing to
//     attach yet).
//
// The resolution must mirror the refresh script's RSC path (buildRscInputs
// in scripts/refresh-deals.mjs): the per-plan slug records are keyed by
// snapshot id (extractPlanPageRsc applies the slug-id alias), and the
// pricing-limits availability array resolves by NAME to a snapshot id (its
// raw ids are unprefixed — "kimi-k3", "glm-5.3" — and only count once they
// resolve). Unresolvable availability names and non-snapshot slug records
// are docs-ahead skew: the refresh drops them by design (emitting nothing
// for them is the correct subset behavior), so they are never reported as
// stale here. The emitted-side subset property (MODEL_DEALS ⊆
// MODEL_SNAPSHOT, and no stale entries) is pinned by
// tests/deals-coverage.test.ts.
//
// Run: node scripts/check-deals-coverage.mjs
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { extractPlanPageRsc, extractPricingLimitsRsc } from "./parse-rsc.mjs"
import { snapshotIndex } from "./snapshot-index.mjs"

const root = resolve(import.meta.dirname, "..")
const { byId, byName } = snapshotIndex()

// The set of SNAPSHOT ids that have a deals-capable RSC record — built the
// same way refresh-deals.mjs's RSC path builds its inputs:
//   - per-plan slug records (goat/pro) are already snapshot-keyed;
//   - pricing-limits availability records resolve by NAME to a snapshot id;
//     a name that does not resolve is docs-ahead skew (dropped by the
//     refresh too), never a stale record.
const covered = new Set()
for (const fixture of ["rsc-goat.txt", "rsc-pro.txt"]) {
  const text = readFileSync(resolve(root, "tests", "fixtures", fixture), "utf-8")
  for (const id of extractPlanPageRsc(text).keys()) {
    covered.add(id)
  }
}
{
  const text = readFileSync(resolve(root, "tests", "fixtures", "rsc-pricing-limits.txt"), "utf-8")
  const { availability } = extractPricingLimitsRsc(text)
  for (const record of availability) {
    const name = record?.name
    if (typeof name !== "string" || name.length === 0) continue
    const sid = byName.get(name)
    if (sid !== undefined && byId.has(sid)) covered.add(sid)
  }
}

// Pending report: snapshot models with no deals record ship core-only.
const missing = []
for (const [id] of byId) {
  if (!covered.has(id)) missing.push(id)
}
if (missing.length > 0) {
  console.log(
    `DEALS PENDING — ${missing.length} snapshot model(s) ship core-only (no RSC record): ${missing.join(", ")}`,
  )
  console.log(
    "OK — deals remain a subset of membership; pending models skip enrichment (issue #132).",
  )
} else {
  console.log("OK — every snapshot model has a deals record")
}
