// scripts/capture-rsc-fixtures.mjs — refresh the committed RSC fixtures
// (tests/fixtures/rsc-{pricing-limits,goat,pro}.txt) plus the models-page
// index fixture (tests/fixtures/models-page.html) from the live Command
// Code site. Runs at cron/human refresh time, never at runtime.
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
// The models-page index fixture (issue #131) is the models page
// (`https://commandcode.ai/models`) — the HTML index table that is an
// enrichment source (rates, Context string, Caps bits, slug list). It is
// captured all-or-nothing alongside the RSC payloads; detail pages stay
// live-fetch-only and are never pinned (issue #129).
//
// Usage: node scripts/capture-rsc-fixtures.mjs [--fixtures-dir path]
//   --fixtures-dir  write the fixtures to this dir (default
//                   tests/fixtures). Test-only knob.
//   env COMMANDCODE_RSC_PRICING_URL   overrides the RSC pricing-limits URL
//   env COMMANDCODE_RSC_GOAT_URL      overrides the RSC goat plan URL
//   env COMMANDCODE_RSC_PRO_URL       overrides the RSC pro plan URL
//   env COMMANDCODE_MODELS_PAGE_URL   overrides the models page URL
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
const DEFAULT_MODELS_PAGE_URL = "https://commandcode.ai/models"

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function fetchOrThrow(url, label, { rscHeader = true } = {}) {
  let response
  try {
    // RSC payloads ride the docs pages with `rsc: 1`; the models page is
    // plain HTML (issue #131) and is fetched without it.
    response = await fetch(url, rscHeader ? { headers: { rsc: "1" } } : undefined)
  } catch (error) {
    throw new Error(`capture-rsc-fixtures: could not fetch ${label} (${url}): ${error.message}`)
  }
  if (!response.ok) {
    throw new Error(
      `capture-rsc-fixtures: ${label} returned HTTP ${response.status} (${url}) — ` +
        `the docs route moved or a COMMANDCODE_*_URL override is wrong; refusing to ` +
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
  const modelsPageUrl = process.env.COMMANDCODE_MODELS_PAGE_URL ?? DEFAULT_MODELS_PAGE_URL
  const [pricing, goat, pro, modelsPage] = await Promise.all([
    fetchOrThrow(pricingUrl, "RSC pricing-limits"),
    fetchOrThrow(goatUrl, "RSC plans/goat"),
    fetchOrThrow(proUrl, "RSC plans/pro"),
    fetchOrThrow(modelsPageUrl, "models page", { rscHeader: false }),
  ])
  await mkdir(fixturesDir, { recursive: true })
  const targets = [
    ["rsc-pricing-limits.txt", pricing],
    ["rsc-goat.txt", goat],
    ["rsc-pro.txt", pro],
    ["models-page.html", modelsPage],
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
