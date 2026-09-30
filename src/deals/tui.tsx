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
import type { RGBA } from "@opentui/core"
import type { Provider } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { DEAL_SOURCE_URL, PLAN_CATALOG } from "./catalog.js"
import { discountLabel, formatRate, todayIso } from "./format.js"
import { renderUsageRows } from "./usage.js"
import {
  createUsagePanel,
  v1UsageLoader,
  type UsagePanel,
  type UsagePanelState,
} from "./tui-usage.js"
import { createUsageRpcLoader } from "./usage-rpc.js"
import type { TuiCredentialV1Input } from "./tui-credential.js"
import type { PlanId } from "../catalog/plans.js"
import type {
  V2TuiContext,
  V2TuiFeedbackColor,
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
 * Renders the `cmd` payload (identical on both hosts) into sidebar rows,
 * segmented: tier/status, an `Allowance` heading over one row per rendered
 * plan, a `Rates` heading over the published bands (or the model's actual
 * price), then an `Other Information` heading over the deal/benchmark rows —
 * blank lines between segments. The row set is fixed: every row renders for
 * every Command Code model, and a row the payload says nothing about reads
 * `N/A`. An unavailable catalog leads with the banner and reads `N/A` on every
 * row — no half-trusted values behind it.
 */
function cmdRows(cmd: Cmd | undefined, base: CmdRates | undefined, today: string): DealsRow[] {
  const unavailable = cmd?.unavailable === true
  const c: Cmd = unavailable ? {} : (cmd ?? {})
  const rows: DealsRow[] = []
  if (unavailable) {
    rows.push([`Deals unavailable — ${DEAL_SOURCE_URL}`, ""])
  }
  rows.push(["Tier", typeof c.tier === "string" ? tierDisplay(c.tier) : NA])
  rows.push(["Status", c.free === true ? "FREE" : c.free === false ? "Paid" : NA])
  rows.push(["", ""])
  rows.push(["Allowance", "", "heading"])
  for (const plan of PLAN_IDS) {
    const value = c.allowance?.[plan]
    rows.push([planDisplay(plan), typeof value === "number" ? `$${value}/mo` : NA])
  }
  rows.push(["", ""])
  rows.push(["Rates", "", "heading"])
  rows.push(...ratesRows(c, base))
  rows.push(["", ""])
  rows.push(["Other Information", "", "heading"])
  rows.push([
    "Deal",
    c.discount && typeof c.discount.pct === "number"
      ? discountLabel(
          c.discount.pct,
          typeof c.discount.endsAt === "string" ? c.discount.endsAt : undefined,
          today,
        )
      : NA,
  ])
  rows.push(["Was", rateDisplay(c.was)])
  rows.push(["Now", rateDisplay(c.now)])
  rows.push(["Intelligence", benchmarkDisplay(c.benchmark, "intelligence")])
  rows.push(["Tok/s", benchmarkDisplay(c.benchmark, "tokPerSec")])
  return rows
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
 * v1 model entry: the config hook's enrichment writes the model's provider
 * options into `options.cmd` (both for auto-registered and declared models),
 * and the host's own model cost feeds the `Rates` fallback for models whose
 * payload publishes no band. An undefined model (no selected model to speak
 * of) yields no rows — the panel's visibility gate; a resolvable model with no
 * `cmd` payload yields the full all-N/A row set.
 */
export function dealsRows(model: V1Model | undefined, today: string = todayIso()): DealsRow[] {
  if (!model) return []
  return cmdRows(model.options?.cmd as Cmd | undefined, baseRates(model.cost), today)
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
 * v2 model entry: v2 renamed the model's provider-option bag to `settings`
 * (ADR-0010), which is where `enrichCommandCodeModelsV2` writes `cmd`. The
 * model-cost array's untiered entry is the base price behind the `Rates`
 * fallback (tiered entries are the over-context bands the payload already
 * publishes). Gates identically to `dealsRows`: undefined model → no rows, no
 * payload → all-N/A.
 */
export function dealsRowsV2(
  model: V2PanelModel | undefined,
  today: string = todayIso(),
): DealsRow[] {
  if (!model) return []
  const base = model.cost?.find((entry) => entry.tier === undefined)
  return cmdRows(model.settings?.["cmd"] as Cmd | undefined, baseRates(base), today)
}

/**
 * The panel's full row list: the model's fixed deals rows, then the `Usage`
 * segment (#244). The visibility gate survives composition — an empty deals
 * row list is a non-Command Code selection (or no selection), so the panel
 * stays hidden even while a usage state exists. `now` is the segment's
 * countdown clock — the panel body hands it the 30-second tick's instant
 * (#245) so countdown text re-renders without a fetch.
 */
export function panelRows(
  deals: DealsRow[],
  usage: UsagePanelState | undefined,
  now?: number,
): DealsRow[] {
  if (deals.length === 0) return []
  // Before the first load settles there is no segment at all: an undefined
  // state is "still loading", not the resolver's miss, so no notice flashes
  // while the mount chain is in flight.
  if (usage === undefined) return deals
  return [...deals, ...renderUsageRows(usage.result, { now })]
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
      rows={() => panelRows(dealsRows(props.model()), usage(), now())}
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
function CmdPanelV2(props: { ctx: V2TuiContext; sessionID: string; model: () => V2PanelModel }) {
  const [usage, setUsage] = createSignal<UsagePanelState | undefined>(undefined)
  const [now, setNow] = createSignal(Date.now())
  const usagePanel = createUsagePanel(createUsageRpcLoader(props.ctx.client), {
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
      rows={() => panelRows(dealsRowsV2(props.model()), usage(), now())}
      text={() => colors().text}
      textMuted={() => colors().muted}
      tone={(tone) => colors()[tone]}
    />
  )
}

function DealsPanelV2(props: { ctx: V2TuiContext; sessionID: string }) {
  // Same idea as v1 against the v2 data store: `data` is the host's live
  // client-local state, so reading the session's model and the model catalog
  // inside the memo re-renders the panel when either changes.
  const model = createMemo(() => v2ModelFor(props.ctx.data, props.sessionID))
  return (
    <Show when={model()}>
      {(selected) => <CmdPanelV2 ctx={props.ctx} sessionID={props.sessionID} model={selected} />}
    </Show>
  )
}

/** v1 half: snake_case slot map registered through `api.slots`. */
const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx, props) {
        return <DealsPanelV1 api={api} session_id={props.session_id} />
      },
    },
  })
}

/** v2 half: `setup(context)` claiming the dot-separated `"sidebar.content"` path. */
const setup = (ctx: V2TuiContext): void => {
  ctx.ui.slot({
    append: "sidebar.content",
    render: (input) => <DealsPanelV2 ctx={ctx} sessionID={input.sessionID} />,
  })
}

const plugin: TuiPluginModule & V2TuiPluginDefinition = { id, tui, setup }

export default plugin
