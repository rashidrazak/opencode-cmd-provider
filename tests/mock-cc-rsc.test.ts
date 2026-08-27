// tests/mock-cc-rsc.test.ts — seam: tests/helpers/mock-cc.ts RSC endpoints.
// Verifies the in-process mock Command Code server serves the three RSC
// endpoints under the correct paths, returns 404 when the option is
// unset, and exposes a hit counter per endpoint. Future integration
// tests for the RSC-primary refresh-deals path (#82) consume these
// endpoints against the committed `tests/fixtures/rsc-*.txt` fixtures.
import { readFileSync } from "node:fs"
import { startMockCc } from "./helpers/mock-cc.js"
import { assert, assertEqual, run } from "./harness.js"

const RSC_PRICING = readFileSync(
  new URL("./fixtures/rsc-pricing-limits.txt", import.meta.url),
  "utf-8",
)
const RSC_GOAT = readFileSync(new URL("./fixtures/rsc-goat.txt", import.meta.url), "utf-8")
const RSC_PRO = readFileSync(new URL("./fixtures/rsc-pro.txt", import.meta.url), "utf-8")

run([
  [
    "RSC endpoints return 404 when the corresponding option is unset",
    async () => {
      const mock = await startMockCc()
      try {
        for (const path of [
          "/docs/rsc/pricing-limits",
          "/docs/rsc/plans/goat",
          "/docs/rsc/plans/pro",
        ]) {
          const res = await fetch(`${mock.url}${path}`)
          assertEqual(res.status, 404, `${path} must be 404 when option unset`)
        }
        // Hits ARE incremented on a 404 — the route counts the request
        // attempt, matching the existing whoami endpoint pattern
        // (`tests/provider-transport.test.ts` asserts `mock.hits.whoami`
        // == 1 after a 404). The fall-through path uses these counters
        // to detect "the request reached the mock", not "the mock
        // returned a useful body".
        assertEqual(mock.hits.rscPricing, 1)
        assertEqual(mock.hits.rscGoat, 1)
        assertEqual(mock.hits.rscPro, 1)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "RSC endpoints serve the configured body with the flight-payload content-type",
    async () => {
      const mock = await startMockCc({
        rscPricing: RSC_PRICING,
        rscGoat: RSC_GOAT,
        rscPro: RSC_PRO,
      })
      try {
        for (const [path, expected] of [
          ["/docs/rsc/pricing-limits", RSC_PRICING],
          ["/docs/rsc/plans/goat", RSC_GOAT],
          ["/docs/rsc/plans/pro", RSC_PRO],
        ] as const) {
          const res = await fetch(`${mock.url}${path}`, {
            headers: { rsc: "1" },
          })
          assertEqual(res.status, 200, `${path} must be 200 when option set`)
          // Next.js RSC payloads arrive with `text/x-component` (the
          // docs site serves the same content-type for RSC: 1 requests).
          const ct = res.headers.get("content-type") ?? ""
          assert(
            ct.includes("text/x-component"),
            `${path} content-type must be text/x-component, got ${ct}`,
          )
          const body = await res.text()
          assertEqual(body, expected, `${path} must echo the configured body`)
        }
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "RSC endpoints increment hit counters after one request each",
    async () => {
      const mock = await startMockCc({
        rscPricing: RSC_PRICING,
        rscGoat: RSC_GOAT,
        rscPro: RSC_PRO,
      })
      try {
        await fetch(`${mock.url}/docs/rsc/pricing-limits`)
        await fetch(`${mock.url}/docs/rsc/plans/goat`)
        await fetch(`${mock.url}/docs/rsc/plans/pro`)
        assertEqual(mock.hits.rscPricing, 1)
        assertEqual(mock.hits.rscGoat, 1)
        assertEqual(mock.hits.rscPro, 1)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "RSC endpoints pass the rsc: 1 request header through to onRsc* callbacks",
    async () => {
      const seenPricing: Array<Record<string, string>> = []
      const seenGoat: Array<Record<string, string>> = []
      const seenPro: Array<Record<string, string>> = []
      const mock = await startMockCc({
        rscPricing: RSC_PRICING,
        rscGoat: RSC_GOAT,
        rscPro: RSC_PRO,
        onRscPricing: (h) => seenPricing.push(h),
        onRscGoat: (h) => seenGoat.push(h),
        onRscPro: (h) => seenPro.push(h),
      })
      try {
        await fetch(`${mock.url}/docs/rsc/pricing-limits`, { headers: { rsc: "1" } })
        await fetch(`${mock.url}/docs/rsc/plans/goat`, { headers: { rsc: "1" } })
        await fetch(`${mock.url}/docs/rsc/plans/pro`, { headers: { rsc: "1" } })
        assertEqual(seenPricing.length, 1)
        assertEqual(seenGoat.length, 1)
        assertEqual(seenPro.length, 1)
        // Headers are lowercased by the runtime; check the rsc value.
        assertEqual(seenPricing[0].rsc, "1")
        assertEqual(seenGoat[0].rsc, "1")
        assertEqual(seenPro[0].rsc, "1")
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "RSC endpoint hits do not affect other endpoint counters",
    async () => {
      const mock = await startMockCc({
        rscPricing: RSC_PRICING,
        rscGoat: RSC_GOAT,
        rscPro: RSC_PRO,
      })
      try {
        await fetch(`${mock.url}/docs/rsc/pricing-limits`)
        await fetch(`${mock.url}/docs/rsc/plans/goat`)
        await fetch(`${mock.url}/docs/rsc/plans/pro`)
        // Other endpoints were not touched.
        assertEqual(mock.hits.generate, 0)
        assertEqual(mock.hits.models, 0)
        assertEqual(mock.hits.chatCompletions, 0)
        assertEqual(mock.hits.messages, 0)
        assertEqual(mock.hits.whoami, 0)
      } finally {
        await mock.close()
      }
    },
  ],
])
