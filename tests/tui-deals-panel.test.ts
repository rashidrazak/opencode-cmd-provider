// tests/tui-deals-panel.test.ts — deals sidebar panel data extraction
import { currentModelFor, dealsRows } from "../src/tui/index.js"
import { assertEqual, run } from "./harness.js"

run([
  [
    "extracts rows from a model with full deals data",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            tier: "premium",
            allowance: { goat: 40, pro: 60 },
            discount: { pct: 50, endsAt: "2026-12-31" },
            benchmark: { intelligence: 56, tokPerSec: 339 },
            free: false,
          },
        },
      })
      assertEqual(rows, [
        ["Tier", "premium"],
        ["goat allowance", "$40/mo"],
        ["pro allowance", "$60/mo"],
        ["Deal", "50% off until 2026-12-31"],
        ["Intelligence", "56"],
        ["Tok/s", "339"],
      ])
    },
  ],

  [
    "handles free models and peak/off-peak",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            free: true,
            peakOffPeak: { windows: "01-04 & 06-10 UTC" },
          },
        },
      })
      assertEqual(rows, [
        ["Status", "FREE"],
        ["Rates", "peak/off-peak (01-04 & 06-10 UTC)"],
      ])
    },
  ],

  [
    "returns an empty list when there is no cmd data",
    () => {
      assertEqual(dealsRows({ options: {} }), [])
      assertEqual(dealsRows(undefined), [])
      assertEqual(dealsRows({ options: { cmd: { free: false } } }), [])
    },
  ],

  [
    "currentModelFor picks the latest model-switched message over session.model",
    () => {
      const session = { model: { id: "claude-sonnet-5", providerID: "commandcode" } }
      const messages = [
        { type: "user" },
        { type: "model-switched", model: { id: "gpt-5.6-sol", providerID: "commandcode" } },
        { type: "model-switched", model: { id: "Qwen/Qwen3.8-27B", providerID: "commandcode" } },
      ] as never
      assertEqual(currentModelFor(session, messages as never), {
        id: "Qwen/Qwen3.8-27B",
        providerID: "commandcode",
      })
    },
  ],

  [
    "currentModelFor falls back to session.model when no switch happened",
    () => {
      const session = { model: { id: "claude-sonnet-5", providerID: "commandcode" } }
      assertEqual(currentModelFor(session, [{ type: "user" }] as never), {
        id: "claude-sonnet-5",
        providerID: "commandcode",
      })
      assertEqual(currentModelFor(undefined, [] as never), undefined)
    },
  ],
])
