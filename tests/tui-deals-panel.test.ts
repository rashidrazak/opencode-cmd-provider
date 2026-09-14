// tests/tui-deals-panel.test.ts — deals sidebar panel data extraction and the
// two host contracts (v1 `tui(api)` slot map, v2 `setup(context)` slot claim).
import plugin, { dealsRows, dealsRowsV2, v2ModelFor } from "../src/deals/tui.js"
import type { V2TuiContext, V2TuiSlotClaim } from "../src/plugin/v2-tui-types.js"
import { assertEqual, assert, run } from "./harness.js"

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
  [
    "shows unavailable banner with placeholders when catalog is empty",
    () => {
      const rows = dealsRows({ options: { cmd: { unavailable: true } } })
      assertEqual(rows, [
        ["Deals unavailable — https://commandcode.ai/docs/resources/pricing-limits", ""],
        ["Tier", "—"],
        ["Intelligence", "—"],
        ["Tok/s", "—"],
      ])
    },
  ],
  [
    "unavailable takes precedence over normal deal data",
    () => {
      const rows = dealsRows({
        options: {
          cmd: {
            unavailable: true,
            tier: "premium",
            allowance: { goat: 40 },
            benchmark: { intelligence: 56 },
            free: false,
          },
        },
      })
      assertEqual(rows, [
        ["Deals unavailable — https://commandcode.ai/docs/resources/pricing-limits", ""],
        ["Tier", "—"],
        ["Intelligence", "—"],
        ["Tok/s", "—"],
      ])
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
      assertEqual(dealsRowsV2({ settings: { cmd } }), [
        ["Tier", "Premium"],
        ["Pro allowance", "$60/mo"],
        ["Intelligence", "56"],
        ["Tok/s", "339"],
      ])
      // v1's bag is not v2's bag: an `options.cmd` payload must not render.
      assertEqual(dealsRowsV2({ settings: { options: { cmd } } }), [])
      assertEqual(dealsRowsV2(undefined), [])
      assertEqual(dealsRowsV2({ settings: { cmd: { free: false } } }), [])
    },
  ],
  [
    "v2: model lookup resolves the session's selected model in the catalog",
    () => {
      const models = [
        { id: "claude-sonnet-5", modelID: "claude-sonnet-5", providerID: "commandcode" },
        { id: "gpt-6", modelID: "gpt-6", providerID: "opencode" },
      ]
      const data = (model?: { id: string; providerID: string }) =>
        ({
          session: { get: () => ({ id: "ses_1", model }) },
          location: { model: { list: () => models } },
        }) as unknown as V2TuiContext["data"]

      assertEqual(
        v2ModelFor(data({ id: "claude-sonnet-5", providerID: "commandcode" }), "ses_1")?.modelID,
        "claude-sonnet-5",
      )
      // A provider/id mismatch (or an unknown session) renders nothing.
      assertEqual(v2ModelFor(data({ id: "gpt-6", providerID: "commandcode" }), "ses_1"), undefined)
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
