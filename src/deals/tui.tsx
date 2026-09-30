/** @jsxImportSource @opentui/solid */
// src/deals/tui.tsx — TUI plugin: "Command Code" deals section in the session
// sidebar. Renders deal details from the picked model's enriched `cmd`
// (produced by the server plugin's config hook on v1 and its provider transform
// on v2), plus the live `Usage` segment (issues #244/#245, src/deals/tui-usage.ts):
// fetched once per panel mount, then refreshed on completed turns and window
// rolls — never polled — with a local 30-second countdown clock. Every Command
// Code model gets the full fixed row set — a row the model has no data for
// reads `N/A` instead of vanishing. Models from other providers get nothing:
// the panel's visibility gate is the provider id.
//
// The panel's rows are five segments — Tier/Status, Allowance, Rates, Other
// Information and the live Usage block (issue #253). Users choose which
// segments show and in what order from the palette command `/cmd-deals`
// (`Show, hide and reorder sidebar content`): exactly one blank line separates
// any two visible segments, a segment with no rows (Usage before its first
// load) leaves no gap, and with every segment hidden the panel hides
// entirely. The layout persists per machine (v1 `api.kv`,
// v2 `ctx.storage.store`) and is normalized on every read, so a value from
// another release can never crash or hide a segment by accident
// (src/deals/segments.ts).
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
import { DEAL_SOURCE_URL, PLAN_CATALOG } from "./catalog.js"
import { discountLabel, formatRate, todayIso } from "./format.js"
import {
  DEALS_LAYOUT_KEY,
  DEALS_SEGMENT_LABELS,
  defaultLayout,
  moveSegment,
  normalizeLayout,
  resetLayout,
  segmentKeyIntent,
  toggleSegment,
  visibleSegments,
  type DealsLayout,
  type DealsSegmentId,
  type SegmentsKeyIntent,
} from "./segments.js"
import { renderUsageRows } from "./usage.js"
import {
  createUsagePanel,
  v1UsageLoader,
  type UsagePanel,
  type UsagePanelState,
} from "./tui-usage.js"
import { createUsageRpcLoader } from "./usage-rpc.js"
import { globalUsageCache } from "./usage-cache.js"
import type { TuiCredentialV1Input } from "./tui-credential.js"
import type { PlanId } from "../catalog/plans.js"
import type {
  V2TuiContext,
  V2TuiFeedbackColor,
  V2TuiKeymapCommand,
  V2TuiModel,
  V2TuiPluginDefinition,
  V2TuiTheme,
} from "../plugin/v2-tui-types.js"

type CmdRates = {
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
}

type Cmd = {
  unavailable?: unknown
  free?: unknown
  tier?: unknown
  allowance?: Record<string, unknown> | undefined
  discount?: { pct?: unknown; endsAt?: unknown } | undefined
  benchmark?: { intelligence?: unknown; tokPerSec?: unknown } | undefined
  peakOffPeak?: { peak?: CmdRates; offPeak?: CmdRates; windows?: unknown } | undefined
  contextTiers?: Array<{ label?: unknown; context?: unknown; rates?: CmdRates }> | undefined
  was?: { input?: unknown; output?: unknown } | undefined
  now?: { input?: unknown; output?: unknown } | undefined
}

/**
 * One model-cost record as the hosts' model catalogs shape it: v1 keeps one
 * record per model, v2 an array of context tiers whose untiered entry is the
 * base price. The panel reads it for the `Rates` fallback when the payload
 * publishes no band.
 */
type CmdCost = {
  tier?: unknown
  input?: unknown
  output?: unknown
  cache?: { read?: unknown; write?: unknown } | undefined
}

/** The v1 panel's model slice: the host's provider options plus its cost. */
type V1Model = { options?: { cmd?: Record<string, unknown> }; cost?: CmdCost | undefined }

/** The v2 panel's model slice: `settings` (v2's options rename) plus cost. */
type V2PanelModel = {
  settings?: Readonly<Record<string, unknown>>
  cost?: readonly CmdCost[] | undefined
}

/**
 * The colour token a usage meter bar renders in, mapped by the panel to the
 * host theme's tone colours (`success`/`warning`/`error` on v1; the v2
 * theme's `text.feedback` pair, see `v2ThemeColors`).
 */
export type DealsRowTone = "success" | "warning" | "error"

/**
 * One rendered sidebar line. `[label, value]` renders as `label: value`; an
 * empty value renders the label bare and emphasized (`[text, ""]` — the
 * unavailable banner; `[text, "", "heading"]` — a segment heading, underlined
 * as well); `[text, "", "value"]` renders a bare muted line with no emphasis
 * (a rate-values line or a usage subsection label); `[bar, percent, "bar",
 * tone]` renders a usage meter bar in `tone` followed by the muted percentage
 * field; `["", ""]` is the blank line between segments.
 */
export type DealsRow = [
  label: string,
  value: string,
  kind?: "heading" | "value" | "bar",
  tone?: DealsRowTone,
]

/** Value of a row the model has nothing to say about. */
const NA = "N/A"

/** Provider id both hosts register under — the panel's visibility gate. */
const PROVIDER_ID = "commandcode"

/**
 * Plans the Allowance segment hides. Pro (legacy) and Provider keep their
 * catalog rows and their allowance data — the payload still carries them for
 * the plan-summary tool and the transport — but they are never rendered as
 * panel rows.
 */
const HIDDEN_ALLOWANCE_PLANS: ReadonlySet<PlanId> = new Set(["prolegacy", "provider"])

/** Every rendered allowance row, in PLAN_CATALOG declaration order (go → teampro). */
const PLAN_IDS = (Object.keys(PLAN_CATALOG) as PlanId[]).filter(
  (plan) => !HIDDEN_ALLOWANCE_PLANS.has(plan),
)

function planDisplay(plan: string): string {
  return PLAN_CATALOG[plan as PlanId]?.display ?? plan
}

const TIER_DISPLAY: Readonly<Record<string, string>> = {
  opensource: "Open Source",
  premium: "Premium",
}

function tierDisplay(tier: string): string {
  return TIER_DISPLAY[tier] ?? tier
}

/** Deal rates, rounded for display (format.ts explains the residue). */
function rateString(rates: { input?: unknown; output?: unknown }): string | undefined {
  if (typeof rates.input !== "number" || typeof rates.output !== "number") return undefined
  return `$${formatRate(rates.input)}/$${formatRate(rates.output)} in/out`
}

function rateDisplay(rates: { input?: unknown; output?: unknown } | undefined): string {
  if (!rates) return NA
  return rateString(rates) ?? NA
}

function benchmarkDisplay(benchmark: Cmd["benchmark"], key: "intelligence" | "tokPerSec"): string {
  const value = benchmark?.[key]
  return typeof value === "number" ? String(value) : NA
}

/** A band's four rates as the values line: `$in | $out | $cacheRead | $cacheWrite`. */
function rateValues(rates: CmdRates | undefined): string {
  if (
    !rates ||
    typeof rates.input !== "number" ||
    typeof rates.output !== "number" ||
    typeof rates.cacheRead !== "number" ||
    typeof rates.cacheWrite !== "number"
  ) {
    return NA
  }
  return `$${formatRate(rates.input)} | $${formatRate(rates.output)} | $${formatRate(rates.cacheRead)} | $${formatRate(rates.cacheWrite)}`
}

/** The column-label line a rate band (or the price fallback) prints. */
const RATE_COLUMNS = "in | out | cache r | w"

/**
 * The `Rates` segment body: published bands (time-of-day and/or context
 * windows) as label/value blocks — `Peak: in | out | cache r | w` over its
 * pipe-separated values — the `Peak Windows` schedule as its own block, and,
 * when no band is published, the model's own price (the host model cost every
 * model record carries) in the same two-line shape. Blank lines separate the
 * blocks.
 */
function ratesRows(c: Cmd, base: CmdRates | undefined): DealsRow[] {
  const rows: DealsRow[] = []
  const band = (name: string, rates: CmdRates | undefined) => {
    if (rows.length > 0) rows.push(["", ""])
    rows.push([name, RATE_COLUMNS])
    rows.push([rateValues(rates), "", "value"])
  }
  const tod = c.peakOffPeak
  if (tod) {
    band("Peak", tod.peak)
    band("Off-peak", tod.offPeak)
    if (typeof tod.windows === "string") {
      rows.push(["", ""])
      rows.push(["Peak Windows", "", "value"])
      rows.push([tod.windows, "", "value"])
    }
  }
  if (Array.isArray(c.contextTiers)) {
    for (const tier of c.contextTiers) {
      const label =
        typeof tier.context === "string" && tier.context !== ""
          ? tier.context
          : typeof tier.label === "string" && tier.label !== ""
            ? tier.label
            : undefined
      if (label === undefined) continue
      band(label, tier.rates)
    }
  }
  if (rows.length === 0) {
    rows.push([RATE_COLUMNS, "", "value"])
    rows.push([rateValues(base), "", "value"])
  }
  return rows
}

/**
 * One rendered segment block; the composer joins them. The Usage block is not
 * built from the payload — the panel fills it from the live usage state at
 * compose time — so `dealSegments` leaves it empty.
 */
export interface DealsSegments {
  /** The `Deals unavailable` banner rows, pinned above the visible segments. */
  banner: DealsRow[]
  segments: Record<DealsSegmentId, DealsRow[]>
}

/** The Tier/Status block: the model's tier and free/paid state. */
function statusRows(c: Cmd): DealsRow[] {
  return [
    ["Tier", typeof c.tier === "string" ? tierDisplay(c.tier) : NA],
    ["Status", c.free === true ? "FREE" : c.free === false ? "Paid" : NA],
  ]
}

/** The `Allowance` block: the heading over one row per rendered plan. */
function allowanceRows(c: Cmd): DealsRow[] {
  const rows: DealsRow[] = [["Allowance", "", "heading"]]
  for (const plan of PLAN_IDS) {
    const value = c.allowance?.[plan]
    rows.push([planDisplay(plan), typeof value === "number" ? `$${value}/mo` : NA])
  }
  return rows
}

/** The `Rates` block: the heading over the published bands (or the base price). */
function ratesSegmentRows(c: Cmd, base: CmdRates | undefined): DealsRow[] {
  return [["Rates", "", "heading"], ...ratesRows(c, base)]
}

/** The `Other Information` block: the deal and benchmark rows. */
function infoRows(c: Cmd, today: string): DealsRow[] {
  return [
    ["Other Information", "", "heading"],
    [
      "Deal",
      c.discount && typeof c.discount.pct === "number"
        ? discountLabel(
            c.discount.pct,
            typeof c.discount.endsAt === "string" ? c.discount.endsAt : undefined,
            today,
          )
        : NA,
    ],
    ["Was", rateDisplay(c.was)],
    ["Now", rateDisplay(c.now)],
    ["Intelligence", benchmarkDisplay(c.benchmark, "intelligence")],
    ["Tok/s", benchmarkDisplay(c.benchmark, "tokPerSec")],
  ]
}

/**
 * The panel's five segment blocks for one `cmd` payload (identical on both
 * hosts). The row set inside every segment is fixed: a row the payload says
 * nothing about reads `N/A` instead of vanishing. An unavailable catalog leads
 * with the banner and reads `N/A` in every segment — no half-trusted values
 * behind it. `usage` starts empty and is filled by the composer from the live
 * state; the banner is pinned by the composer while a catalog segment shows.
 */
function dealSegmentsFrom(cmd: Cmd | undefined, base: CmdRates | undefined, today: string): DealsSegments {
  const unavailable = cmd?.unavailable === true
  const c: Cmd = unavailable ? {} : (cmd ?? {})
  return {
    banner: unavailable ? [[`Deals unavailable — ${DEAL_SOURCE_URL}`, ""]] : [],
    segments: {
      status: statusRows(c),
      allowance: allowanceRows(c),
      rates: ratesSegmentRows(c, base),
      info: infoRows(c, today),
      usage: [],
    },
  }
}

/**
 * Normalizes a host model-cost record to the four-rate payload shape. Fields
 * stay `unknown` — `rateValues` validates, so a half-shaped record reads `N/A`,
 * never `$undefined`.
 */
function baseRates(cost: CmdCost | undefined): CmdRates | undefined {
  if (!cost) return undefined
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cache?.read,
    cacheWrite: cost.cache?.write,
  }
}

/**
 * v1 panel lookup: the selected model record, gated to Command Code. Any other
 * provider resolves to undefined — the panel stays hidden. A Command Code model
 * the host cannot resolve falls back to an empty record, so the panel renders
 * the full all-N/A row set rather than disappearing.
 */
export function v1ModelFor(
  providers: readonly Provider[],
  selected: { id: string; providerID: string } | undefined,
): V1Model | undefined {
  if (!selected || selected.providerID !== PROVIDER_ID) return undefined
  const model = providers.find((provider) => provider.id === selected.providerID)?.models[
    selected.id
  ]
  return model ?? {}
}

/**
 * v1 segment entry: the config hook's enrichment writes the model's provider
 * options into `options.cmd` (both for auto-registered and declared models),
 * and the host's own model cost feeds the `Rates` fallback for models whose
 * payload publishes no band. An undefined model (no selected model to speak
 * of) yields no segments — the panel's visibility gate; a resolvable model
 * with no `cmd` payload yields the full all-N/A segment set.
 */
export function dealSegments(
  model: V1Model | undefined,
  today: string = todayIso(),
): DealsSegments | undefined {
  if (!model) return undefined
  return dealSegmentsFrom(model.options?.cmd as Cmd | undefined, baseRates(model.cost), today)
}

/**
 * The v1 default row set: `dealSegments` composed under the out-of-the-box
 * layout (every segment, historic order) with no usage state — the shape the
 * panel rendered before layouts existed. The panel itself composes the live
 * usage state and the user's layout through `panelRows`.
 */
export function dealsRows(model: V1Model | undefined, today: string = todayIso()): DealsRow[] {
  return panelRows(dealSegments(model, today), defaultLayout(), undefined)
}

/**
 * v2 panel lookup: resolves the session's selected model in the v2 model
 * catalog (`data.location.model`), gated to Command Code. v2 reads the selected
 * model from the session record (`model.id`/`model.providerID`). A non-Command
 * Code selection resolves to undefined (panel hidden); a Command Code model
 * missing from the catalog falls back to an empty record, so the panel renders
 * the full all-N/A row set.
 */
export function v2ModelFor(
  data: V2TuiContext["data"],
  sessionID: string,
): V2PanelModel | undefined {
  const current = data.session.get(sessionID)?.model
  if (!current || current.providerID !== PROVIDER_ID) return undefined
  return (
    data.location.model
      .list()
      ?.find(
        (candidate: V2TuiModel) =>
          candidate.providerID === current.providerID && candidate.id === current.id,
      ) ?? {}
  )
}

/**
 * v2 segment entry: v2 renamed the model's provider-option bag to `settings`
 * (ADR-0010), which is where `enrichCommandCodeModelsV2` writes `cmd`. The
 * model-cost array's untiered entry is the base price behind the `Rates`
 * fallback (tiered entries are the over-context bands the payload already
 * publishes). Gates identically to `dealSegments`: undefined model → no
 * segments, no payload → all-N/A.
 */
export function dealSegmentsV2(
  model: V2PanelModel | undefined,
  today: string = todayIso(),
): DealsSegments | undefined {
  if (!model) return undefined
  const base = model.cost?.find((entry) => entry.tier === undefined)
  return dealSegmentsFrom(model.settings?.["cmd"] as Cmd | undefined, baseRates(base), today)
}

/** The v2 default row set — `dealsRows`' rule through the v2 model slice. */
export function dealsRowsV2(
  model: V2PanelModel | undefined,
  today: string = todayIso(),
): DealsRow[] {
  return panelRows(dealSegmentsV2(model, today), defaultLayout(), undefined)
}

/** True for the blank separator row the composer inserts between segments. */
function isBlankRow(row: DealsRow): boolean {
  return row[0] === "" && row[1] === ""
}

/**
 * A segment's rows without leading/trailing blank separators, so a segment
 * that ships its own edge blanks (the usage renderer carries a leading one)
 * composes without doubling them.
 */
function trimBlankEdges(rows: readonly DealsRow[]): DealsRow[] {
  let start = 0
  let end = rows.length
  while (start < end) {
    const first = rows[start]
    if (first === undefined || !isBlankRow(first)) break
    start += 1
  }
  while (end > start) {
    const last = rows[end - 1]
    if (last === undefined || !isBlankRow(last)) break
    end -= 1
  }
  return rows.slice(start, end)
}

/**
 * The panel's full row list (issues #244, #253): the segments the user's
 * layout renders, in the layout's order, joined by exactly one blank line —
 * a segment with no rows (still-loading Usage, or one that renders empty)
 * leaves no gap, and every segment hidden reads `[]`, so the panel hides
 * entirely. The visibility gate survives composition: an undefined `segments`
 * (a non-Command Code selection, or no selection) means no panel even while a
 * usage state exists. The `Deals unavailable` banner stays pinned above the
 * segments, but only while at least one catalog segment (anything but Usage)
 * is visible — a Usage-only panel carries no catalog warning. `now` is the
 * countdown clock the panel body hands in from its 30-second tick (#245).
 */
export function panelRows(
  segments: DealsSegments | undefined,
  layout: DealsLayout,
  usage: UsagePanelState | undefined,
  now?: number,
): DealsRow[] {
  if (segments === undefined) return []
  const visible = visibleSegments(layout)
  const usageRows = usage === undefined ? [] : renderUsageRows(usage.result, { now })
  const blocks = visible
    .map((segment) => trimBlankEdges(segment === "usage" ? usageRows : segments.segments[segment]))
    .filter((rows) => rows.length > 0)
  const banner = visible.some((segment) => segment !== "usage") ? segments.banner : []
  const rows: DealsRow[] = [...banner]
  for (const [index, block] of blocks.entries()) {
    if (index > 0) rows.push(["", ""])
    rows.push(...block)
  }
  return rows
}

const id = "commandcode.deals"

/** The panel itself, shared by both hosts: rows in, theme colours in. */
function DealsPanel(props: {
  rows: () => DealsRow[]
  text: () => RGBA
  textMuted: () => RGBA
  tone: (tone: DealsRowTone) => RGBA
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
export function v1Layout(api: TuiPluginApi): DealsLayout {
  return normalizeLayout(api.kv.get(DEALS_LAYOUT_KEY))
}

/** Persists a v1 layout; the KV store writes through to `state/kv.json`. */
export function saveV1Layout(api: TuiPluginApi, layout: DealsLayout): void {
  api.kv.set(DEALS_LAYOUT_KEY, layout)
}

/** The v2 layout store the panel and the dialog share. */
export interface V2LayoutStore {
  layout: () => DealsLayout
  save: (layout: DealsLayout) => void
}

/**
 * Creates the v2 layout store once per plugin activation: the host persists
 * and live-syncs it, namespacing the key with the plugin id itself. The
 * normalized read tolerates a shape from another release; a save rewrites
 * both arrays so the stored value stays the plain JSON shape.
 */
export function createV2LayoutStore(ctx: V2TuiContext): V2LayoutStore {
  const [stored, mutate] = ctx.storage.store(DEALS_LAYOUT_KEY, { initial: defaultLayout() })
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
  layout: () => DealsLayout
  save: (layout: DealsLayout) => void
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
                  {active() ? <b>{DEALS_SEGMENT_LABELS[segment]}</b> : DEALS_SEGMENT_LABELS[segment]}
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
  const name = (intent: SegmentsKeyIntent) => `commandcode.deals.segments.${intent}`
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
        name: "commandcode.deals.segments",
        title: "Show, hide and reorder sidebar content",
        category: "Command Code",
        slash: { name: "cmd-deals" },
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
 * One panel body's lifecycle, shared by both halves (#245): subscribe the
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
    <DealsPanel
      rows={() => panelRows(dealSegments(props.model()), v1Layout(props.api), usage(), now())}
      text={() => props.api.theme.current.text}
      textMuted={() => props.api.theme.current.textMuted}
      tone={(tone) => props.api.theme.current[tone]}
    />
  )
}

function DealsPanelV1(props: { api: TuiPluginApi; session_id: string }) {
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
    <DealsPanel
      rows={() => panelRows(dealSegmentsV2(props.model()), props.layout.layout(), usage(), now())}
      text={() => colors().text}
      textMuted={() => colors().muted}
      tone={(tone) => colors()[tone]}
    />
  )
}

function DealsPanelV2(props: { ctx: V2TuiContext; sessionID: string; layout: V2LayoutStore }) {
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
        return <DealsPanelV1 api={api} session_id={props.session_id} />
      },
    },
  })
}

/**
 * The v2 command entry (issue #253): `palette: true` surfaces it in the host
 * command palette, `slash` in prompt slash completion — so the dialog is
 * reachable as `/cmd-deals` even when the palette shortcut is captured by the
 * terminal multiplexer around the TUI. The title carries the whole wording on
 * purpose: the palette renders a description inline after the title and a
 * second line of copy only truncates, so the row and the slash completion
 * both read the same single sentence.
 */
export function v2SegmentsCommand(
  ctx: V2TuiContext,
  layout: V2LayoutStore,
): V2TuiKeymapCommand {
  return {
    id: "commandcode.deals.segments",
    title: "Show, hide and reorder sidebar content",
    group: "Command Code",
    palette: true,
    slash: { name: "cmd-deals" },
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
    render: (input) => <DealsPanelV2 ctx={ctx} sessionID={input.sessionID} layout={layout} />,
  })
}

const plugin: TuiPluginModule & V2TuiPluginDefinition = { id, tui, setup }

export default plugin
