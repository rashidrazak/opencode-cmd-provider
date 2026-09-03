// tests/cost.test.ts — pricing table + cost calculation (PLAN #6, port of pi's
// test-cost.ts; locks arithmetic to pi-ai's calculateCost)
import { calculateCommandCodeCost, costUsageFromAiSdkUsage } from "../src/provider/cost.js"
import { MODEL_COSTS } from "../src/provider/pricing.js"
import { assertEqual, run } from "./harness.js"
import { assert } from "./harness.js"
import { MODEL_EFFORTS } from "../src/provider/reasoning.js"

// Any resolvable generated cost entry works as the arithmetic fixture — the
// pricing-lint gate (tests/no-upstream-value-pins.test.ts) forbids pinning a
// literal model id, so the id is derived from the generated facts at runtime.
const ARITHMETIC_MODEL_ID = Object.keys(MODEL_EFFORTS)[0] ?? "vendor/derived-fixture"
assert(MODEL_COSTS[ARITHMETIC_MODEL_ID], "the derived arithmetic fixture must have a cost entry")

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cacheWrite1h = 0,
) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

run([
  [
    "flat rates are applied per million tokens",
    () => {
      const u = usage(1_000_000, 500_000, 0, 0)
      calculateCommandCodeCost(
        { cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 } },
        u,
      )
      assertEqual(u.cost.input, 0.14)
      assertEqual(u.cost.output, 0.14)
      assertEqual(u.cost.total, 0.28)
    },
  ],

  [
    "cache reads use cacheRead rate",
    () => {
      const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }
      const u = usage(100_000, 0, 100_000, 0)
      calculateCommandCodeCost({ cost: rates }, u)
      assertEqual(u.cost.cacheRead, 0.01)
    },
  ],

  [
    "stream usage bills fresh input, cache read and cache write separately (issue #36)",
    () => {
      const u = costUsageFromAiSdkUsage({
        inputTokens: { total: 100_000, noCache: 40_000, cacheRead: 30_000, cacheWrite: 30_000 },
        outputTokens: { total: 50_000, text: 50_000, reasoning: 0 },
      })
      assertEqual(u.input, 40_000)
      assertEqual(u.output, 50_000)
      assertEqual(u.cacheRead, 30_000)
      assertEqual(u.cacheWrite, 30_000)
      calculateCommandCodeCost({ cost: { input: 1, output: 5, cacheRead: 0.5, cacheWrite: 3 } }, u)
      assertEqual(u.cost.input, 0.04)
      assertEqual(u.cost.output, 0.25)
      assertEqual(u.cost.cacheRead, 0.015)
      assertEqual(u.cost.cacheWrite, 0.09)
      assertEqual(u.cost.total, 0.395)
    },
  ],

  [
    "all models in MODEL_COSTS are parseable",
    () => {
      for (const [id, rates] of Object.entries(MODEL_COSTS)) {
        assertEqual(typeof rates.input, "number", id)
        assertEqual(typeof rates.output, "number", id)
        assertEqual(typeof rates.cacheRead, "number", id)
        assertEqual(typeof rates.cacheWrite, "number", id)
      }
    },
  ],
])
