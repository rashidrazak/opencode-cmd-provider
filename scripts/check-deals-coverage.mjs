// scripts/check-deals-coverage.mjs — red-capable feedback loop: every
// snapshot model must have a deals record in the RSC fixtures, otherwise
// the TUI sidebar "Command Code" section silently renders nothing for that
// model. `refresh-deals.mjs` now enforces the same invariant natively (it
// aborts with exit 1 when snapshot models are missing from the RSC
// records), so this script doubles as a standalone pre-commit check.
// Run: node scripts/check-deals-coverage.mjs
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { extractPlanPageRsc, extractPricingLimitsRsc } from "./parse-rsc.mjs"
import { snapshotIndex } from "./snapshot-index.mjs"

const root = resolve(import.meta.dirname, "..")
const { byId } = snapshotIndex()

// RSC per-plan slug records are the source of truth for the snapshot id
// (extractPlanPageRsc applies the slug-id alias). The pricing-limits
// availability array is a secondary source for any models the per-plan
// pages missed. Union both sources so the gate matches the same set the
// refresh script's RSC path consumes.
const present = new Set()
for (const fixture of ["rsc-goat.txt", "rsc-pro.txt"]) {
  const text = readFileSync(resolve(root, "tests", "fixtures", fixture), "utf-8")
  for (const id of extractPlanPageRsc(text).keys()) {
    present.add(id)
  }
}
{
  const text = readFileSync(resolve(root, "tests", "fixtures", "rsc-pricing-limits.txt"), "utf-8")
  const { availability } = extractPricingLimitsRsc(text)
  for (const record of availability) {
    if (typeof record.id === "string") present.add(record.id)
  }
}

const missing = []
for (const [id] of byId) {
  if (!present.has(id)) missing.push(id)
}
if (missing.length > 0) {
  console.error("MISSING DEALS RECORDS:", missing.join(", "))
  process.exit(1)
}
console.log("OK — every snapshot model has a deals record")
