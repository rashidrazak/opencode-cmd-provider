// src/rates-usage/gui/panel.tsx — the OpenCode Desktop GUI half of the Rates &
// usage panel: a side-region `Panel` tab ("Command Code") rendering the same
// five segments as the TUI sidebar, from the same shared rows
// (src/rates-usage/panel-rows.ts through src/rates-usage/gui/rows.ts), plus the
// palette command and the + menu item that open it.
//
// Host contract (desktop 2.2.7, mirrored in src/plugin/v2-gui-module.d.ts):
// this module is bundled alone into `./gui-experimental`
// (scripts/vite-gui.config.mjs), the host evaluates it with `require` limited
// to the modules it shares (`@opencode/plugin/gui`, `solid-js`/`web`/`store`),
// and `setup` runs under the plugin's Solid owner in every window. Registry
// tokens are identity-checked by the host, so `@opencode/plugin/gui` stays an
// external import — structurally typed, never a dependency (see the .d.ts).
//
// The usage segment rides the same bridge as the v2 TUI (ADR-0020): the loader
// is `createUsageRpcLoader` against *the mounted session's own server client*,
// read per chain (ADR-0020 rule 3), so a session on any server that runs the
// plugin answers with that server's connected account. The completed-turn
// signal is the server data store's `session.idle` /
// `session.execution.succeeded`, subscribed through `createKeyed` per data
// object generation (a restarted server swaps the object) and filtered to the
// session by id. No polling, no credential in the window — the server half of
// the plugin resolves the account and fetches, exactly as for the TUI.
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  Command,
  MenuItem,
  Panel,
  Style,
  createKeyed,
  type Context,
  type MountedSession,
  type PanelTab,
} from "@opencode/plugin/gui"
import { v2ModelFor, type V2PanelModel } from "../panel-rows.js"
import { createUsagePanel, type UsageLoadRequest, type UsagePanelState } from "../usage-panel.js"
import { createUsageRpcLoader } from "../usage-rpc-client.js"
import { globalUsageCache } from "../usage-cache.js"
import { subscribeGuiIdle } from "./idle.js"
import { guiPanelRows, type GuiRowView } from "./rows.js"
import { RATES_USAGE_GUI_CSS } from "./styles.js"

/** The tab's host key is `${ctx.id}:${PANEL_TAB_ID}`; published ids ride it too. */
export const PANEL_TAB_ID = "rates-usage"

/** The tab title, the panel heading, and the menu item's label. */
export const PANEL_TITLE = "Command Code"

/**
 * The one tab object the panel lists. `Panel.list` must return the same object
 * while the tab is unchanged — a module-level constant is the simplest way to
 * keep that promise across sessions and re-runs.
 */
const TAB: PanelTab = { id: PANEL_TAB_ID, title: PANEL_TITLE }

/**
 * The panel's visibility gate, shared by `list` and the render: the mounted
 * session's selected model must be a Command Code one. Resolution goes through
 * `v2ModelFor`, the same lookup the v2 TUI sidebar uses — the desktop data
 * store's model records carry the same `settings.cmd` enrichment payload.
 */
export function guiModelFor(session: MountedSession): V2PanelModel | undefined {
  return v2ModelFor(session.server.data, session.id)
}

/** Opens the panel for the session on screen; a no-op on Home or a draft. */
export function openRatesUsagePanel(ctx: Context): void {
  const session = ctx.sessions.current()
  if (session === undefined) return
  ctx.layout.open(`${ctx.id}:${PANEL_TAB_ID}`, session)
}

/** One rendered row. The classes live in `./styles.ts`; the mapping in rows.ts. */
function GuiRow(props: { view: GuiRowView }) {
  return (
    <Show when={props.view.kind !== "gap"} fallback={<div class="cc-ru-gap" />}>
      <Show when={props.view.kind === "bar"} fallback={<GuiTextRow view={props.view} />}>
        <div class={`cc-ru-bar cc-ru-bar--${props.view.tone ?? "success"}`}>
          <span>{props.view.label}</span>
          <span class="cc-ru-bar-pct">{props.view.detail}</span>
        </div>
      </Show>
    </Show>
  )
}

/** Every non-bar row: heading, strong, value, and the label/value grid. */
function GuiTextRow(props: { view: GuiRowView }) {
  const view = () => props.view
  return (
    <Show
      when={view().kind === "row"}
      fallback={<div class={`cc-ru-${view().kind}`}>{view().label}</div>}
    >
      <div class="cc-ru-row">
        <span class="cc-ru-row-label">{view().label}</span>
        <span class="cc-ru-row-value">{view().detail}</span>
      </div>
    </Show>
  )
}

/**
 * One session's panel body. Exists once per session key (`<Show keyed>` in
 * `RatesUsageSurface` remounts it when the routed session changes), which is
 * the controller's lifetime: one mount chain, one clock, one subscription, all
 * cancelled with the body — the same lifecycle `tui.tsx` gives its panels.
 */
function SessionRatesUsage(props: {
  ctx: Context
  session: () => MountedSession
  /** The routed session's `key` this body was keyed on (the cache key). */
  sessionKey: string
}) {
  const [usage, setUsage] = createSignal<UsagePanelState | undefined>(undefined)
  const [now, setNow] = createSignal(Date.now())

  // Model resolution is reactive on both inputs (the session record and the
  // catalog), so a mid-session model switch re-renders without a remount —
  // exactly the TUI's behaviour.
  const model = createMemo(() => v2ModelFor(props.session().server.data, props.session().id))
  const views = createMemo(() => guiPanelRows(model(), usage(), now()))

  // ADR-0020 rule 3: the loader is built per chain, so the session's server
  // ref — and the client a restarted server swaps in — is read at the moment
  // the panel asks, never captured once at mount.
  const usagePanel = createUsagePanel(
    (request: UsageLoadRequest) => {
      const load = createUsageRpcLoader(props.session().server.client)
      return load(request)
    },
    {
      // The last-good store is keyed by `SessionRef.key` (`<server>\n<session>`),
      // so sessions on two servers cannot seed each other's numbers.
      cache: { key: props.sessionKey, store: globalUsageCache() },
      onChange: setUsage,
      onTick: setNow,
    },
  )

  // The completed-turn signal (#245): the data store's two turn events for the
  // watched session, subscribed through `subscribeGuiIdle` (see idle.ts).
  // `createKeyed` keys the subscription on the data object's identity, so a
  // restarted server's fresh store re-subscribes and the old subscription is
  // withdrawn with the generation's owner.
  createKeyed(
    () => props.session().server.data,
    (data) => {
      onCleanup(subscribeGuiIdle(data, props.session().id, () => usagePanel.turnCompleted()))
    },
  )

  onMount(() => {
    void usagePanel.mount()
  })
  onCleanup(() => usagePanel.unmount())

  const ui = props.ctx.ui
  return (
    <div class="cc-ru" data-component="commandcode-rates-usage">
      <Show when={views().length > 0}>
        <div class="cc-ru-head">
          <span class="cc-ru-title">{PANEL_TITLE}</span>
          <ui.Tooltip value="Refresh usage now">
            <ui.IconButton
              icon="refresh"
              label="Refresh Command Code usage"
              size="small"
              onClick={() => void usagePanel.refresh()}
            />
          </ui.Tooltip>
        </div>
        <For each={views()}>{(view) => <GuiRow view={view} />}</For>
      </Show>
    </div>
  )
}

/**
 * The tab's surface: keyed on the routed session's key, so each session gets
 * its own body (and its own controller) while the render itself stays mounted
 * as the host promises. The session arrives as a thunk because `Panel.render`'s
 * input is a reactive getter — copying the object once would freeze it.
 */
function RatesUsageSurface(props: { ctx: Context; session: () => MountedSession }) {
  return (
    <Show keyed when={props.session().key}>
      {(sessionKey: string) => (
        <SessionRatesUsage ctx={props.ctx} session={props.session} sessionKey={sessionKey} />
      )}
    </Show>
  )
}

/** Contributes the side panel: the gated tab list and the keyed render. */
export function registerRatesUsagePanel(ctx: Context): void {
  ctx.add(Panel, {
    id: PANEL_TAB_ID,
    region: "side",
    // A text panel: give it the region's narrowest width instead of the
    // conversation's, so the rows read like the TUI sidebar does.
    width: "narrow",
    list: (input) => (guiModelFor(input.session) === undefined ? [] : [TAB]),
    render: (props) => <RatesUsageSurface ctx={ctx} session={() => props.session} />,
  })
}

/** Contributes the stylesheet; the host keeps it while the plugin is loaded. */
export function registerRatesUsageStyle(ctx: Context): void {
  ctx.add(Style, RATES_USAGE_GUI_CSS)
}

/**
 * Contributes the palette command. No slash command: the desktop composer's
 * slash semantics are ambiguous (a plain prompt can be meant), unlike the TUI
 * where the slash entry exists because terminal multiplexers capture the
 * palette key. The command id publishes as `${ctx.id}.rates-usage`.
 */
export function registerRatesUsageCommand(ctx: Context): void {
  ctx.add(Command, {
    id: PANEL_TAB_ID,
    title: "Show Command Code rates and usage",
    keywords: "rates usage allowance tier deal command code",
    group: "Command Code",
    section: "session",
    run: () => openRatesUsagePanel(ctx),
  })
}

/** Contributes the + menu launcher, with the command's shortcut if bound. */
export function registerRatesUsageMenuItem(ctx: Context): void {
  ctx.add(MenuItem, {
    menu: "session.panel",
    id: PANEL_TAB_ID,
    title: PANEL_TITLE,
    icon: "status",
    keybind: `${ctx.id}.${PANEL_TAB_ID}`,
    run: () => openRatesUsagePanel(ctx),
  })
}

/** Everything the GUI half contributes, in one call for `Plugin.define`. */
export function registerRatesUsageGui(ctx: Context): void {
  registerRatesUsageStyle(ctx)
  registerRatesUsagePanel(ctx)
  registerRatesUsageCommand(ctx)
  registerRatesUsageMenuItem(ctx)
}
