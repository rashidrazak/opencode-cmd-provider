/** @jsxImportSource @opentui/solid */
// src/rates-usage/tui.tsx — TUI plugin: the "Command Code" Rates & usage panel
// in the session sidebar. Renders its segments from the picked model's enriched
// `cmd` (produced by the server plugin's config hook on v1 and its provider
// transform on v2), plus the live `Usage` segment (issues #244/#245):
// fetched once per panel mount, then refreshed on completed turns and window
// rolls — never polled — with a local 30-second countdown clock.
//
// The row vocabulary, the fixed row set, the usage controller and the layout
// model are all host-agnostic and live outside this file
// (`panel-rows.ts`, `usage-panel.ts`, `segments.ts`), because the OpenCode
// Desktop GUI panel (src/rates-usage/gui/panel.tsx) renders the same rows in
// the same order from the same enrichment payload. This module is the TUI's
// rendering and host glue only.
//
// Two hosts, two TUI contracts (ADR-0010), one default export:
//   v1  `{ id, tui(api) }`        — `api.slots.register({ slots: { sidebar_content } })`
//   v2  `{ id, setup(context) }`  — `context.ui.slot({ append: "sidebar.content" })`
// v2 validates the module before activating it (`id` + `setup`), so a v1-only
// module is rejected outright and the sidebar never appears — the reason both
// halves ship from this file. v1's reader only inspects `id`/`server`/`tui`, so
// the extra `setup` is invisible to it (tests/contract.test.ts pins both).
// Each half subscribes to its own completed-turn signal (v1's `session.idle`
// event bus, v2's `session.idle`/`session.execution.succeeded` data store)
// and filters it to the panel's session before waking the refresh policy.
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type { Provider } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  panelRows,
  ratesUsageSegments,
  ratesUsageSegmentsV2,
  v1ModelFor,
  v2ModelFor,
  type RatesUsageRow,
  type RatesUsageRowTone,
  type V1Model,
  type V2PanelModel,
} from "./panel-rows.js"
import {
  RATES_USAGE_LAYOUT_KEY,
  RATES_USAGE_SEGMENT_LABELS,
  defaultLayout,
  moveSegment,
  normalizeLayout,
  resetLayout,
  segmentKeyIntent,
  toggleSegment,
  type RatesUsageLayout,
  type RatesUsageSegmentId,
  type SegmentsKeyIntent,
} from "./segments.js"
import {
  createUsagePanel,
  v1UsageLoader,
  type UsagePanel,
  type UsagePanelState,
} from "./tui-usage.js"
import { createUsageRpcLoader } from "./usage-rpc.js"
import { globalUsageCache } from "./usage-cache.js"
import type { TuiCredentialV1Input } from "./tui-credential.js"
import type {
  V2TuiContext,
  V2TuiFeedbackColor,
  V2TuiKeymapCommand,
  V2TuiModel,
  V2TuiPluginDefinition,
  V2TuiTheme,
} from "../plugin/v2-tui-types.js"

export type {
  RatesUsageRow,
  RatesUsageRowTone,
  RatesUsageSegments,
  V1Model,
  V2PanelModel,
} from "./panel-rows.js"
export {
  panelRows,
  ratesUsageRows,
  ratesUsageRowsV2,
  ratesUsageSegments,
  ratesUsageSegmentsV2,
  v1ModelFor,
  v2ModelFor,
} from "./panel-rows.js"

const id = "commandcode.rates-usage"

/** The panel itself, shared by both hosts: rows in, theme colours in. */
function RatesUsagePanel(props: {
  rows: () => RatesUsageRow[]
  text: () => RGBA
  textMuted: () => RGBA
  tone: (tone: RatesUsageRowTone) => RGBA
}) {
  return (
    <Show when={props.rows().length > 0}>
      <box>
        <text fg={props.text()}>
          <b>Command Code</b>
        </text>
        <For each={props.rows()}>
          {(row) =>
            row[0] === "" ? (
              <text> </text>
            ) : row[2] === "bar" ? (
              <text fg={props.textMuted()}>
                <span style={{ fg: props.tone(row[3] ?? "success") }}>{row[0]}</span>
                {row[1]}
              </text>
            ) : row[2] === "value" ? (
              <text fg={props.textMuted()}>{row[0]}</text>
            ) : row[1] === "" ? (
              <text fg={props.text()}>
                {row[2] === "heading" ? (
                  <b>
                    <u>{row[0]}</u>
                  </b>
                ) : (
                  <b>{row[0]}</b>
                )}
              </text>
            ) : (
              <text fg={props.textMuted()}>{`${row[0]}: ${row[1]}`}</text>
            )
          }
        </For>
      </box>
    </Show>
  )
}

/**
 * The v1 layout, read reactively from the host's shared KV store (ADR-0020's
 * TUI host state): `api.kv.get` reads its Solid store under the hood, so a
 * dialog save repaints every mounted panel without a local signal. The
 * normalizer tolerates whatever the store holds, foreign keys included.
 */
export function v1Layout(api: TuiPluginApi): RatesUsageLayout {
  return normalizeLayout(api.kv.get(RATES_USAGE_LAYOUT_KEY))
}

/** Persists a v1 layout; the KV store writes through to `state/kv.json`. */
export function saveV1Layout(api: TuiPluginApi, layout: RatesUsageLayout): void {
  api.kv.set(RATES_USAGE_LAYOUT_KEY, layout)
}

/** The v2 layout store the panel and the dialog share. */
export interface V2LayoutStore {
  layout: () => RatesUsageLayout
  save: (layout: RatesUsageLayout) => void
}

/**
 * Creates the v2 layout store once per plugin activation: the host persists
 * and live-syncs it, namespacing the key with the plugin id itself. The
 * normalized read tolerates a shape from another release; a save rewrites
 * both arrays so the stored value stays the plain JSON shape.
 */
export function createV2LayoutStore(ctx: V2TuiContext): V2LayoutStore {
  const [stored, mutate] = ctx.storage.store(RATES_USAGE_LAYOUT_KEY, { initial: defaultLayout() })
  return {
    layout: () => normalizeLayout(stored),
    save: (layout) => {
      void mutate((draft) => {
        draft.order = [...layout.order]
        draft.hidden = [...layout.hidden]
      })
    },
  }
}

/**
 * The segment-settings dialog: one row per segment in the current order — the
 * cursor, a visibility box, and the label — plus the key hints. The key map
 * is `segmentKeyIntent` (arrows move the cursor, shift+arrows move the
 * segment, space/enter toggle, `r` resets, escape closes); every change saves
 * immediately, so the panel behind the dialog repaints live. Hidden segments
 * keep their position, so unhiding restores the user's order.
 *
 * Keys arrive one of two ways because the hosts differ: v2's raw
 * `useKeyboard` sees them (the palette leaves no textarea focused), while v1
 * hands key handling to the caller through `bindKeys` — the prompt's managed
 * textarea layer owns the arrows at default priority, so the v1 mount
 * registers a `priority: 1` keymap layer for the dialog's lifetime instead
 * (`bindV1DialogKeys`). `bindKeys` returns the layer's disposer, run with the
 * component.
 */
function SegmentsDialog(props: {
  layout: () => RatesUsageLayout
  save: (layout: RatesUsageLayout) => void
  close: () => void
  text: () => RGBA
  muted: () => RGBA
  accent: () => RGBA
  bindKeys?: (handle: (intent: SegmentsKeyIntent) => void) => () => void
}) {
  const [cursor, setCursor] = createSignal(0)

  const order = () => props.layout().order
  const current = () => order()[cursor()]

  const moveCursor = (delta: -1 | 1) => {
    const count = order().length
    if (count === 0) return
    setCursor((index) => (index + delta + count) % count)
  }

  const handle = (intent: SegmentsKeyIntent): void => {
    if (intent === "close") {
      props.close()
      return
    }
    if (intent === "up" || intent === "down") {
      moveCursor(intent === "up" ? -1 : 1)
      return
    }
    const segment = current()
    if (segment === undefined) return
    if (intent === "toggle") {
      props.save(toggleSegment(props.layout(), segment))
      return
    }
    if (intent === "move-up" || intent === "move-down") {
      const next = moveSegment(props.layout(), segment, intent === "move-up" ? -1 : 1)
      props.save(next)
      // Keep the cursor on the segment the user just moved.
      const index = next.order.indexOf(segment)
      if (index !== -1) setCursor(index)
      return
    }
    if (intent === "reset") {
      props.save(resetLayout())
      setCursor(0)
    }
  }

  if (props.bindKeys) onCleanup(props.bindKeys(handle))

  useKeyboard((event) => {
    // The v1 mount routes keys through its own keymap layer; consuming them
    // here too would double-apply every press.
    if (props.bindKeys) return
    const intent = segmentKeyIntent(event)
    if (intent === undefined) return
    event.preventDefault()
    event.stopPropagation()
    handle(intent)
  })

  return (
    <box gap={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
        <text fg={props.text()}>
          <b>Sidebar segments</b>
        </text>
        <text fg={props.muted()} onMouseUp={() => props.close()}>
          esc
        </text>
      </box>
      <box paddingLeft={2} paddingRight={2}>
        <text fg={props.muted()}>Choose what the Command Code sidebar shows.</text>
      </box>
      <box flexDirection="column">
        <For each={order()}>
          {(segment, index) => {
            const active = () => index() === cursor()
            const shown = () => !props.layout().hidden.includes(segment)
            return (
              <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2}>
                <text fg={active() ? props.accent() : props.muted()}>{active() ? "›" : " "}</text>
                <text fg={shown() ? props.text() : props.muted()}>{shown() ? "[x]" : "[ ]"}</text>
                <text fg={shown() ? props.text() : props.muted()}>
                  {active() ? (
                    <b>{RATES_USAGE_SEGMENT_LABELS[segment]}</b>
                  ) : (
                    RATES_USAGE_SEGMENT_LABELS[segment]
                  )}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <box paddingLeft={2} paddingRight={2}>
        <text fg={props.muted()}>space show/hide · shift+↑↓ move · r reset</text>
      </box>
    </box>
  )
}

/**
 * The dialog's v1 keyboard handling: the prompt's managed textarea layer
 * (`input.move.up`/`input.move.down`, `input.newline`, …) owns the focused
 * prompt at default priority, so arrows never reach a raw `useKeyboard`
 * handler while a session prompt is mounted. Registering the dialog's keys as
 * a `priority: 1` layer for the dialog's lifetime wins the dispatch — the
 * same way the host's own `DialogSelect` wins it through its focused filter
 * input. Returns the layer's disposer, run with the component.
 */
export function bindV1DialogKeys(
  keymap: V1Keymap,
  handle: (intent: SegmentsKeyIntent) => void,
): () => void {
  const name = (intent: SegmentsKeyIntent) => `commandcode.rates-usage.segments.${intent}`
  return keymap.registerLayer({
    priority: 1,
    commands: [
      { name: name("up"), run: () => handle("up") },
      { name: name("down"), run: () => handle("down") },
      { name: name("move-up"), run: () => handle("move-up") },
      { name: name("move-down"), run: () => handle("move-down") },
      { name: name("toggle"), run: () => handle("toggle") },
      { name: name("reset"), run: () => handle("reset") },
      { name: name("close"), run: () => handle("close") },
    ],
    bindings: [
      { key: "up", cmd: name("up") },
      { key: "down", cmd: name("down") },
      { key: "shift+up", cmd: name("move-up") },
      { key: "shift+down", cmd: name("move-down") },
      { key: "space", cmd: name("toggle") },
      { key: "return", cmd: name("toggle") },
      { key: "r", cmd: name("reset") },
      { key: "escape", cmd: name("close") },
    ],
  })
}

/**
 * Opens the segment settings on v1 through the host dialog stack. The dialog
 * reads and writes the KV layout directly, so it and the panel stay in sync.
 * Keys ride the host keymap through `bindKeys` (`bindV1DialogKeys`); a host
 * without a keymap still renders the panel — its dialog falls back to the raw
 * keyboard handler, which the prompt's textarea layer may shadow.
 */
export function openV1SegmentsDialog(api: TuiPluginApi): void {
  const keymap = api.keymap as V1Keymap | undefined
  api.ui.dialog.replace(() => (
    <SegmentsDialog
      layout={() => v1Layout(api)}
      save={(layout) => saveV1Layout(api, layout)}
      close={() => api.ui.dialog.clear()}
      text={() => api.theme.current.text}
      muted={() => api.theme.current.textMuted}
      accent={() => api.theme.current.primary}
      bindKeys={keymap === undefined ? undefined : (handle) => bindV1DialogKeys(keymap, handle)}
    />
  ))
}

/**
 * Opens the segment settings on v2 through the host dialog stack, reading and
 * writing the shared layout store the panel already renders from. v2's theme
 * exposes no accent token in the slice this package mirrors, so the cursor
 * accent reads as the panel's text colour.
 */
export function openV2SegmentsDialog(ctx: V2TuiContext, store: V2LayoutStore): void {
  const colors = () => v2ThemeColors(ctx.theme)
  ctx.ui.dialog.show(() => (
    <SegmentsDialog
      layout={store.layout}
      save={store.save}
      close={() => ctx.ui.dialog.clear()}
      text={() => colors().text}
      muted={() => colors().muted}
      accent={() => colors().text}
    />
  ))
}

/**
 * The v1 keymap slice (1.18.x `@opentui/keymap`'s `Layer`/`Command`): the
 * package that types `TuiPluginApi.keymap` is provided by the host, not
 * installed here, so the shape is mirrored. The palette fields are the ones
 * the host's own legacy `api.command` shim registers (`namespace`, `name`,
 * `title`, `desc`, `category`), and `run` ignores its command context exactly
 * as the shim does.
 */
type V1PaletteCommand = {
  namespace: "palette"
  name: string
  title: string
  desc?: string
  category?: string
  run: () => void
}

/** One layer command: a name and its runner, plus any host metadata fields. */
type V1KeymapCommand = { name: string; run: () => void; [field: string]: unknown }

/** One binding: a key and the command name it dispatches. */
type V1KeymapBinding = { key: string; cmd: string }

/**
 * The v1 layer slice: the palette command registers alone; the dialog's
 * lifetime layer registers named commands plus their bindings at
 * `priority: 1` (see `bindV1DialogKeys`).
 */
interface V1KeymapLayer {
  priority?: number
  commands: V1KeymapCommand[]
  bindings?: V1KeymapBinding[]
}

interface V1Keymap {
  registerLayer: (layer: V1KeymapLayer) => () => void
}

/**
 * Registers the `Show, hide and reorder sidebar content` palette command on v1 through
 * `api.keymap.registerLayer` — the host's current command channel, which the
 * deprecated `api.command` shim only forwards to (with a warning). Feature
 * detected: a host without a keymap still renders the panel, just without the
 * dialog entry.
 */
export function registerV1SegmentsCommand(api: TuiPluginApi): void {
  const keymap = api.keymap as V1Keymap | undefined
  keymap?.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "commandcode.rates-usage.segments",
        title: "Show, hide and reorder sidebar content",
        category: "Command Code",
        slash: { name: "cmd-rates-usage" },
        run: () => openV1SegmentsDialog(api),
      },
    ],
  })
}

/**
 * The v1 half's live credential input (ADR-0020): the provider records the
 * state already holds plus the TUI's own client. Built per load, never cached
 * at mount, so a `/connect` or a provider re-registration is observed.
 */
export function v1UsageInput(api: TuiPluginApi): TuiCredentialV1Input {
  return { host: "v1", providers: api.state.provider, client: api.client }
}

/**
 * The v1 half's completed-turn adapter (#245): the event bus's `session.idle`
 * for the watched session calls `notify`. `session` is a thunk so a slot
 * re-rendered for another session cannot leave a stale filter behind. Returns
 * the bus's own unsubscribe.
 */
export function subscribeV1Idle(
  api: TuiPluginApi,
  session: () => string,
  notify: () => void,
): () => void {
  return api.event.on("session.idle", (event) => {
    if (event.properties.sessionID === session()) notify()
  })
}

/**
 * One panel body's lifecycle, shared by every host (#245): subscribe the
 * host's completed-turn signal, start the mount chain, and cancel the clock,
 * the subscription and any in-flight chain when the panel goes away.
 */
export function manageUsagePanel(panel: UsagePanel, subscribeIdle: () => () => void): void {
  const unsubscribe = subscribeIdle()
  onMount(() => {
    void panel.mount()
  })
  onCleanup(() => {
    unsubscribe()
    panel.unmount()
  })
}

/**
 * The v1 panel body: rendered only while the selected model is a Command Code
 * one, so the mount chain never reaches the billing API for another provider's
 * selection. The controller lives as long as that selection does — one panel,
 * one mount chain, no re-fetch on mid-session model switches.
 */
function CmdPanelV1(props: { api: TuiPluginApi; sessionID: string; model: () => V1Model }) {
  const [usage, setUsage] = createSignal<UsagePanelState | undefined>(undefined)
  const [now, setNow] = createSignal(Date.now())
  const usagePanel = createUsagePanel(
    v1UsageLoader(() => v1UsageInput(props.api)),
    {
      cache: { key: props.sessionID, store: globalUsageCache() },
      onChange: setUsage,
      onTick: setNow,
    },
  )
  manageUsagePanel(usagePanel, () =>
    subscribeV1Idle(
      props.api,
      () => props.sessionID,
      () => usagePanel.turnCompleted(),
    ),
  )
  return (
    <RatesUsagePanel
      rows={() => panelRows(ratesUsageSegments(props.model()), v1Layout(props.api), usage(), now())}
      text={() => props.api.theme.current.text}
      textMuted={() => props.api.theme.current.textMuted}
      tone={(tone) => props.api.theme.current[tone]}
    />
  )
}

function RatesUsagePanelV1(props: { api: TuiPluginApi; session_id: string }) {
  // Mid-session model switches update the session record (`session.updated`
  // reconciles it into the sync store), so reading `session.model` reactively
  // is enough — no event subscription needed.
  const model = createMemo(() =>
    v1ModelFor(props.api.state.provider, props.api.state.session.get(props.session_id)?.model),
  )
  return (
    <Show when={model()}>
      {(selected) => <CmdPanelV1 api={props.api} sessionID={props.session_id} model={selected} />}
    </Show>
  )
}

/**
 * The panel's colours, across the v2 theme rename (see `V2TuiThemeText`):
 * `base`/`muted` on the newer line, `default`/`subdued` on 2.0.3–2.0.7 —
 * including the `text.feedback` tone pair the usage bars colour by. Reading
 * only one spelling would hand the renderer `undefined` on the hosts exposing
 * the other, and `undefined` paints as the terminal default — the plain white
 * sidebar on 2.0.8+.
 */
export function v2ThemeColors(theme: V2TuiTheme): {
  text: RGBA
  muted: RGBA
  success: RGBA
  warning: RGBA
  error: RGBA
} {
  const text = theme.text
  const tones = {
    success: feedbackColor(text.feedback.success),
    warning: feedbackColor(text.feedback.warning),
    error: feedbackColor(text.feedback.error),
  }
  return "base" in text
    ? { text: text.base, muted: text.muted, ...tones }
    : { text: text.default, muted: text.subdued, ...tones }
}

/** One feedback colour across the pair rename (`base` → `default`). */
function feedbackColor(color: V2TuiFeedbackColor): RGBA {
  return "base" in color ? color.base : color.default
}

/**
 * The v2 half's completed-turn adapter (#245): the data store's
 * `session.idle` and `session.execution.succeeded` for the watched session
 * call `notify`. `session` is a thunk so a slot re-rendered for another
 * session cannot leave a stale filter behind. Returns the teardown that
 * unsubscribes both.
 */
export function subscribeV2Idle(
  ctx: V2TuiContext,
  session: () => string,
  notify: () => void,
): () => void {
  const offIdle = ctx.data.on("session.idle", (event) => {
    if (event.data.sessionID === session()) notify()
  })
  const offSucceeded = ctx.data.on("session.execution.succeeded", (event) => {
    if (event.data.sessionID === session()) notify()
  })
  return () => {
    offIdle()
    offSucceeded()
  }
}

/**
 * The v2 panel body, gated exactly like v1's: mounted only for a Command Code
 * selection, one mount chain per panel — and one clock, one subscription and
 * one abortable chain, all cancelled with it (#245). The chain is the RPC
 * bridge (ADR-0020): the plugin's server half resolves the Host's connected
 * credential and fetches the snapshot; this process never holds the key.
 */
function CmdPanelV2(props: {
  ctx: V2TuiContext
  sessionID: string
  model: () => V2PanelModel
  layout: V2LayoutStore
}) {
  const [usage, setUsage] = createSignal<UsagePanelState | undefined>(undefined)
  const [now, setNow] = createSignal(Date.now())
  const usagePanel = createUsagePanel(createUsageRpcLoader(props.ctx.client), {
    cache: { key: props.sessionID, store: globalUsageCache() },
    onChange: setUsage,
    onTick: setNow,
  })
  manageUsagePanel(usagePanel, () =>
    subscribeV2Idle(
      props.ctx,
      () => props.sessionID,
      () => usagePanel.turnCompleted(),
    ),
  )
  const colors = () => v2ThemeColors(props.ctx.theme)
  return (
    <RatesUsagePanel
      rows={() =>
        panelRows(ratesUsageSegmentsV2(props.model()), props.layout.layout(), usage(), now())
      }
      text={() => colors().text}
      textMuted={() => colors().muted}
      tone={(tone) => colors()[tone]}
    />
  )
}

function RatesUsagePanelV2(props: { ctx: V2TuiContext; sessionID: string; layout: V2LayoutStore }) {
  // Same idea as v1 against the v2 data store: `data` is the host's live
  // client-local state, so reading the session's model and the model catalog
  // inside the memo re-renders the panel when either changes.
  const model = createMemo(() => v2ModelFor(props.ctx.data, props.sessionID))
  return (
    <Show when={model()}>
      {(selected) => (
        <CmdPanelV2
          ctx={props.ctx}
          sessionID={props.sessionID}
          model={selected}
          layout={props.layout}
        />
      )}
    </Show>
  )
}

/** v1 half: snake_case slot map registered through `api.slots`. */
const tui: TuiPlugin = async (api) => {
  registerV1SegmentsCommand(api)
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx, props) {
        return <RatesUsagePanelV1 api={api} session_id={props.session_id} />
      },
    },
  })
}

/**
 * The v2 command entry (issue #253): `palette: true` surfaces it in the host
 * command palette, `slash` in prompt slash completion — so the dialog is
 * reachable as `/cmd-rates-usage` even when the palette shortcut is captured by the
 * terminal multiplexer around the TUI. The title carries the whole wording on
 * purpose: the palette renders a description inline after the title and a
 * second line of copy only truncates, so the row and the slash completion
 * both read the same single sentence.
 */
export function v2SegmentsCommand(ctx: V2TuiContext, layout: V2LayoutStore): V2TuiKeymapCommand {
  return {
    id: "commandcode.rates-usage.segments",
    title: "Show, hide and reorder sidebar content",
    group: "Command Code",
    palette: true,
    slash: { name: "cmd-rates-usage" },
    run: () => openV2SegmentsDialog(ctx, layout),
  }
}

/**
 * The v2 command layer, rendered as a headless component through the `app`
 * slot. Two host constraints meet here (both measured on opencode 2.0.20):
 * `keymap.layer` is a Solid context owned by the calling component, so
 * calling it from `setup` throws `Keymap.Provider is missing` and takes the
 * whole plugin — sidebar included — down with it; and the layer must be
 * `mode: "global"`, because layers default to `base` and the command palette
 * queries *reachable* commands while its own modal dialog is open, where a
 * base-mode layer is unreachable and the entry silently vanishes. The `app`
 * slot mounts on every route under that provider, so the palette entry exists
 * before any session opens; the component renders nothing.
 */
function SegmentsCommandLayer(props: { ctx: V2TuiContext; layout: V2LayoutStore }) {
  props.ctx.keymap.layer(() => ({
    mode: "global",
    commands: [v2SegmentsCommand(props.ctx, props.layout)],
  }))
  return null
}

/** v2 half: `setup(context)` claiming the headless command layer and the sidebar. */
const setup = (ctx: V2TuiContext): void => {
  const layout = createV2LayoutStore(ctx)
  ctx.ui.slot({
    append: "app",
    render: () => <SegmentsCommandLayer ctx={ctx} layout={layout} />,
  })
  ctx.ui.slot({
    append: "sidebar.content",
    render: (input) => <RatesUsagePanelV2 ctx={ctx} sessionID={input.sessionID} layout={layout} />,
  })
}

const plugin: TuiPluginModule & V2TuiPluginDefinition = { id, tui, setup }

export default plugin
