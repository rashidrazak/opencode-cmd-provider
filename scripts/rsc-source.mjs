// scripts/rsc-source.mjs — the shared RSC record source for the catalog
// generators (issue #109).
//
// Both the Deals generator (scripts/refresh-deals.mjs) and the reasoning
// classification generator (scripts/refresh-classification.mjs) read the
// Command Code docs' RSC slug/availability records. This module is the
// one place that owns:
//
//   - the page catalog (which RSC pages exist, their default URLs, their
//     env overrides, their committed fixture files),
//   - the ADR-0005 fetch ladder: 5xx / network failure → fall back to the
//     committed fixtures (transient); 4xx → fail loudly and write nothing
//     (a config error — the route moved or an override is wrong),
//   - page selection: a caller requests only the pages it consumes (the
//     classification generator needs the per-plan pages, not the
//     pricing-limits page — no extra network),
//   - the Snapshot-coverage gate ("a Snapshot model has no RSC record"),
//     exported so a second generator can reuse it without importing from
//     the Deals generator.
//
// The generators must not grow second copies of the ladder or the gate:
// drift between two copies of the fallback semantics is exactly the
// failure mode this prefactor exists to prevent.
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { snapshotIndex } from "./snapshot-index.mjs"

export const FIXTURES_DIR = resolve(import.meta.dirname, "..", "tests", "fixtures")

// The RSC flight payload rides the docs pages themselves: the live site
// serves `text/x-component` for `rsc: 1` requests to the same URLs the
// HTML pipeline fetched (verified 2026-08-28 — `/docs/rsc/*` is not a
// route).
//
// `env` is the historical override variable name (the refresh-deals CLI
// contract predates this module); `fixture` is the committed fixture file
// under tests/fixtures/ that serves as the offline source of truth.
export const RSC_PAGES = {
  pricing: {
    key: "pricing",
    label: "pricing-limits",
    defaultUrl: "https://commandcode.ai/docs/resources/pricing-limits",
    env: "COMMANDCODE_RSC_PRICING_URL",
    fixture: "rsc-pricing-limits.txt",
  },
  goat: {
    key: "goat",
    label: "plans/goat",
    defaultUrl: "https://commandcode.ai/docs/plans/goat",
    env: "COMMANDCODE_RSC_GOAT_URL",
    fixture: "rsc-goat.txt",
  },
  pro: {
    key: "pro",
    label: "plans/pro",
    defaultUrl: "https://commandcode.ai/docs/plans/pro",
    env: "COMMANDCODE_RSC_PRO_URL",
    fixture: "rsc-pro.txt",
  },
}

/**
 * @typedef {keyof typeof RSC_PAGES} RscPageKey
 */

// A 4xx from an RSC endpoint is a configuration error (route moved, or
// the COMMANDCODE_RSC_*_URL override is wrong) — it must surface loudly,
// never silently fall back to the fixtures. 5xx and network failures are
// transient and fall back per ADR-0005 (the fixtures are the offline
// source of truth for air-gapped runs).
export class RscHttpError extends Error {
  constructor(status, label, url) {
    super(
      `RSC ${label} returned HTTP ${status} (${url}) — the docs ` +
        `route moved or a COMMANDCODE_RSC_*_URL override is wrong; fix the URL, ` +
        `do not ship fixture data as if it were live`,
    )
    this.name = "RscHttpError"
    this.status = status
  }
}

/**
 * Reads the committed RSC fixtures for the requested pages. On a read
 * failure the ladder degrades to empty strings for every requested page
 * (the generators' empty-catalog path) with a loud warning — the same
 * behavior the Deals generator's private ladder had before the extract.
 *
 * @param {RscPageKey[]} keys
 * @param {{ fixturesDir?: string, prefix?: string }} [options]
 * @returns {Promise<Record<string, string>>} page key → RSC text ("" when unreadable)
 */
export async function readRscFixtures(
  keys,
  { fixturesDir = FIXTURES_DIR, prefix = "rsc-source" } = {},
) {
  /** @type {Record<string, string>} */
  const pages = {}
  try {
    await Promise.all(
      keys.map(async (key) => {
        pages[key] = await readFile(resolve(fixturesDir, RSC_PAGES[key].fixture), "utf-8")
      }),
    )
  } catch (error) {
    console.warn(
      `${prefix}: warning — could not read RSC fixtures (${error instanceof Error ? error.message : String(error)})`,
    )
    for (const key of keys) pages[key] = ""
  }
  return pages
}

/**
 * Fetches the requested pages live with the ADR-0005 semantics.
 * Per page: network failure → "" (logged); 5xx → "" (logged, transient);
 * 4xx → throws RscHttpError. Callers treat any "" as "transient failure —
 * fall back to the fixtures" (see loadRscPages).
 *
 * @param {RscPageKey[]} keys
 * @param {{ urls?: Record<string, string>, prefix?: string }} [options]
 * @returns {Promise<Record<string, string>>} page key → RSC text ("" on transient failure)
 */
export async function fetchRscPages(keys, { urls = {}, prefix = "rsc-source" } = {}) {
  /** @type {Record<string, string>} */
  const pages = {}
  await Promise.all(
    keys.map(async (key) => {
      const page = RSC_PAGES[key]
      const url = urls[key] ?? page.defaultUrl
      let response
      try {
        response = await fetch(url, { headers: { rsc: "1" } })
      } catch (error) {
        console.error(`${prefix}: could not fetch RSC ${page.label} (${url}): ${error.message}`)
        pages[key] = ""
        return
      }
      if (response.status >= 500) {
        console.error(
          `${prefix}: RSC ${page.label} returned ${response.status} — falling back to fixtures`,
        )
        pages[key] = ""
        return
      }
      if (!response.ok) {
        throw new RscHttpError(response.status, page.label, url)
      }
      pages[key] = await response.text()
    }),
  )
  return pages
}

/**
 * Resolves the RSC texts for the requested pages — the shared ladder.
 *
 *   mode "fixtures"  read the committed fixtures (offline truth; the
 *                    `--fixtures` flag and the cron's post-capture path).
 *   mode "live"      fetch each requested page; on ANY transient failure
 *                    (5xx / network, marked by "") fall back to the
 *                    committed fixtures for ALL requested pages — the
 *                    all-or-nothing semantics the Deals generator
 *                    established. A 4xx (RscHttpError) propagates: it is
 *                    a config error and nothing may be written.
 *
 * @param {{ keys: RscPageKey[], mode: "fixtures" | "live", urls?: Record<string, string>, fixturesDir?: string, prefix?: string }} args
 * @returns {Promise<Record<string, string>>} page key → RSC text
 */
export async function loadRscPages({ keys, mode, urls = {}, fixturesDir, prefix = "rsc-source" }) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(RSC_PAGES, key)) {
      throw new Error(
        `rsc-source: unknown RSC page "${String(key)}" (expected one of ${Object.keys(RSC_PAGES).join(", ")})`,
      )
    }
  }
  if (mode === "fixtures") {
    return readRscFixtures(keys, { fixturesDir, prefix })
  }
  let live
  try {
    live = await fetchRscPages(keys, { urls, prefix })
  } catch (error) {
    // A 4xx is a config error — fail loudly instead of silently
    // shipping fixture data. Only transient failures (5xx/network,
    // already converted to "") fall back.
    if (error instanceof RscHttpError) throw error
    console.warn(
      `${prefix}: warning — RSC live fetch threw (${error instanceof Error ? error.message : String(error)}) — falling back to RSC fixtures`,
    )
    live = {}
    for (const key of keys) live[key] = ""
  }
  const anyEmpty = keys.some((key) => !live[key])
  if (anyEmpty) {
    console.warn(`${prefix}: warning — RSC live fetch failed — falling back to RSC fixtures`)
    const fixtures = await readRscFixtures(keys, { fixturesDir, prefix })
    console.warn(`${prefix}: warning — using RSC fixtures for the generated catalog`)
    return fixtures
  }
  return live
}

/**
 * Snapshot-coverage gate: which Snapshot models have no RSC record.
 * `bySnapshotId` is the Map built by the generators' input builders (the
 * records are already snapshot-keyed by extractPlanPageRsc, which applies
 * the slug-id alias). A partial catalog silently drops the TUI sidebar
 * "Command Code" section for the missing models, so every generator that
 * emits a per-model module must fail loudly instead of emitting a partial
 * one. `--allow-partial`-style opt-outs live in the callers.
 *
 * Moved here from scripts/refresh-deals.mjs (issue #109) so the
 * classification generator can reuse it without importing from the Deals
 * generator.
 *
 * @param {Map<string, unknown>} bySnapshotId
 * @returns {{ missing: string[], covered: number }}
 */
export function missingSnapshotModels(bySnapshotId) {
  const { byId } = snapshotIndex()
  const present = new Set(bySnapshotId.keys())
  const missing = []
  for (const [id] of byId) {
    if (!present.has(id)) missing.push(id)
  }
  return { missing, covered: byId.size - missing.length }
}
