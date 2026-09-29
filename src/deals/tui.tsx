/** @jsxImportSource @opentui/solid */
// src/deals/tui.tsx — TUI plugin: "Command Code" deals section in the session
// sidebar. Renders deal details from the picked model's enriched `cmd`
// (produced by the server plugin's config hook on v1 and its provider transform
// on v2). Every Command Code model gets the full fixed row set — a row the
// model has no data for reads `N/A` instead of vanishing. Models from other
// providers get nothing: the panel's visibility gate is the provider id.
//
// Two hosts, two TUI contracts (ADR-0010), one default export:
//   v1  `{ id, tui(api) }`        — `api.slots.register({ slots: { sidebar_content } })`
//   v2  `{ id, setup(context) }`  — `context.ui.slot({ append: "sidebar.content" })`
// v2 validates the module before activating it (`id` + `setup`), so a v1-only
// module is rejected outright and the sidebar never appears — the reason both
// halves ship from this file. v1's reader only inspects `id`/`server`/`tui`, so
// the extra `setup` is invisible to it (tests/contract.test.ts pins both).
import { For, Show, createMemo } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { Provider } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { DEAL_SOURCE_URL, PLAN_CATALOG } from "./catalog.js"
import { discountLabel, formatRate, todayIso } from "./format.js"
import type { PlanId } from "../catalog/plans.js"
import type {
  V2TuiContext,
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
 * One rendered sidebar line. `[label, value]` renders as `label: value`; an
 * empty value renders the label bare and emphasized (`[text, ""]` — the
 * unavailable banner; `[text, "", "heading"]` — a segment heading, underlined
 * as well); `["", ""]` is the blank line between segments.
 */
export type DealsRow = [label: string, value: string, kind?: "heading"]

/** Value of a row the model has nothing to say about. */
const NA = "N/A"

/** Provider id both hosts register under — the panel's visibility gate. */
const PROVIDER_ID = "commandcode"

/** Every allowance row, in PLAN_CATALOG declaration order (go → provider). */
const PLAN_IDS = Object.keys(PLAN_CATALOG) as PlanId[]

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

/** A full four-rate row: `$in/$out/$cacheRead/$cacheWrite in/out/cache`. */
function rateAll(rates: CmdRates | undefined): string {
  if (
    !rates ||
    typeof rates.input !== "number" ||
    typeof rates.output !== "number" ||
    typeof rates.cacheRead !== "number" ||
    typeof rates.cacheWrite !== "number"
  ) {
    return NA
  }
  return `$${formatRate(rates.input)}/$${formatRate(rates.output)}/$${formatRate(rates.cacheRead)}/$${formatRate(rates.cacheWrite)} in/out/cache`
}

/**
 * The `Rates` segment: published time-of-day bands (peak/off-peak) and/or
 * context-window bands, each row labeled by its window/threshold. A model with
 * neither keeps the plain `Rates: N/A` row. A blank line leads the segment,
 * separating pricing bands from the deal/benchmark rows above.
 */
function ratesRows(c: Cmd): DealsRow[] {
  const rates: DealsRow[] = []
  const tod = c.peakOffPeak
  if (tod) {
    rates.push(["Peak", rateAll(tod.peak)])
    rates.push(["Off-peak", rateAll(tod.offPeak)])
    if (typeof tod.windows === "string") rates.push(["Windows", tod.windows])
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
      rates.push([label, rateAll(tier.rates)])
    }
  }
  if (rates.length === 0)
    return [
      ["", ""],
      ["Rates", NA],
    ]
  return [["", ""], ["Rates", "", "heading"], ...rates]
}

/**
 * Renders the `cmd` payload (identical on both hosts) into sidebar rows,
 * segmented: tier/status, an `Allowance` heading over one row per plan, then the
 * deal/benchmark rows — blank lines between segments. The row set is fixed:
 * every row renders for every Command Code model, and a row the payload says
 * nothing about reads `N/A`. An unavailable catalog leads with the banner and
 * reads `N/A` on every row — no half-trusted values behind it.
 */
function cmdRows(cmd: Cmd | undefined, today: string): DealsRow[] {
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
  rows.push(...ratesRows(c))
  return rows
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
): { options?: { cmd?: Record<string, unknown> } } | undefined {
  if (!selected || selected.providerID !== PROVIDER_ID) return undefined
  const model = providers.find((provider) => provider.id === selected.providerID)?.models[
    selected.id
  ]
  return model ?? {}
}

/**
 * v1 model entry: the config hook's enrichment writes the model's provider
 * options into `options.cmd` (both for auto-registered and declared models).
 * An undefined model (no selected model to speak of) yields no rows — the
 * panel's visibility gate; a resolvable model with no `cmd` payload yields the
 * full all-N/A row set.
 */
export function dealsRows(
  model: { options?: { cmd?: Record<string, unknown> } } | undefined,
  today: string = todayIso(),
): DealsRow[] {
  if (!model) return []
  return cmdRows(model.options?.cmd as Cmd | undefined, today)
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
): { settings?: Readonly<Record<string, unknown>> } | undefined {
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
 * (ADR-0010), which is where `enrichCommandCodeModelsV2` writes `cmd`. Gates
 * identically to `dealsRows`: undefined model → no rows, no payload → all-N/A.
 */
export function dealsRowsV2(
  model: { settings?: Readonly<Record<string, unknown>> } | undefined,
  today: string = todayIso(),
): DealsRow[] {
  if (!model) return []
  return cmdRows(model.settings?.["cmd"] as Cmd | undefined, today)
}

const id = "commandcode.deals"

/** The panel itself, shared by both hosts: rows in, theme colours in. */
function DealsPanel(props: { rows: () => DealsRow[]; text: () => RGBA; textMuted: () => RGBA }) {
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

function DealsPanelV1(props: { api: TuiPluginApi; session_id: string }) {
  // Mid-session model switches update the session record (`session.updated`
  // reconciles it into the sync store), so reading `session.model` reactively
  // is enough — no event subscription needed.
  const model = createMemo(() =>
    v1ModelFor(props.api.state.provider, props.api.state.session.get(props.session_id)?.model),
  )
  return (
    <DealsPanel
      rows={() => dealsRows(model())}
      text={() => props.api.theme.current.text}
      textMuted={() => props.api.theme.current.textMuted}
    />
  )
}

/**
 * The panel's two text colours, across the v2 theme rename (see
 * `V2TuiThemeText`): `base`/`muted` on `@opencode/theme@2.0.8`+,
 * `default`/`subdued` on 2.0.3–2.0.7. Reading only one spelling would hand
 * the renderer `undefined` on the hosts exposing the other, and `undefined`
 * paints as the terminal default — the plain white sidebar on v2.0.8+.
 */
export function v2ThemeColors(theme: V2TuiTheme): { text: RGBA; muted: RGBA } {
  const text = theme.text
  return "base" in text
    ? { text: text.base, muted: text.muted }
    : { text: text.default, muted: text.subdued }
}

function DealsPanelV2(props: { ctx: V2TuiContext; sessionID: string }) {
  // Same idea as v1 against the v2 data store: `data` is the host's live
  // client-local state, so reading the session's model and the model catalog
  // inside the memo re-renders the panel when either changes.
  const model = createMemo(() => v2ModelFor(props.ctx.data, props.sessionID))
  const colors = () => v2ThemeColors(props.ctx.theme)
  return (
    <DealsPanel
      rows={() => dealsRowsV2(model())}
      text={() => colors().text}
      textMuted={() => colors().muted}
    />
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
