// tests/tui-deals-panel.test.ts — deals sidebar panel data extraction and the
// two host contracts (v1 `tui(api)` slot map, v2 `setup(context)` slot claim),
// plus the appended live `Usage` segment's wiring (issue #244) and the
// completed-turn adapters each half subscribes through (issue #245).
import plugin, {
  dealsRows,
  dealsRowsV2,
  manageUsagePanel,
  panelRows,
  subscribeV1Idle,
  subscribeV2Idle,
  v1ModelFor,
  v1UsageInput,
  v2ModelFor,
  v2ThemeColors,
} from "../src/deals/tui.js"
import type { DealsRow } from "../src/deals/tui.js"
import { createUsagePanel, type UsagePanel, type UsagePanelState } from "../src/deals/tui-usage.js"
import { createUsageRpcLoader } from "../src/deals/usage-rpc.js"
import { createRoot } from "solid-js"
import type { Provider } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { V2TuiContext, V2TuiSlotClaim, V2TuiTheme } from "../src/plugin/v2-tui-types.js"
import { assertEqual, assert, run } from "./harness.js"

const NA = "N/A"

/** The render clock the usage fixtures pin their countdowns against. */
const NOW = Date.parse("2026-10-01T12:00:00.000Z")

/** A live reset 4h32m out, in milliseconds (above the seconds-heuristic floor). */
const RESET_AT = NOW + (4 * 60 + 32) * 60_000

/** Five days out, so the monthly meter's renewal suffix is exactly `5d`. */
const PERIOD_END = NOW + 5 * 86_400_000

/**
 * One published usage state as the panel's controller hands it over: the three
 * meters (with a countdown and a renewal, so `panelRows`'s `now` is
 * load-bearing) and the host rung's provenance.
 */
function usageState(): UsagePanelState {
  return {
    result: {
      state: "usage",
      snapshot: {
        limited: true,
        fiveHour: { used: 0.5, cap: 3, exceeded: false },
        weekly: { used: 1.5, cap: 6, exceeded: false, resetAt: RESET_AT },
        monthly: { used: 39.5, cap: 40 },
        periodEnd: PERIOD_END,
      },
    },
    provenance: { kind: "host" },
  }
}

/** PLAN_CATALOG display names the Allowance segment renders, in order. */
const PLAN_LABELS = ["Go", "GOAT", "Pro", "Max 10×", "Max 20×", "Team Pro"]

/** The rows under the `Other Information` heading: deal and benchmark data. */
const TAIL_LABELS = ["Deal", "Was", "Now", "Intelligence", "Tok/s"]

/** The column line every rate block prints. */
const COLUMNS = "in | out | cache r | w"

/**
 * The placeholder under `Rates` for a model with no published band and no host
 * cost (the synthetic models in this suite): the column line, then `N/A`.
 */
const NO_RATES: DealsRow[] = [
  [COLUMNS, "", "value"],
  [NA, "", "value"],
]

/**
 * The fixed segmented shape: Tier/Status, a blank line, the `Allowance` heading
 * over one row per rendered plan, a blank line, the `Rates` heading over the
 * band block (`rates`, defaulting to the no-cost price fallback), a blank line,
 * then the `Other Information` heading over the deal/benchmark rows — every
 * value from `values` (or `N/A`).
 */
function fixedRows(values: Record<string, string>, rates: DealsRow[] = NO_RATES): DealsRow[] {
  const valueRow = (label: string): DealsRow => [label, values[label] ?? NA]
  return [
    valueRow("Tier"),
    valueRow("Status"),
    ["", ""],
    ["Allowance", "", "heading"],
    ...PLAN_LABELS.map(valueRow),
    ["", ""],
    ["Rates", "", "heading"],
    ...rates,
    ["", ""],
    ["Other Information", "", "heading"],
    ...TAIL_LABELS.map(valueRow),
  ]
}

/**
 * Pins the whole fixed row set — banner first when the Deals catalog is
 * unavailable — so every label appears exactly once, in segment order.
 */
function assertFixedRows(
  rows: DealsRow[],
  values: Record<string, string>,
  options: { banner?: string; rates?: DealsRow[] } = {},
): void {
  const expected = fixedRows(values, options.rates)
  if (options.banner !== undefined) expected.unshift([options.banner, ""])
  assertEqual(rows, expected)
}

const row = (rows: DealsRow[], label: string): DealsRow | undefined =>
  rows.find(([key]) => key === label)

/** A 33-cell meter bar: `full` whole cells, one half cell, dots, then the cap. */
function bar(full: number, half = 0): string {
  return `${"█".repeat(full)}${half === 1 ? "▌" : ""}${"·".repeat(32 - full - half)}▏`
}

/** The meter detail row under `label`'s label row (label, bar, detail). */
function meterDetail(rows: DealsRow[], label: string): DealsRow | undefined {
  const index = rows.findIndex(([name]) => name === label)
  return index === -1 ? undefined : rows[index + 2]
}

run([
  [
    "renders the full fixed row set for a model with full deals data",
    () => {
      const rows = dealsRows(
        {
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
        },
        "2026-09-22",
      )
      assertFixedRows(rows, {
        Tier: "Premium",
        Status: "Paid",
        GOAT: "$40/mo",
        Pro: "$60/mo",
        Deal: "50% off until 2026-12-31",
        Was: "$1.5/$7.5 in/out",
        Now: "$0.75/$3.75 in/out",
        Intelligence: "56",
        "Tok/s": "339",
      })
    },
  ],

  [
    "segments the panel: Tier/Status, blank, Allowance heading + plans, blank, Rates, blank, Other Information",
    () => {
      const rows = dealsRows({
        options: { cmd: { allowance: { goat: 20 }, free: false } },
      })
      assertEqual(rows.slice(0, 4), [
        ["Tier", NA],
        ["Status", "Paid"],
        ["", ""],
        ["Allowance", "", "heading"],
      ])
      assertEqual(rows.slice(4, 10), [
        ["Go", NA],
        ["GOAT", "$20/mo"],
        ["Pro", NA],
        ["Max 10×", NA],
        ["Max 20×", NA],
        ["Team Pro", NA],
      ])
      assertEqual(rows.slice(10), [
        ["", ""],
        ["Rates", "", "heading"],
        [COLUMNS, "", "value"],
        [NA, "", "value"],
        ["", ""],
        ["Other Information", "", "heading"],
        ["Deal", NA],
        ["Was", NA],
        ["Now", NA],
        ["Intelligence", NA],
        ["Tok/s", NA],
      ])
    },
  ],

  [
    "renders every row even with nothing in the payload — N/A for all",
    () => {
      // A Command Code model the catalog has no deals entry for: the panel
      // stays visible, every row reads N/A.
      assertFixedRows(dealsRows({ options: {} }), {})
      assertFixedRows(dealsRows({ options: { cmd: {} } }), {})
      // `free: false` is data, not absence: the Status row reads Paid.
      assertFixedRows(dealsRows({ options: { cmd: { free: false } } }), { Status: "Paid" })
      // No model at all (no selected model to speak of) is the panel's gate.
      assertEqual(dealsRows(undefined), [])
    },
  ],

  [
    "Status reads FREE for free models, Unknown renders N/A",
    () => {
      assertEqual(row(dealsRows({ options: { cmd: { free: true } } }), "Status"), [
        "Status",
        "FREE",
      ])
      // A missing/unknown free flag has nothing to report.
      assertEqual(row(dealsRows({ options: { cmd: {} } }), "Status"), ["Status", NA])
    },
  ],

  [
    "rounds binary-float residue in deal rates",
    () => {
      // Upstream computes discounted rates in JS (`6 × 0.6`), so the captured
      // RSC rates carry residue like `output: 3.5999999999999996` (the
      // grok-4.7 40% deal). The panel renders what is paid, not the raw float.
      const rows = dealsRows(
        {
          options: {
            cmd: {
              discount: { pct: 40, endsAt: "2026-09-27" },
              was: { input: 2, output: 6 },
              now: { input: 1.2, output: 3.5999999999999996 },
              free: false,
            },
          },
        },
        "2026-09-22",
      )
      assertEqual(row(rows, "Deal"), ["Deal", "40% off until 2026-09-27"])
      assertEqual(row(rows, "Was"), ["Was", "$2/$6 in/out"])
      assertEqual(row(rows, "Now"), ["Now", "$1.2/$3.6 in/out"])
    },
  ],

  [
    "an ended deal reads as ended instead of claiming an until-date (issue #90)",
    () => {
      // The catalog keeps `endsAt` verbatim — upstream still lists the deal
      // after its date passes (Qwen 3.7 Max's expired 2026-06-22 discount
      // survives every refresh). The panel, not the catalog, is where the
      // date's passing becomes visible, and the `was`/`now` rates stay:
      // they describe what is billed, expired deal metadata or not.
      const cmd = {
        discount: { pct: 25, endsAt: "2026-05-01" },
        was: { input: 4, output: 12 },
        now: { input: 3, output: 9 },
        free: false,
      }
      const dealRow = (today: string) => row(dealsRows({ options: { cmd } }, today), "Deal")
      assertEqual(dealRow("2026-04-30"), ["Deal", "25% off until 2026-05-01"])
      // The named day is still a live deal: upstream expires at 23:59:59Z of it.
      assertEqual(dealRow("2026-05-01"), ["Deal", "25% off until 2026-05-01"])
      assertEqual(dealRow("2026-05-02"), ["Deal", "25% off (ended 2026-05-01)"])
      assertEqual(row(dealsRows({ options: { cmd } }, "2026-05-02"), "Was"), [
        "Was",
        "$4/$12 in/out",
      ])
      assertEqual(row(dealsRows({ options: { cmd } }, "2026-05-02"), "Now"), [
        "Now",
        "$3/$9 in/out",
      ])
      // v2's surface shares the one rule (the host split is ADR-0010's, not
      // the formatter's).
      assertEqual(
        row(
          dealsRowsV2(
            { settings: { cmd: { discount: { pct: 25, endsAt: "2026-05-01" }, free: false } } },
            "2026-05-02",
          ),
          "Deal",
        ),
        ["Deal", "25% off (ended 2026-05-01)"],
      )
      // A non-ISO `endsAt` has no date to compare and keeps the historic
      // phrasing. No catalog entry carries one today (a free deal yields no
      // `discount` object at all), so this pins the pass-through only.
      assertEqual(
        row(
          dealsRows(
            {
              options: {
                cmd: { discount: { pct: 50, endsAt: "while capacity lasts" }, free: false },
              },
            },
            "2026-05-02",
          ),
          "Deal",
        ),
        ["Deal", "50% off until while capacity lasts"],
      )
    },
  ],

  [
    "renders already-clean deal rates unchanged",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            was: { input: 0.435, output: 0.87 },
            now: { input: 1.2, output: 3.6 },
            free: false,
          },
        },
      })
      assertEqual(row(rows, "Was"), ["Was", "$0.435/$0.87 in/out"])
      assertEqual(row(rows, "Now"), ["Now", "$1.2/$3.6 in/out"])
    },
  ],

  [
    "displays open source tier name",
    () => {
      const rows = dealsRows({
        options: { cmd: { tier: "opensource", free: false } },
      })
      assertEqual(row(rows, "Tier"), ["Tier", "Open Source"])
    },
  ],

  [
    "handles free models and peak/off-peak windows",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            free: true,
            peakOffPeak: { windows: "01-04 & 06-10 UTC" },
          },
        },
      })
      assertEqual(row(rows, "Status"), ["Status", "FREE"])
      assertEqual(row(rows, "Rates"), ["Rates", "", "heading"])
      // The band labels carry the column line; the values line is bare.
      assertEqual(row(rows, "Peak"), ["Peak", COLUMNS])
      assertEqual(row(rows, "Off-peak"), ["Off-peak", COLUMNS])
      assertEqual(row(rows, "Peak Windows"), ["Peak Windows", "", "value"])
      assertEqual(row(rows, "01-04 & 06-10 UTC"), ["01-04 & 06-10 UTC", "", "value"])
      // A free model has no allowances: every plan row reads N/A rather than
      // vanishing.
      for (const plan of PLAN_LABELS) {
        assertEqual(row(rows, plan), [plan, NA])
      }
    },
  ],

  [
    "renders the peak/off-peak bands with all four rates and the windows",
    () => {
      assertFixedRows(
        dealsRows({
          options: {
            cmd: {
              free: false,
              peakOffPeak: {
                peak: { input: 0.32, output: 1.16, cacheRead: 0.032, cacheWrite: 0 },
                offPeak: { input: 0.16, output: 0.58, cacheRead: 0.016, cacheWrite: 0 },
                windows: "01–04 & 06–10 UTC, Mon–Fri",
              },
            },
          },
        }),
        { Status: "Paid" },
        {
          rates: [
            ["Peak", COLUMNS],
            ["$0.32 | $1.16 | $0.032 | $0", "", "value"],
            ["", ""],
            ["Off-peak", COLUMNS],
            ["$0.16 | $0.58 | $0.016 | $0", "", "value"],
            ["", ""],
            ["Peak Windows", "", "value"],
            ["01–04 & 06–10 UTC, Mon–Fri", "", "value"],
          ],
        },
      )
    },
  ],

  [
    "renders every context-window band under Rates",
    () => {
      assertFixedRows(
        dealsRows({
          options: {
            cmd: {
              free: false,
              contextTiers: [
                {
                  label: "Standard",
                  context: "≤ 272K",
                  rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
                },
                {
                  label: "Long context",
                  context: "> 272K",
                  rates: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
                },
              ],
            },
          },
        }),
        { Status: "Paid" },
        {
          rates: [
            ["≤ 272K", COLUMNS],
            ["$2 | $10 | $0.2 | $2.5", "", "value"],
            ["", ""],
            ["> 272K", COLUMNS],
            ["$4 | $15 | $0.4 | $5", "", "value"],
          ],
        },
      )
    },
  ],

  [
    "Rates merges both band types; malformed rows read N/A and labelless bands are skipped",
    () => {
      assertFixedRows(
        dealsRows({
          options: {
            cmd: {
              free: false,
              peakOffPeak: { peak: { input: 1 }, windows: "01–04" },
              contextTiers: [
                { rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
                { context: "≤ 32K", rates: { input: 0.03, output: 0.13 } },
              ],
            },
          },
        }),
        { Status: "Paid" },
        {
          rates: [
            ["Peak", COLUMNS],
            [NA, "", "value"],
            ["", ""],
            ["Off-peak", COLUMNS],
            [NA, "", "value"],
            ["", ""],
            ["Peak Windows", "", "value"],
            ["01–04", "", "value"],
            ["", ""],
            ["≤ 32K", COLUMNS],
            [NA, "", "value"],
          ],
        },
      )
    },
  ],

  [
    "renders the full row set for every commandcode model — tier and benchmark are enough",
    () => {
      assertFixedRows(
        dealsRows({
          options: {
            cmd: {
              tier: "premium",
              benchmark: { intelligence: 24.1, tokPerSec: 101.1 },
              free: false,
            },
          },
        }),
        {
          Tier: "Premium",
          Status: "Paid",
          Intelligence: "24.1",
          "Tok/s": "101.1",
        },
      )
    },
  ],

  [
    "a half-filled benchmark renders the missing metric as N/A",
    () => {
      const rows = dealsRows({ options: { cmd: { benchmark: { intelligence: 24.1 } } } })
      assertEqual(row(rows, "Intelligence"), ["Intelligence", "24.1"])
      assertEqual(row(rows, "Tok/s"), ["Tok/s", NA])
    },
  ],

  [
    "handles discount without endsAt",
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
      assertEqual(row(rows, "Tier"), ["Tier", "Premium"])
      assertEqual(row(rows, "Deal"), ["Deal", "50% off"])
    },
  ],

  [
    "renders the truncated plan set under Allowance; unknown keys and hidden plans are not rows",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            allowance: { goat: 40, teampro: 40 },
            free: false,
          },
        },
      })
      assertFixedRows(rows, {
        Status: "Paid",
        GOAT: "$40/mo",
        "Team Pro": "$40/mo",
      })
      // Pro (legacy) and Provider keep their catalog rows and their payload
      // data — the plan-summary tool and the transport still read them — but
      // they are never rendered: an allowance keyed to them changes nothing.
      assertFixedRows(
        dealsRows({
          options: { cmd: { allowance: { prolegacy: 15, provider: 15 }, free: false } },
        }),
        { Status: "Paid" },
      )
      // The row set is the catalog's displayed plan vocabulary — unknown keys
      // are not rows either.
      const unknown = dealsRows({ options: { cmd: { allowance: { custom: 5 }, free: false } } })
      assertFixedRows(unknown, { Status: "Paid" })
    },
  ],

  [
    "falls back to the model's actual price when no rate band is published",
    () => {
      // Both hosts hand the panel the model cost they bill against: v1 keeps
      // one record per model, v2 an array whose untiered entry is the base
      // price. With no band in the payload the cost fills the Rates block.
      const cost = { input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }
      const rates: DealsRow[] = [
        [COLUMNS, "", "value"],
        ["$0.15 | $0.6 | $0.003 | $0", "", "value"],
      ]
      assertFixedRows(
        dealsRows({ options: { cmd: { free: false } }, cost }),
        { Status: "Paid" },
        { rates },
      )
      assertFixedRows(
        dealsRowsV2({ settings: { cmd: { free: false } }, cost: [cost] }),
        { Status: "Paid" },
        { rates },
      )
      // A published band wins over the base price: the fallback never
      // double-prints.
      assertFixedRows(
        dealsRows({
          options: {
            cmd: {
              free: false,
              peakOffPeak: {
                peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
                offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
                windows: "01–04 & 06–10 UTC, Mon–Fri",
              },
            },
          },
          cost,
        }),
        { Status: "Paid" },
        {
          rates: [
            ["Peak", COLUMNS],
            ["$0.3 | $1.2 | $0.006 | $0", "", "value"],
            ["", ""],
            ["Off-peak", COLUMNS],
            ["$0.15 | $0.6 | $0.003 | $0", "", "value"],
            ["", ""],
            ["Peak Windows", "", "value"],
            ["01–04 & 06–10 UTC, Mon–Fri", "", "value"],
          ],
        },
      )
      // A record with only tiered entries has no base price: N/A, never a
      // tier's rate read as the base.
      assertFixedRows(
        dealsRowsV2({
          settings: { cmd: { free: false } },
          cost: [{ tier: { type: "context", size: 200000 }, ...cost }],
        }),
        { Status: "Paid" },
      )
    },
  ],

  [
    "shows the unavailable banner with the full N/A row set when catalog is empty",
    () => {
      assertFixedRows(
        dealsRows({ options: { cmd: { unavailable: true } } }),
        {},
        {
          banner: unavailable(),
        },
      )
    },
  ],

  [
    "unavailable takes precedence over normal deal data",
    () => {
      assertFixedRows(
        dealsRows({
          options: {
            cmd: {
              unavailable: true,
              tier: "premium",
              allowance: { goat: 40 },
              benchmark: { intelligence: 56 },
              free: false,
            },
          },
        }),
        {},
        { banner: unavailable() },
      )
    },
  ],

  // ---------------------------------------------------------------------------
  // v2 host: the enrichment writes the model's provider options to `settings`
  // (ADR-0010), and the panel is claimed through `ctx.ui.slot` on the
  // dot-separated `"sidebar.content"` path. Shipping only the v1
  // half made the v2 host reject the module and the sidebar never appeared.
  // ---------------------------------------------------------------------------

  [
    "v2: reads cmd from the model's settings bag, not v1's options",
    () => {
      const cmd = {
        tier: "premium",
        allowance: { pro: 60 },
        benchmark: { intelligence: 56, tokPerSec: 339 },
        free: false,
      }
      assertFixedRows(dealsRowsV2({ settings: { cmd } }), {
        Tier: "Premium",
        Status: "Paid",
        Pro: "$60/mo",
        Intelligence: "56",
        "Tok/s": "339",
      })
      // v1's bag is not v2's bag: an `options.cmd` payload must not render.
      const v1Bag = dealsRowsV2({ settings: { options: { cmd } } })
      assertFixedRows(v1Bag, {})
      // A v2 model without a payload still renders the full N/A row set.
      assertFixedRows(dealsRowsV2({}), {})
      assertEqual(dealsRowsV2(undefined), [])
    },
  ],
  [
    "v2: model lookup resolves the selected Command Code model and hides other providers",
    () => {
      const cmd = { tier: "premium", free: false }
      const cost = [{ input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }]
      const models = [
        {
          id: "claude-sonnet-5",
          modelID: "claude-sonnet-5",
          providerID: "commandcode",
          settings: { cmd },
          cost,
        },
        { id: "gpt-6", modelID: "gpt-6", providerID: "opencode" },
      ]
      const data = (model?: { id: string; providerID: string }) =>
        ({
          session: { get: () => ({ id: "ses_1", model }) },
          location: { model: { list: () => models } },
        }) as unknown as V2TuiContext["data"]

      const found = v2ModelFor(data({ id: "claude-sonnet-5", providerID: "commandcode" }), "ses_1")
      assertEqual(found?.settings?.["cmd"], cmd)
      // The host cost rides along for the Rates price fallback.
      assertEqual(found?.cost, cost)
      // Selecting another provider's model hides the panel.
      assertEqual(v2ModelFor(data({ id: "gpt-6", providerID: "opencode" }), "ses_1"), undefined)
      // A Command Code model missing from the catalog still renders the full
      // N/A row set rather than disappearing.
      const missing = v2ModelFor(data({ id: "new-model", providerID: "commandcode" }), "ses_1")
      assertEqual(missing, {})
      assertFixedRows(dealsRowsV2(missing), {})
      // An unknown session renders nothing.
      assertEqual(
        v2ModelFor(
          {
            session: { get: () => undefined },
            location: { model: { list: () => models } },
          } as never,
          "ses_1",
        ),
        undefined,
      )
    },
  ],
  [
    "v2: resolves both theme spellings across the 2.0.8 rename — text and feedback",
    () => {
      // @opencode/theme@2.0.8 renamed the 2.0.3 `text.default`/`text.subdued`
      // pair to `text.base`/`text.muted` — and the same pair on the
      // `text.feedback` colours the usage bars read. A v2.0.x host exposes
      // exactly one spelling, and reading only the absent pair leaves `fg`
      // undefined — which renders as the terminal default, the plain-white
      // sidebar on 2.0.8+.
      const base = { r: 1, g: 2, b: 3, a: 255 }
      const muted = { r: 4, g: 5, b: 6, a: 255 }
      const green = { r: 7, g: 8, b: 9, a: 255 }
      const yellow = { r: 10, g: 11, b: 12, a: 255 }
      const red = { r: 13, g: 14, b: 15, a: 255 }
      const theme = (text: object) => ({ text }) as unknown as V2TuiTheme
      const expected = { text: base, muted, success: green, warning: yellow, error: red }
      assertEqual(
        v2ThemeColors(
          theme({
            base,
            muted,
            feedback: {
              success: { base: green, muted: green },
              warning: { base: yellow, muted: yellow },
              error: { base: red, muted: red },
            },
          }),
        ),
        expected,
      )
      assertEqual(
        v2ThemeColors(
          theme({
            default: base,
            subdued: muted,
            feedback: {
              success: { default: green, subdued: green },
              warning: { default: yellow, subdued: yellow },
              error: { default: red, subdued: red },
            },
          }),
        ),
        expected,
      )
    },
  ],
  [
    "v1: model lookup resolves the selected Command Code model and hides other providers",
    () => {
      const cmd = { tier: "premium", free: false }
      const cost = { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }
      const providers = [
        { id: "commandcode", models: { "claude-sonnet-5": { options: { cmd }, cost } } },
        { id: "opencode", models: { "gpt-6": {} } },
      ] as unknown as readonly Provider[]
      const found = v1ModelFor(providers, { id: "claude-sonnet-5", providerID: "commandcode" })
      assertEqual(found?.options?.["cmd"], cmd)
      // The host cost rides along for the Rates price fallback.
      assertEqual(found?.cost, cost)
      // Selecting another provider's model hides the panel.
      assertEqual(v1ModelFor(providers, { id: "gpt-6", providerID: "opencode" }), undefined)
      assertEqual(v1ModelFor(providers, undefined), undefined)
      // A Command Code model missing from the provider record still renders the
      // full N/A row set rather than disappearing.
      const missing = v1ModelFor(providers, { id: "new-model", providerID: "commandcode" })
      assertEqual(missing, {})
      assertFixedRows(dealsRows(missing), {})
    },
  ],
  // ---------------------------------------------------------------------------
  // The live `Usage` segment (issue #244): appended below the fixed rows from
  // the panel's mount chain. The chain's fetch counts and retention rules are
  // pinned in tests/tui-usage.test.ts; here the panel's composition and both
  // halves' live credential inputs are.
  // ---------------------------------------------------------------------------

  [
    "the panel appends the Usage segment below the fixed rows",
    () => {
      const deals = dealsRows({ options: { cmd: { free: false } } })
      const rows = panelRows(deals, usageState(), NOW)
      // The fixed rows are untouched and in front...
      assertEqual(rows.slice(0, deals.length), deals)
      // ...and the segment follows the last fixed row.
      assert(
        rows.findIndex(([label]) => label === "Usage") >
          rows.findIndex(([label]) => label === "Tok/s"),
        "the Usage heading must come after every fixed row",
      )
      assertEqual(rows[deals.length], ["", ""])
      assertEqual(rows[deals.length + 1], ["Usage", "", "heading"])
      assertEqual(rows.slice(deals.length), [
        ["", ""],
        ["Usage", "", "heading"],
        ["5-hour", "", "value"],
        [bar(5, 1), " 17%", "bar", "success"],
        ["$0.50 / $3.00", "", "value"],
        ["", ""],
        ["Weekly", "", "value"],
        [bar(8), " 25%", "bar", "success"],
        ["$1.50 / $6.00 · 4h 32m", "", "value"],
        ["", ""],
        ["Monthly", "", "value"],
        [bar(31, 1), " 99%", "bar", "error"],
        ["$39.50 / $40.00 · 5d", "", "value"],
      ])
    },
  ],

  [
    "before the first load settles the panel shows the fixed rows only",
    () => {
      // An undefined state is "the mount chain is still in flight", not the
      // resolver's miss: no notice may flash while the fetch is pending.
      const deals = dealsRows({ options: { cmd: {} } })
      assertEqual(panelRows(deals, undefined, NOW), deals)
    },
  ],

  [
    "each Usage degradation renders its line below the fixed rows",
    () => {
      const deals = dealsRows({ options: { cmd: {} } })
      const cases: Array<[UsagePanelState, string]> = [
        [
          { result: { state: "no-credential" } },
          "Usage needs COMMANDCODE_API_KEY — set it to see live limits",
        ],
        [
          { result: { state: "unavailable" } },
          "Usage unavailable — could not read the Command Code billing API",
        ],
      ]
      for (const [state, line] of cases) {
        const rows = panelRows(deals, state, NOW)
        assertEqual(rows.slice(0, deals.length), deals)
        assertEqual(rows[deals.length + 1], ["Usage", "", "heading"])
        assertEqual(rows[deals.length + 2], [line, "", "value"])
      }
    },
  ],

  [
    "the panel stays hidden for non-Command Code models, with or without usage",
    () => {
      for (const state of [undefined, usageState()]) {
        assertEqual(panelRows(dealsRows(undefined), state, NOW), [])
        assertEqual(panelRows([], state, NOW), [])
      }
    },
  ],

  [
    "the v1 usage input reads the live host state",
    () => {
      const providers = [{ id: "commandcode", key: "k" }] as unknown as readonly Provider[]
      const client = { provider: { list: async () => ({}) } }
      const api = { state: { provider: providers }, client } as unknown as TuiPluginApi
      assertEqual(v1UsageInput(api), { host: "v1", providers, client })
      // The v2 half has no local resolver anymore: its chain is the RPC bridge,
      // pinned by tests/usage-rpc.test.ts.
    },
  ],

  [
    "v1 idle adapter: only the watched session's session.idle wakes the panel",
    () => {
      const handlers: Array<(event: { properties: { sessionID: string } }) => void> = []
      let offs = 0
      const api = {
        event: {
          on: (_type: string, handler: (event: { properties: { sessionID: string } }) => void) => {
            handlers.push(handler)
            return () => {
              offs += 1
            }
          },
        },
      } as unknown as TuiPluginApi
      const notified: string[] = []
      const unsubscribe = subscribeV1Idle(
        api,
        () => "ses_1",
        () => notified.push("turn"),
      )
      assertEqual(handlers.length, 1, "one session.idle subscription")
      handlers[0]!({ properties: { sessionID: "ses_2" } })
      assertEqual(notified, [], "another session's turn is not this panel's")
      handlers[0]!({ properties: { sessionID: "ses_1" } })
      assertEqual(notified, ["turn"])
      unsubscribe()
      assertEqual(offs, 1, "the bus subscription is torn down")
    },
  ],

  [
    "v2 idle adapter: both turn events for the watched session wake the panel",
    () => {
      const handlers = new Map<string, Array<(event: { data: { sessionID: string } }) => void>>()
      let offs = 0
      const data = {
        on: (_type: string, handler: (event: { data: { sessionID: string } }) => void) => {
          handlers.set(_type, [...(handlers.get(_type) ?? []), handler])
          return () => {
            offs += 1
          }
        },
      } as unknown as V2TuiContext["data"]
      const notified: string[] = []
      const unsubscribe = subscribeV2Idle(
        { data } as unknown as V2TuiContext,
        () => "ses_1",
        () => notified.push("turn"),
      )
      assertEqual(
        [...handlers.keys()].sort(),
        ["session.execution.succeeded", "session.idle"],
        "both turn events are subscribed",
      )
      handlers.get("session.idle")![0]!({ data: { sessionID: "ses_other" } })
      handlers.get("session.execution.succeeded")![0]!({ data: { sessionID: "ses_other" } })
      assertEqual(notified, [], "another session's turn is not this panel's")
      handlers.get("session.idle")![0]!({ data: { sessionID: "ses_1" } })
      handlers.get("session.execution.succeeded")![0]!({ data: { sessionID: "ses_1" } })
      assertEqual(notified, ["turn", "turn"])
      unsubscribe()
      assertEqual(offs, 2, "both data-store subscriptions are torn down")
    },
  ],

  [
    "the shared panel lifecycle tears down the subscription and the panel on unmount",
    () => {
      // `manageUsagePanel` is the one lifecycle both host halves bind (#245):
      // disposal must unsubscribe the idle signal and unmount the panel (its
      // clock, trailing timer and in-flight chain are the panel's own teardown).
      let offs = 0
      let unmounts = 0
      const stub: UsagePanel = {
        state: () => undefined,
        mount: async () => {},
        refresh: async () => {},
        turnCompleted: () => {},
        unmount: () => {
          unmounts += 1
        },
      }
      const dispose = createRoot((dispose) => {
        manageUsagePanel(stub, () => () => {
          offs += 1
        })
        return dispose
      })
      dispose()
      assertEqual(offs, 1, "the idle subscription is torn down with the panel")
      assertEqual(unmounts, 1, "the panel is unmounted with the slot")
    },
  ],

  [
    "v1: a visible panel's mount chain feeds the appended segment",
    async () => {
      const providers = [
        {
          id: "commandcode",
          key: "v1_key",
          models: { "claude-sonnet-5": { options: { cmd: { free: false } } } },
        },
      ] as unknown as readonly Provider[]
      const api = {
        state: {
          provider: providers,
          session: {
            get: () => ({
              id: "ses_1",
              model: { id: "claude-sonnet-5", providerID: "commandcode" },
            }),
          },
        },
        client: { provider: { list: async () => ({}) } },
      } as unknown as TuiPluginApi
      // The v1 chain runs the real loader shape; its credential plumbing
      // (`Bearer v1_key`) is pinned in tests/tui-usage.test.ts, so this panel
      // composition test stubs the outcome.
      const panel = createUsagePanel(async () => usageState())
      await panel.mount()
      const model = v1ModelFor(providers, { id: "claude-sonnet-5", providerID: "commandcode" })
      const rows = panelRows(dealsRows(model), panel.state(), NOW)
      assertEqual(row(rows, "Status"), ["Status", "Paid"])
      assertEqual(meterDetail(rows, "5-hour"), ["$0.50 / $3.00", "", "value"])
      // The unmount cancels the panel's countdown clock — a live timer that
      // would otherwise keep the test runner alive.
      panel.unmount()
    },
  ],

  [
    "v2: a visible panel's mount chain feeds the appended segment through the RPC bridge",
    async () => {
      const data = {
        session: {
          get: () => ({
            id: "ses_1",
            model: { id: "claude-sonnet-5", providerID: "commandcode" },
          }),
        },
        location: {
          model: {
            list: () => [
              {
                id: "claude-sonnet-5",
                modelID: "claude-sonnet-5",
                providerID: "commandcode",
                settings: { cmd: { free: false } },
              },
            ],
          },
        },
      } as unknown as V2TuiContext["data"]
      let portCalls = 0
      const ctx = {
        data,
        client: {
          rpc: (definition: unknown) => {
            assertEqual(
              (definition as { id: string }).id,
              "commandcode",
              "the panel asks the plugin's own port",
            )
            return {
              usage: async () => {
                portCalls += 1
                return { result: usageState().result, provenance: { kind: "host" } }
              },
            }
          },
        },
      } as unknown as V2TuiContext
      const panel = createUsagePanel(createUsageRpcLoader(ctx.client))
      await panel.mount()
      assertEqual(portCalls, 1, "one bridge call per mount chain")
      const model = v2ModelFor(data, "ses_1")
      const rows = panelRows(dealsRowsV2(model), panel.state(), NOW)
      assertEqual(row(rows, "Status"), ["Status", "Paid"])
      assertEqual(meterDetail(rows, "5-hour"), ["$0.50 / $3.00", "", "value"])
      panel.unmount()
    },
  ],

  [
    "v1 half registers the snake_case sidebar_content slot",
    async () => {
      const registrations: Array<{ order?: number; slots: Record<string, unknown> }> = []
      const api = {
        slots: {
          register: (registration: { order?: number; slots: Record<string, unknown> }) => {
            registrations.push(registration)
            return "commandcode.deals:0"
          },
        },
      }
      await plugin.tui(api as never, undefined as never, undefined as never)
      assertEqual(registrations.length, 1)
      assertEqual(registrations[0]?.order, 200)
      assert(typeof registrations[0]?.slots["sidebar_content"] === "function")
      assertEqual(registrations[0]?.slots["sidebar.content"], undefined)
    },
  ],
  [
    "v2 half claims the dot-separated sidebar.content path with a renderer",
    () => {
      const claims: V2TuiSlotClaim[] = []
      const ctx = {
        theme: { text: { base: {}, muted: {} } },
        ui: {
          slot: (claim: V2TuiSlotClaim) => {
            claims.push(claim)
            return () => {}
          },
        },
      } as unknown as V2TuiContext
      plugin.setup(ctx)
      assertEqual(claims.length, 1)
      assertEqual(claims[0]?.append, "sidebar.content")
      assert(typeof claims[0]?.render === "function")
    },
  ],
  [
    "default export satisfies both TUI host contracts",
    () => {
      // v1's reader requires a default export with `tui()` and rejects one that
      // also carries `server()`; v2's loader requires `id` + `setup()`.
      assertEqual(plugin.id, "commandcode.deals")
      assert(typeof plugin.tui === "function", "v1 needs tui(api)")
      assert(typeof plugin.setup === "function", "v2 needs setup(context)")
      assertEqual((plugin as { server?: unknown }).server, undefined)
    },
  ],
])

/** The banner row the panel leads with when the Deals catalog is empty. */
function unavailable(): string {
  return "Deals unavailable — https://commandcode.ai/docs/resources/pricing-limits"
}
