// tests/tui-rates-usage-segments.test.ts — the Rates & usage panel's segment
// layout (issue #253): the vocabulary and normalizer
// (src/rates-usage/segments.ts), the panel composer's visibility/order/separator
// rules, both hosts' persistence adapters, and the command-palette entry that
// opens the settings dialog. The dialog component itself only shells out to the
// intents and the pure layout ops pinned here.
import plugin, {
  bindV1DialogKeys,
  createV2LayoutStore,
  ratesUsageSegments,
  ratesUsageSegmentsV2,
  ratesUsageRows,
  panelRows,
  saveV1Layout,
  v1Layout,
} from "../src/rates-usage/tui.js"
import {
  RATES_USAGE_LAYOUT_KEY,
  defaultLayout,
  moveSegment,
  normalizeLayout,
  segmentKeyIntent,
  toggleSegment,
  visibleSegments,
  type RatesUsageLayout,
} from "../src/rates-usage/segments.js"
import type { UsagePanelState } from "../src/rates-usage/tui-usage.js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { V2TuiContext, V2TuiSlotClaim } from "../src/plugin/v2-tui-types.js"
import { assertEqual, assert, run } from "./harness.js"

const ALL = ["status", "allowance", "rates", "info", "usage"] as const

/** A Command Code model with an empty payload: every segment reads all-N/A. */
const MODEL = { options: { cmd: {} } }

/** The render clock; only the degradation states below need no countdown. */
const NOW = Date.parse("2026-10-01T12:00:00.000Z")

const NO_CREDENTIAL: UsagePanelState = { result: { state: "no-credential" } }
const USAGE_LINE = "Usage needs COMMANDCODE_API_KEY — set it to see live limits"

/** A normalized layout over the given order/hidden ids (missing ids append). */
function layout(order: readonly string[], hidden: readonly string[] = []): RatesUsageLayout {
  return normalizeLayout({ order, hidden })
}

run([
  [
    "the default layout is every segment in the historic order",
    () => {
      assertEqual(defaultLayout(), { order: [...ALL], hidden: [] })
      assertEqual(visibleSegments(defaultLayout()), [...ALL])
    },
  ],

  [
    "normalizeLayout keeps the persisted order and drops what it cannot trust",
    () => {
      // Nothing the host may hold instead of a layout: all read the default.
      assertEqual(normalizeLayout(undefined), defaultLayout())
      assertEqual(normalizeLayout(null), defaultLayout())
      assertEqual(normalizeLayout("segments"), defaultLayout())
      assertEqual(normalizeLayout({ order: "usage", hidden: 1 }), defaultLayout())
      // Unknown ids and duplicates drop; ids the store lacks append in default
      // order, so a segment a later release adds cannot vanish.
      assertEqual(
        normalizeLayout({
          order: ["usage", "usage", "bogus", "status"],
          hidden: ["rates", "rates", "bogus"],
        }),
        { order: ["usage", "status", "allowance", "rates", "info"], hidden: ["rates"] },
      )
    },
  ],

  [
    "toggleSegment flips visibility in place without mutating its input",
    () => {
      const before = defaultLayout()
      const hidden = toggleSegment(before, "rates")
      assertEqual(hidden.order, before.order)
      assertEqual(hidden.hidden, ["rates"])
      assertEqual(visibleSegments(hidden), ["status", "allowance", "info", "usage"])
      assertEqual(before.hidden, [], "the input layout is untouched")
      assertEqual(toggleSegment(hidden, "rates"), defaultLayout())
    },
  ],

  [
    "moveSegment reorders any segment, hidden ones included, and no-ops at the edges",
    () => {
      const before = defaultLayout()
      assertEqual(moveSegment(before, "usage", -1).order, [
        "status",
        "allowance",
        "rates",
        "usage",
        "info",
      ])
      assertEqual(moveSegment(before, "status", -1).order, before.order)
      assertEqual(moveSegment(before, "usage", 1).order, before.order)
      assertEqual(before.order, [...ALL], "the input layout is untouched")
      // A hidden segment still reorders, so unhiding restores the user's spot.
      const moved = moveSegment(toggleSegment(before, "status"), "status", 1)
      assertEqual(moved.order, ["allowance", "status", "rates", "info", "usage"])
      assertEqual(moved.hidden, ["status"])
    },
  ],

  [
    "segmentKeyIntent maps the dialog keys and yields foreign ones to the host",
    () => {
      const plain = { shift: false, ctrl: false, meta: false }
      assertEqual(segmentKeyIntent({ ...plain, name: "escape" }), "close")
      assertEqual(segmentKeyIntent({ ...plain, name: "up" }), "up")
      assertEqual(segmentKeyIntent({ ...plain, name: "down" }), "down")
      assertEqual(segmentKeyIntent({ ...plain, name: "up", shift: true }), "move-up")
      assertEqual(segmentKeyIntent({ ...plain, name: "down", shift: true }), "move-down")
      assertEqual(segmentKeyIntent({ ...plain, name: "space" }), "toggle")
      assertEqual(segmentKeyIntent({ ...plain, name: "return" }), "toggle")
      assertEqual(segmentKeyIntent({ ...plain, name: "r" }), "reset")
      // Ctrl/meta combos and shifted space/enter are the host's bindings.
      assertEqual(segmentKeyIntent({ ...plain, name: "up", ctrl: true }), undefined)
      assertEqual(segmentKeyIntent({ ...plain, name: "r", meta: true }), undefined)
      assertEqual(segmentKeyIntent({ ...plain, name: "space", shift: true }), undefined)
      assertEqual(segmentKeyIntent({ ...plain, name: "tab" }), undefined)
    },
  ],

  [
    "the segment builders gate non-Command Code models and leave Usage to the composer",
    () => {
      assertEqual(ratesUsageSegments(undefined), undefined)
      assertEqual(ratesUsageSegmentsV2(undefined), undefined)
      const v1 = ratesUsageSegments(MODEL)!
      assertEqual(Object.keys(v1.segments).sort(), [...ALL].sort())
      assertEqual(v1.segments.usage, [])
      assertEqual(v1.banner, [])
      const v2 = ratesUsageSegmentsV2({ settings: { cmd: {} } })!
      assertEqual(v2.segments.usage, [])
    },
  ],

  [
    "the composer preserves the default panel byte-for-byte",
    () => {
      for (const model of [
        MODEL,
        { options: {} },
        { options: { cmd: { free: false, peakOffPeak: { peak: { input: 1, output: 2 } } } } },
        { options: { cmd: { unavailable: true } } },
      ]) {
        assertEqual(
          panelRows(ratesUsageSegments(model)!, defaultLayout(), undefined, NOW),
          ratesUsageRows(model),
        )
      }
    },
  ],

  [
    "one blank line separates visible segments; hidden ones vanish",
    () => {
      const segments = ratesUsageSegments(MODEL)!
      const rows = panelRows(
        segments,
        layout(["rates", "info"], ["status", "allowance", "usage"]),
        undefined,
        NOW,
      )
      assertEqual(rows, [...segments.segments.rates, ["", ""], ...segments.segments.info])
    },
  ],

  [
    "the Usage segment renders where the order puts it, without doubling separators",
    () => {
      const segments = ratesUsageSegments(MODEL)!
      // The usage renderer ships its own leading blank; the composer trims it
      // and inserts the one separator the composition owns.
      const rows = panelRows(
        segments,
        layout(["usage", "info"], ["status", "allowance", "rates"]),
        NO_CREDENTIAL,
        NOW,
      )
      assertEqual(rows, [
        ["Usage", "", "heading"],
        [USAGE_LINE, "", "value"],
        ["", ""],
        ...segments.segments.info,
      ])
    },
  ],

  [
    "while the usage load is in flight the composer leaves no gap",
    () => {
      const segments = ratesUsageSegments(MODEL)!
      const usageOnly = layout(["usage"], ["status", "allowance", "rates", "info"])
      // Nothing rendered for the only visible segment: the panel hides rather
      // than showing a lone blank line.
      assertEqual(panelRows(segments, usageOnly, undefined, NOW), [])
      assertEqual(panelRows(segments, defaultLayout(), undefined, NOW), ratesUsageRows(MODEL))
    },
  ],

  [
    "every segment hidden hides the panel, banner included",
    () => {
      const segments = ratesUsageSegments({ options: { cmd: { unavailable: true } } })!
      const allHidden = layout([...ALL], [...ALL])
      assertEqual(panelRows(segments, allHidden, undefined, NOW), [])
      assertEqual(panelRows(segments, allHidden, NO_CREDENTIAL, NOW), [])
    },
  ],

  [
    "the unavailable banner stays pinned above the first visible segment",
    () => {
      const segments = ratesUsageSegments({ options: { cmd: { unavailable: true } } })!
      const rows = panelRows(
        segments,
        layout(["info", "status"], ["allowance", "rates", "usage"]),
        undefined,
        NOW,
      )
      assertEqual(rows, [
        ...segments.banner,
        ...segments.segments.info,
        ["", ""],
        ...segments.segments.status,
      ])
    },
  ],

  [
    "a Usage-only layout carries no catalog banner",
    () => {
      const segments = ratesUsageSegments({ options: { cmd: { unavailable: true } } })!
      const rows = panelRows(
        segments,
        layout(["usage"], ["status", "allowance", "rates", "info"]),
        NO_CREDENTIAL,
        NOW,
      )
      assertEqual(rows, [
        ["Usage", "", "heading"],
        [USAGE_LINE, "", "value"],
      ])
    },
  ],

  [
    "v1: the layout round-trips through the host KV store and degrades safely",
    () => {
      const store = new Map<string, unknown>()
      const api = {
        kv: {
          get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
          set: (key: string, value: unknown) => {
            store.set(key, value)
          },
        },
      } as unknown as TuiPluginApi
      assertEqual(v1Layout(api), defaultLayout())
      const next = layout(["usage", "status"], ["info"])
      saveV1Layout(api, next)
      assertEqual(store.get(RATES_USAGE_LAYOUT_KEY), next)
      assertEqual(v1Layout(api), next)
      store.set(RATES_USAGE_LAYOUT_KEY, { order: ["bogus"], hidden: ["bogus"] })
      assertEqual(v1Layout(api), defaultLayout())
    },
  ],

  [
    "v2: the layout store seeds, saves in place, and normalizes a foreign value",
    () => {
      const states = new Map<string, unknown>()
      const ctx = {
        storage: {
          store: (key: string, options: { initial: unknown }) => {
            if (!states.has(key)) states.set(key, options.initial)
            return [
              states.get(key),
              async (mutation: (draft: Record<string, unknown>) => void) => {
                const state = states.get(key)
                if (state !== undefined) mutation(state as Record<string, unknown>)
              },
            ]
          },
        },
      } as unknown as V2TuiContext
      const store = createV2LayoutStore(ctx)
      assertEqual(store.layout(), defaultLayout())
      const next = layout(["usage", "status"], ["rates"])
      store.save(next)
      assertEqual(states.get(RATES_USAGE_LAYOUT_KEY), next)
      assertEqual(store.layout(), next)
      // A store opened over a value another release wrote normalizes on read.
      states.set(RATES_USAGE_LAYOUT_KEY, { order: ["usage", 7], hidden: "nope" })
      assertEqual(createV2LayoutStore(ctx).layout(), {
        order: ["usage", "status", "allowance", "rates", "info"],
        hidden: [],
      })
    },
  ],

  [
    "v1: the dialog's key layer binds every intent above the prompt's textarea layer",
    () => {
      const intents: string[] = []
      type Layer = {
        priority?: number
        commands: Array<{ name: string; run: () => void }>
        bindings?: Array<{ key: string; cmd: string }>
      }
      let registered: Layer | undefined
      let disposed = 0
      const keymap = {
        registerLayer: (layer: Layer) => {
          registered = layer
          return () => {
            disposed += 1
          }
        },
      }
      const dispose = bindV1DialogKeys(keymap as never, (intent) => intents.push(intent))
      assertEqual(registered?.priority, 1, "the prompt's managed textarea layer is priority 0")
      assertEqual(registered?.bindings, [
        { key: "up", cmd: "commandcode.rates-usage.segments.up" },
        { key: "down", cmd: "commandcode.rates-usage.segments.down" },
        { key: "shift+up", cmd: "commandcode.rates-usage.segments.move-up" },
        { key: "shift+down", cmd: "commandcode.rates-usage.segments.move-down" },
        { key: "space", cmd: "commandcode.rates-usage.segments.toggle" },
        { key: "return", cmd: "commandcode.rates-usage.segments.toggle" },
        { key: "r", cmd: "commandcode.rates-usage.segments.reset" },
        { key: "escape", cmd: "commandcode.rates-usage.segments.close" },
      ])
      // Every binding resolves to a registered command, and each command
      // delivers exactly its intent.
      for (const binding of registered?.bindings ?? []) {
        const command = registered?.commands.find((item) => item.name === binding.cmd)
        assert(command !== undefined, `binding ${binding.key} resolves to a command`)
        command.run()
      }
      assertEqual(intents, [
        "up",
        "down",
        "move-up",
        "move-down",
        "toggle",
        "toggle",
        "reset",
        "close",
      ])
      dispose()
      assertEqual(disposed, 1, "the layer is disposed with the dialog")
    },
  ],

  [
    "v1: tui() registers the palette command and its run opens the dialog",
    async () => {
      const commands: Array<{
        namespace?: string
        name?: string
        title?: string
        desc?: string
        slash?: { name?: string; aliases?: string[] }
        run: () => void
      }> = []
      let replaces = 0
      let render: (() => unknown) | undefined
      const api = {
        keymap: {
          registerLayer: (layer: { commands: typeof commands }) => {
            commands.push(...layer.commands)
            return () => {}
          },
        },
        ui: {
          dialog: {
            replace: (next: () => unknown) => {
              replaces += 1
              render = next
            },
            clear: () => {},
          },
        },
        theme: { current: { text: {}, textMuted: {}, primary: {} } },
        slots: { register: () => "commandcode.rates-usage:0" },
      } as unknown as TuiPluginApi
      await plugin.tui(api, undefined as never, undefined as never)
      assertEqual(commands.length, 1)
      assertEqual(commands[0]?.namespace, "palette")
      assertEqual(commands[0]?.name, "commandcode.rates-usage.segments")
      assertEqual(commands[0]?.title, "Show, hide and reorder sidebar content")
      assertEqual(commands[0]?.desc, undefined, "the palette row carries no inline description")
      assertEqual(commands[0]?.slash, { name: "cmd-rates-usage" })
      commands[0]!.run()
      assertEqual(replaces, 1, "the run opens one dialog")
      assert(typeof render === "function")
    },
  ],

  [
    "v2: setup() only claims slots; the app-slot layer owns the palette command",
    () => {
      const commands: Array<{
        id?: string
        title?: string
        description?: string
        palette?: true
        slash?: { name?: string; aliases?: string[] }
        run?: () => void
      }> = []
      const layers: Array<{ mode?: string; commands?: typeof commands }> = []
      let layerCalls = 0
      let shows = 0
      const claims: V2TuiSlotClaim[] = []
      const ctx = {
        theme: { text: { base: {}, muted: {} } },
        storage: {
          store: (_key: string, options: { initial: unknown }) => [options.initial, async () => {}],
        },
        keymap: {
          layer: (input: () => { mode?: string; commands?: typeof commands }) => {
            layerCalls += 1
            const layer = input()
            layers.push(layer)
            commands.push(...(layer.commands ?? []))
          },
        },
        ui: {
          slot: (claim: V2TuiSlotClaim) => {
            claims.push(claim)
            return () => {}
          },
          dialog: {
            show: () => {
              shows += 1
            },
            clear: () => {},
          },
        },
      } as unknown as V2TuiContext

      plugin.setup(ctx)
      // `setup` runs outside the component tree, where the host's
      // `keymap.layer` throws "Keymap.Provider is missing" (opencode 2.0.20);
      // a throwing setup would take the whole sidebar down. The layer must be
      // created by the app-slot component instead.
      assertEqual(layerCalls, 0, "setup must not create the keymap layer")
      assertEqual(
        claims.map((claim) => claim.append).sort(),
        ["app", "sidebar.content"],
        "setup claims the headless command layer and the sidebar",
      )

      const appClaim = claims.find((claim) => claim.append === "app")
      assert(appClaim !== undefined, "the app slot carries the command layer")
      ;(appClaim.render as (input: unknown) => unknown)({})
      assertEqual(layerCalls, 1, "the app-slot component creates the layer")
      assertEqual(layers[0]?.mode, "global", "a base-mode layer is unreachable in the palette")
      assertEqual(commands.length, 1)
      assertEqual(commands[0]?.id, "commandcode.rates-usage.segments")
      assertEqual(commands[0]?.title, "Show, hide and reorder sidebar content")
      assertEqual(commands[0]?.description, undefined, "no inline description to truncate")
      assertEqual(commands[0]?.slash, { name: "cmd-rates-usage" })
      assertEqual(commands[0]?.palette, true)
      commands[0]!.run?.()
      assertEqual(shows, 1, "the run opens one dialog")
    },
  ],
])
