// scripts/check-deals-coverage.mjs — red-capable feedback loop: every
// snapshot model must have a deals record in the docs fixtures, otherwise the
// TUI sidebar "Command Code" section silently renders nothing for that model.
// `refresh-deals.mjs` now enforces the same invariant natively (it aborts with
// exit 1 when snapshot models are missing from the scraped records), so this
// script doubles as a standalone pre-commit check.
// Run: node scripts/check-deals-coverage.mjs
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { extractModelRecords } from "./parse-docs.mjs"
import { snapshotIndex } from "./snapshot-index.mjs"

const root = resolve(import.meta.dirname, "..")
const { byId, nameCounts } = snapshotIndex()

const missing = []
for (const [id, name] of byId) {
  let covered = false
  for (const f of [
    "tests/fixtures/goat.html",
    "tests/fixtures/pro.html",
    "tests/fixtures/pricing-limits.html",
  ]) {
    const html = readFileSync(resolve(root, f), "utf-8")
    const records = [...extractModelRecords(html).values()]
    // Match by id first: free variants share display names with their paid
    // siblings (MiniMax M3 / M2.7) but carry unique ids, so only an id match
    // proves the right docs record exists. The name fallback applies only to
    // unambiguous names (legacy id mismatches like claude-haiku-4-5 docs →
    // claude-haiku-4-5-20251001 snapshot).
    if (
      records.some((r) => r.id === id) ||
      (nameCounts.get(name) === 1 && records.some((r) => r.name === name))
    ) {
      covered = true
      break
    }
  }
  if (!covered) missing.push(id)
}
if (missing.length > 0) {
  console.error("MISSING DEALS RECORDS:", missing.join(", "))
  process.exit(1)
}
console.log("OK — every snapshot model has a deals record")
