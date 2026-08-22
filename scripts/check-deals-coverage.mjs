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

const root = resolve(import.meta.dirname, "..")
const snap = readFileSync(resolve(root, "src/catalog/snapshot.ts"), "utf-8")
const nameToId = new Map()
for (const m of snap.matchAll(/\{ id: "([^"]+)", name: "([^"]+)",/g)) nameToId.set(m[2], m[1])

const missing = []
for (const [name, id] of nameToId) {
  let covered = false
  for (const f of [
    "tests/fixtures/goat.html",
    "tests/fixtures/pro.html",
    "tests/fixtures/pricing-limits.html",
  ]) {
    const html = readFileSync(resolve(root, f), "utf-8")
    if ([...extractModelRecords(html).values()].some((r) => r.name === name)) {
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
