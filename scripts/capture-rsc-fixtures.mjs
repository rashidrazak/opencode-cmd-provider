// scripts/capture-rsc-fixtures.mjs — refresh the committed RSC fixtures
// (tests/fixtures/rsc-{pricing-limits,goat,pro}.txt) from the live docs
// site. Runs at cron/human refresh time, never at runtime.
//
// Why this exists: the deals catalog, the coverage gate, and the unit
// tests all treat the committed fixtures as the offline source of truth,
// so the fixtures must move in lockstep with the live snapshot — the
// cron can never ship a PR that adds a snapshot model the fixtures don't
// carry (tests/refresh-deals.test.ts's coverage gate fails). This script
// is the missing half of that loop: the cron re-captures the fixtures
// from live, then regenerates the catalog from them (`refresh:deals
// -- --fixtures`), so fixtures, catalog, and tests stay consistent.
//
// Usage: node scripts/capture-rsc-fixtures.mjs [--fixtures-dir path]
//   --fixtures-dir  write the fixtures to this dir (default
//                   tests/fixtures). Test-only knob.
//   env COMMANDCODE_RSC_PRICING_URL   overrides the RSC pricing-limits URL
//   env COMMANDCODE_RSC_GOAT_URL      overrides the RSC goat plan URL
//   env COMMANDCODE_RSC_PRO_URL       overrides the RSC pro plan URL
//
// All-or-nothing: every payload is fetched before anything is written,
// and any failure (network, 4xx, 5xx) aborts with a non-zero exit and
// leaves the committed fixtures untouched — a partial fixture set would
// silently drop the TUI sidebar section for the missing models.
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  DEFAULT_RSC_GOAT_URL,
  DEFAULT_RSC_PRICING_URL,
  DEFAULT_RSC_PRO_URL,
} from "./refresh-deals.mjs"

const DEFAULT_FIXTURES_DIR = resolve(import.meta.dirname, "..", "tests", "fixtures")

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function fetchOrThrow(url, label) {
  let response
  try {
    response = await fetch(url, { headers: { rsc: "1" } })
  } catch (error) {
    throw new Error(
      `capture-rsc-fixtures: could not fetch RSC ${label} (${url}): ${error.message}`,
    )
  }
  if (!response.ok) {
    throw new Error(
      `capture-rsc-fixtures: RSC ${label} returned HTTP ${response.status} (${url}) — ` +
        `the docs route moved or a COMMANDCODE_RSC_*_URL override is wrong; refusing to ` +
        `overwrite the committed fixtures with a partial set`,
    )
  }
  return response.text()
}

async function main() {
  const fixturesDir = argValue("--fixtures-dir") ?? DEFAULT_FIXTURES_DIR
  const pricingUrl = process.env.COMMANDCODE_RSC_PRICING_URL ?? DEFAULT_RSC_PRICING_URL
  const goatUrl = process.env.COMMANDCODE_RSC_GOAT_URL ?? DEFAULT_RSC_GOAT_URL
  const proUrl = process.env.COMMANDCODE_RSC_PRO_URL ?? DEFAULT_RSC_PRO_URL
  const [pricing, goat, pro] = await Promise.all([
    fetchOrThrow(pricingUrl, "pricing-limits"),
    fetchOrThrow(goatUrl, "plans/goat"),
    fetchOrThrow(proUrl, "plans/pro"),
  ])
  await mkdir(fixturesDir, { recursive: true })
  const targets = [
    ["rsc-pricing-limits.txt", pricing],
    ["rsc-goat.txt", goat],
    ["rsc-pro.txt", pro],
  ]
  for (const [name, body] of targets) {
    await writeFile(resolve(fixturesDir, name), body, "utf-8")
  }
  for (const [name, body] of targets) {
    console.log(`capture-rsc-fixtures: wrote ${name} (${body.length} bytes)`)
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
