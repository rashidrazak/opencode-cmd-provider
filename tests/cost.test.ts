// tests/cost.test.ts — pricing table + cost calculation (PLAN #6, port of pi's
// test-cost.ts; locks arithmetic to pi-ai's calculateCost)
import { calculateCommandCodeCost } from "../src/provider/cost.js"
import { MODEL_COSTS } from "../src/provider/pricing.js"
import { assertEqual, run } from "./harness.js"

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
        {
          cost: MODEL_COSTS["deepseek/deepseek-v4-flash"] ?? {
            input: 0.14,
            output: 0.28,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
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
    "tiers select the highest threshold exceeded",
    () => {
      const rates = {
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 0,
        tiers: [
          { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0, inputTokensAbove: 200_000 },
        ],
      }
      const u = usage(300_000, 0, 0, 0)
      calculateCommandCodeCost({ cost: rates }, u)
      assertEqual(u.cost.input, 0.15)
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
