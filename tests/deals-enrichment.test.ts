// tests/deals-enrichment.test.ts — enrichment + degradation contract
import { enrichCommandCodeModels, buildCmdOptions } from "../src/plugin/deals-enrichment.js"
import type { ModelDeals } from "../src/catalog/deals.js"
import { assertEqual, run } from "./harness.js"

const DEALS: Readonly<Record<string, ModelDeals>> = {
  "Qwen/Qwen3.8-27B": {
    allowance: { goat: 70 },
    benchmark: { intelligence: 52 },
    tier: "opensource",
    free: false,
  },
  "google/gemini-3.7-flash": {
    allowance: { goat: 40, pro: 60 },
    discount: { pct: 50, endsAt: "2026-12-31" },
    was: { input: 1.5, output: 7.5, cacheRead: 0.15 },
    peakOffPeak: {
      peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
      offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
      windows: "01-04 & 06-10 UTC",
    },
    overContext: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    benchmark: { intelligence: 56, tokPerSec: 339 },
    tier: "premium",
    free: false,
  },
}

run([
  [
    "enriches models with family and options.cmd",
    () => {
      const config = {
        provider: {
          commandcode: {
            models: {
              "Qwen/Qwen3.8-27B": { name: "Qwen", limit: { context: 262144, output: 65536 } },
              "google/gemini-3.7-flash": {
                name: "Gemini",
                limit: { context: 1000000, output: 65536 },
              },
              "unknown/foo": { name: "Foo", limit: { context: 16000, output: 4096 } },
            },
          },
        },
      } as const
      enrichCommandCodeModels(config as never, DEALS)
      const models = (
        config as never as {
          provider: { commandcode: { models: Record<string, Record<string, unknown>> } }
        }
      ).provider.commandcode.models

      const qwen = models["Qwen/Qwen3.8-27B"]
      assertEqual(qwen.family, "qwen")
      assertEqual(qwen.options, {
        cmd: {
          allowance: { goat: 70 },
          benchmark: { intelligence: 52 },
          tier: "opensource",
          free: false,
        },
      })

      const gemini = models["google/gemini-3.7-flash"]
      assertEqual(gemini.family, "gemini")
      assertEqual(gemini.options, {
        cmd: {
          allowance: { goat: 40, pro: 60 },
          discount: { pct: 50, endsAt: "2026-12-31" },
          was: { input: 1.5, output: 7.5, cacheRead: 0.15 },
          peakOffPeak: {
            peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
            offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
            windows: "01-04 & 06-10 UTC",
          },
          overContext: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
          benchmark: { intelligence: 56, tokPerSec: 339 },
          tier: "premium",
          free: false,
        },
      })
      assertEqual(gemini.cost, {
        context_over_200k: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0 },
      })

      const unknown = models["unknown/foo"]
      assertEqual(unknown.family, undefined, "unknown ids get no family")
      assertEqual(unknown.options, undefined, "unknown ids get no options")
    },
  ],

  [
    "never overwrites a user-declared family or options.cmd",
    () => {
      const config = {
        provider: {
          commandcode: {
            models: {
              "Qwen/Qwen3.8-27B": {
                name: "Qwen",
                limit: { context: 262144, output: 65536 },
                family: "custom",
                options: { cmd: { mine: true }, other: 1 },
              },
            },
          },
        },
      } as const
      enrichCommandCodeModels(config as never, DEALS)
      const qwen = (
        config as never as {
          provider: { commandcode: { models: Record<string, Record<string, unknown>> } }
        }
      ).provider.commandcode.models["Qwen/Qwen3.8-27B"]
      assertEqual(qwen.family, "custom")
      assertEqual(qwen.options, { cmd: { mine: true }, other: 1 })
    },
  ],

  [
    "empty deals still enriches family but leaves options untouched (degradation contract)",
    () => {
      const config = {
        provider: {
          commandcode: {
            models: {
              "Qwen/Qwen3.8-27B": { name: "Qwen", limit: { context: 262144, output: 65536 } },
              "unknown/foo": { name: "Foo", limit: { context: 16000, output: 4096 } },
            },
          },
        },
      } as const
      enrichCommandCodeModels(config as never, {})
      const models = (
        config as never as {
          provider: { commandcode: { models: Record<string, Record<string, unknown>> } }
        }
      ).provider.commandcode.models
      assertEqual(
        models["Qwen/Qwen3.8-27B"].family,
        "qwen",
        "family is vendor-derived, never from deals",
      )
      assertEqual(
        models["Qwen/Qwen3.8-27B"].options,
        undefined,
        "no options.cmd without deals entry",
      )
      assertEqual(
        models["unknown/foo"].family,
        undefined,
        "unknown ids get no family even with empty deals",
      )
      assertEqual(models["unknown/foo"].options, undefined)
    },
  ],

  [
    "absent provider entry is a no-op",
    () => {
      const config = { provider: {} }
      const baseline = JSON.parse(JSON.stringify(config))
      enrichCommandCodeModels(config as never, DEALS)
      assertEqual(config, baseline)
    },
  ],

  [
    "buildCmdOptions emits only present fields",
    () => {
      assertEqual(buildCmdOptions({ free: false }), { free: false })
      assertEqual(buildCmdOptions({ free: true, discount: { pct: 100 } }), {
        free: true,
        discount: { pct: 100 },
      })
    },
  ],
])
