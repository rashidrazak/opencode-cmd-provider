// scripts/extract-rsc-fixtures.mjs — one-off helper: derive the RSC text
// fixtures from the current HTML fixtures and write them under
// tests/fixtures/rsc-*.txt. Run when the docs site moves to a new RSC
// shape; the resulting text files are the source of truth for offline
// runs of the parser and the integration tests.
//
// The RSC payload the live docs site returns is the JSON arrays we
// already see in the HTML flight payload, in their un-escaped form. We
// wrap each array in a minimal flight-payload-like text snippet (so the
// parser's decodeEscapedJson step is exercised against a realistic input)
// and write that to disk.

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { extractPlanPageRsc, extractPricingLimitsRsc } from "./parse-rsc.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(__dirname, "..", "tests", "fixtures")

function escapeForFlight(value) {
  // Wrap a JSON value in the same escape rules the flight payload uses, so
  // the resulting text is round-trippable through decodeEscapedJson.
  const json = JSON.stringify(value)
  return json.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function writeFixture(name, body) {
  const path = resolve(fixturesDir, name)
  writeFileSync(path, body, "utf-8")
  console.log(`wrote ${name} (${body.length} bytes)`)
}

const pricingHtml = readFileSync(resolve(fixturesDir, "pricing-limits.html"), "utf-8")
const goatHtml = readFileSync(resolve(fixturesDir, "goat.html"), "utf-8")
const proHtml = readFileSync(resolve(fixturesDir, "pro.html"), "utf-8")

const { availability, compact } = extractPricingLimitsRsc(pricingHtml)
if (!availability) throw new Error("could not locate availability array in pricing-limits fixture")
if (!compact) throw new Error("could not locate compact array in pricing-limits fixture")

const goatRecords = extractPlanPageRsc(goatHtml)
const proRecords = extractPlanPageRsc(proHtml)
if (goatRecords.size === 0) throw new Error("could not locate slug records array in goat fixture")
if (proRecords.size === 0) throw new Error("could not locate slug records array in pro fixture")

// Wrap each payload in a small flight-payload-like envelope. The wrapper
// is just decorative — the parser scans for top-level `[` — but it makes
// the fixture look like a real RSC response and exercises the escape
// decode path. The pricing-limits fixture carries both arrays as a single
// envelope (the docs page embeds them together); the per-plan fixtures
// carry just the slug records.
const wrap = (label, value) =>
  `1:HL["// command-code docs RSC payload",${JSON.stringify(label)}]\n` +
  escapeForFlight(value) +
  `\n`

writeFixture("rsc-pricing-limits.txt", wrap("pricing-limits", { availability, compact }))
writeFixture("rsc-goat.txt", wrap("plans/goat", [...goatRecords.values()]))
writeFixture("rsc-pro.txt", wrap("plans/pro", [...proRecords.values()]))
