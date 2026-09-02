// tests/rsc-source.test.ts — seam: scripts/rsc-source.mjs, the shared RSC
// record source both catalog generators consume (issue #109). The module
// owns the ADR-0005 fetch ladder (5xx/network → committed fixtures; 4xx →
// loud failure, nothing written), the committed-fixture offline source,
// page selection (a caller requests only the pages it consumes), and the
// Snapshot-coverage gate. The Deals generator and the classification
// generator must not grow second copies of any of these.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { startMockCc } from "./helpers/mock-cc.js"
import {
  RSC_PAGES,
  RscHttpError,
  loadRscPages,
  missingSnapshotModels,
  readRscFixtures,
} from "../scripts/rsc-source.mjs"
import { snapshotIndex } from "../scripts/snapshot-index.mjs"
import { assert, assertEqual, run } from "./harness.js"

const RSC_PRICING = readFileSync(
  new URL("./fixtures/rsc-pricing-limits.txt", import.meta.url),
  "utf-8",
)
const RSC_GOAT = readFileSync(new URL("./fixtures/rsc-goat.txt", import.meta.url), "utf-8")
const RSC_PRO = readFileSync(new URL("./fixtures/rsc-pro.txt", import.meta.url), "utf-8")

run([
  [
    "loadRscPages fixtures mode reads exactly the requested pages",
    async () => {
      const pages = await loadRscPages({ keys: ["goat", "pro"], mode: "fixtures" })
      assertEqual(pages.goat, RSC_GOAT)
      assertEqual(pages.pro, RSC_PRO)
      assertEqual(pages.pricing, undefined, "unrequested pages must not be returned")
    },
  ],
  [
    "loadRscPages fixtures mode warns and returns empty strings when a fixture is unreadable",
    async () => {
      // A fixtures dir that does not exist stands in for the corrupted/
      // missing-fixture case; the ladder must degrade to empty strings
      // (the generators emit their empty-catalog path) instead of throwing.
      const dir = await mkdtemp(join(tmpdir(), "cc-rsc-source-"))
      try {
        const pages = await loadRscPages({
          keys: ["goat"],
          mode: "fixtures",
          fixturesDir: join(dir, "no-such-fixtures"),
        })
        assertEqual(pages.goat, "")
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
  [
    "loadRscPages live mode fetches only the requested pages",
    async () => {
      // The classification generator consumes the per-plan pages only;
      // the pricing-limits page must not be fetched (no extra network).
      const mock = await startMockCc({
        rscPricing: RSC_PRICING,
        rscGoat: RSC_GOAT,
        rscPro: RSC_PRO,
      })
      try {
        const pages = await loadRscPages({
          keys: ["goat", "pro"],
          mode: "live",
          urls: {
            goat: `${mock.url}/docs/plans/goat`,
            pro: `${mock.url}/docs/plans/pro`,
          },
        })
        assertEqual(pages.goat, RSC_GOAT)
        assertEqual(pages.pro, RSC_PRO)
        assertEqual(mock.hits.rscGoat, 1)
        assertEqual(mock.hits.rscPro, 1)
        assertEqual(
          mock.hits.rscPricing,
          0,
          "an unrequested page must not be fetched (hit counter stayed zero)",
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "loadRscPages live mode falls back to the committed fixtures on 5xx",
    async () => {
      const mock = await startMockCc({ rscStatus: 500 })
      try {
        const pages = await loadRscPages({
          keys: ["goat", "pro"],
          mode: "live",
          urls: {
            goat: `${mock.url}/docs/plans/goat`,
            pro: `${mock.url}/docs/plans/pro`,
          },
        })
        assertEqual(pages.goat, RSC_GOAT, "5xx must fall back to the committed goat fixture")
        assertEqual(pages.pro, RSC_PRO, "5xx must fall back to the committed pro fixture")
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "loadRscPages live mode falls back to the committed fixtures on a network failure",
    async () => {
      // A closed port = connection refused = transient network failure.
      const pages = await loadRscPages({
        keys: ["goat"],
        mode: "live",
        urls: { goat: "http://127.0.0.1:1/nope" },
      })
      assertEqual(pages.goat, RSC_GOAT)
    },
  ],
  [
    "loadRscPages live mode fails loudly on a 4xx (RscHttpError, nothing falls back)",
    async () => {
      // The mock returns 404 when an RSC body option is unset — a config
      // error, never masked by fixture data.
      const mock = await startMockCc({})
      try {
        let threw: unknown
        try {
          await loadRscPages({
            keys: ["goat"],
            mode: "live",
            urls: { goat: `${mock.url}/docs/plans/goat` },
          })
        } catch (error) {
          threw = error
        }
        assert(threw instanceof RscHttpError, `expected RscHttpError, got ${String(threw)}`)
        assert(
          /returned HTTP 404/.test((threw as Error).message),
          `error must name the status, got: ${(threw as Error).message}`,
        )
        assert(
          /plans\/goat/.test((threw as Error).message),
          `error must name the page label, got: ${(threw as Error).message}`,
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "loadRscPages live mode throws the 4xx even when other pages succeeded",
    async () => {
      // All-or-nothing: a 4xx on any requested page is a loud failure for
      // the whole load — a partially-live source must never be consumed.
      const mock = await startMockCc({ rscGoat: RSC_GOAT })
      try {
        let threw: unknown
        try {
          await loadRscPages({
            keys: ["goat", "pro"],
            mode: "live",
            urls: {
              goat: `${mock.url}/docs/plans/goat`,
              pro: `${mock.url}/docs/plans/pro`,
            },
          })
        } catch (error) {
          threw = error
        }
        assert(threw instanceof RscHttpError, `expected RscHttpError, got ${String(threw)}`)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "RSC_PAGES pins the page catalog: default URLs, env overrides, fixture files",
    () => {
      // The page table is the shared contract between the generators and
      // the capture script; a rename here would silently orphan one.
      assertEqual(Object.keys(RSC_PAGES).sort(), ["goat", "pricing", "pro"])
      assert(RSC_PAGES.pricing.defaultUrl.includes("/docs/resources/pricing-limits"))
      assert(RSC_PAGES.goat.defaultUrl.includes("/docs/plans/goat"))
      assert(RSC_PAGES.pro.defaultUrl.includes("/docs/plans/pro"))
      assertEqual(RSC_PAGES.pricing.env, "COMMANDCODE_RSC_PRICING_URL")
      assertEqual(RSC_PAGES.goat.env, "COMMANDCODE_RSC_GOAT_URL")
      assertEqual(RSC_PAGES.pro.env, "COMMANDCODE_RSC_PRO_URL")
      assertEqual(RSC_PAGES.pricing.fixture, "rsc-pricing-limits.txt")
      assertEqual(RSC_PAGES.goat.fixture, "rsc-goat.txt")
      assertEqual(RSC_PAGES.pro.fixture, "rsc-pro.txt")
    },
  ],
  [
    "readRscFixtures reads the committed fixtures verbatim",
    async () => {
      const pages = await readRscFixtures(["pricing", "goat", "pro"])
      assertEqual(pages.pricing, RSC_PRICING)
      assertEqual(pages.goat, RSC_GOAT)
      assertEqual(pages.pro, RSC_PRO)
    },
  ],
  [
    "missingSnapshotModels reports every snapshot id absent from the RSC records",
    () => {
      // Synthetic records: only two snapshot ids covered → the third is
      // named by the gate. (The gate reads the real snapshot index; any
      // two real ids stand in for "covered" here.)
      const kimi = "moonshotai/Kimi-K3"
      const flash = "deepseek/deepseek-v4-flash"
      const bySnapshotId = new Map([
        [kimi, {}],
        [flash, {}],
      ])
      const { missing, covered } = missingSnapshotModels(bySnapshotId)
      assertEqual(missing.length > 0, true, "the uncovered snapshot ids must be reported")
      assert(!missing.includes(kimi) && !missing.includes(flash), "covered ids must not be listed")
      assertEqual(covered, 2)
    },
  ],
  [
    "missingSnapshotModels reports zero missing when the records cover the snapshot",
    () => {
      // Cover every snapshot id with a synthetic record; the gate must
      // report no missing ids and count the coverage.
      const { byId } = snapshotIndex()
      const bySnapshotId = new Map([...byId.keys()].map((id) => [id, {}]))
      const { missing, covered } = missingSnapshotModels(bySnapshotId)
      assertEqual(missing, [])
      assertEqual(covered, byId.size)
    },
  ],
])
