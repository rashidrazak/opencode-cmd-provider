// tests/tui-deals-panel.test.ts — deals sidebar panel data extraction
import { dealsRows } from "../src/tui/index.js"
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
            was: { input: 1.5, output: 7.5 },
            now: { input: 0.75, output: 3.75 },
            benchmark: { intelligence: 56, tokPerSec: 339 },
            free: false,
          },
        },
      })
      assertEqual(rows, [
        ["Tier", "Premium"],
        ["GOAT allowance", "$40/mo"],
        ["Pro allowance", "$60/mo"],
        ["Deal", "50% off until 2026-12-31"],
        ["Was", "$1.5/$7.5 in/out"],
        ["Now", "$0.75/$3.75 in/out"],
        ["Intelligence", "56"],
        ["Tok/s", "339"],
      ])
    },
  ],

  [
    "displays open source tier name",
    () => {
      const rows = dealsRows({
        options: { cmd: { tier: "opensource", free: false } },
      })
      assertEqual(rows, [["Tier", "Open Source"]])
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
    "shows the section for every commandcode model — tier and benchmark are enough",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            tier: "premium",
            benchmark: { intelligence: 24.1, tokPerSec: 101.1 },
            free: false,
          },
        },
      })
      assertEqual(rows, [
        ["Tier", "Premium"],
        ["Intelligence", "24.1"],
        ["Tok/s", "101.1"],
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
    "handles discount without endsAt and tier case-insensitive",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            discount: { pct: 50 },
            tier: "premium",
            free: false,
          },
        },
      })
      assertEqual(rows, [
        ["Tier", "Premium"],
        ["Deal", "50% off"],
      ])
    },
  ],
  [
    "renders allowance for teampro via PLAN_CATALOG display",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            allowance: { teampro: 40 },
            free: false,
          },
        },
      })
      assertEqual(rows, [["Team Pro allowance", "$40/mo"]])
    },
  ],
])
