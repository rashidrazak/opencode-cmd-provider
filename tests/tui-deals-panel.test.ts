// tests/tui-deals-panel.test.ts — deals sidebar panel data extraction and the
// two host contracts (v1 `tui(api)` slot map, v2 `setup(context)` slot claim).
import plugin, { dealsRows, dealsRowsV2, v1ModelFor, v2ModelFor } from "../src/deals/tui.js"
import type { DealsRow } from "../src/deals/tui.js"
import type { Provider } from "@opencode-ai/sdk/v2"
import type { V2TuiContext, V2TuiSlotClaim } from "../src/plugin/v2-tui-types.js"
import { assertEqual, assert, run } from "./harness.js"

const NA = "N/A"

/** PLAN_CATALOG display names — the plan rows under the Allowance heading. */
const PLAN_LABELS = [
  "Go",
  "GOAT",
  "Pro",
  "Pro (legacy)",
  "Max 10×",
  "Max 20×",
  "Team Pro",
  "Provider",
]

/** The rows after the allowance segment: deal and benchmark data. */
const TAIL_LABELS = ["Deal", "Was", "Now", "Intelligence", "Tok/s"]

/** The placeholder a model with no rate bands renders: a blank line, then `Rates: N/A`. */
const NO_RATES: DealsRow[] = [
  ["", ""],
  ["Rates", NA],
]

/**
 * The fixed segmented shape: Tier/Status, a blank line, the `Allowance` heading
 * over one row per plan, a blank line, then the deal/benchmark rows and the
 * rate block (`rates`, defaulting to the plain `Rates: N/A` row) — every value
 * from `values` (or `N/A`).
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
    ...TAIL_LABELS.map(valueRow),
    ...rates,
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
    "segments the panel: Tier/Status, blank, Allowance heading + plans, blank, deal rows, blank, Rates",
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
      assertEqual(rows.slice(4, 12), [
        ["Go", NA],
        ["GOAT", "$20/mo"],
        ["Pro", NA],
        ["Pro (legacy)", NA],
        ["Max 10×", NA],
        ["Max 20×", NA],
        ["Team Pro", NA],
        ["Provider", NA],
      ])
      assertEqual(rows.slice(12), [
        ["", ""],
        ["Deal", NA],
        ["Was", NA],
        ["Now", NA],
        ["Intelligence", NA],
        ["Tok/s", NA],
        ["", ""],
        ["Rates", NA],
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
      assertEqual(row(rows, "Peak"), ["Peak", NA])
      assertEqual(row(rows, "Off-peak"), ["Off-peak", NA])
      assertEqual(row(rows, "Windows"), ["Windows", "01-04 & 06-10 UTC"])
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
            ["", ""],
            ["Rates", "", "heading"],
            ["Peak", "$0.32/$1.16/$0.032/$0 in/out/cache"],
            ["Off-peak", "$0.16/$0.58/$0.016/$0 in/out/cache"],
            ["Windows", "01–04 & 06–10 UTC, Mon–Fri"],
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
            ["", ""],
            ["Rates", "", "heading"],
            ["≤ 272K", "$2/$10/$0.2/$2.5 in/out/cache"],
            ["> 272K", "$4/$15/$0.4/$5 in/out/cache"],
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
            ["", ""],
            ["Rates", "", "heading"],
            ["Peak", NA],
            ["Off-peak", NA],
            ["Windows", "01–04"],
            ["≤ 32K", NA],
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
    "renders every plan row under the Allowance heading, N/A for unlisted plans",
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
      // The row set is the catalog's plan vocabulary — unknown keys are not rows.
      const unknown = dealsRows({ options: { cmd: { allowance: { custom: 5 }, free: false } } })
      assertFixedRows(unknown, { Status: "Paid" })
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
      const models = [
        {
          id: "claude-sonnet-5",
          modelID: "claude-sonnet-5",
          providerID: "commandcode",
          settings: { cmd },
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
    "v1: model lookup resolves the selected Command Code model and hides other providers",
    () => {
      const cmd = { tier: "premium", free: false }
      const providers = [
        { id: "commandcode", models: { "claude-sonnet-5": { options: { cmd } } } },
        { id: "opencode", models: { "gpt-6": {} } },
      ] as unknown as readonly Provider[]
      const found = v1ModelFor(providers, { id: "claude-sonnet-5", providerID: "commandcode" })
      assertEqual(found?.options?.["cmd"], cmd)
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
        theme: { text: { default: {}, subdued: {} } },
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
