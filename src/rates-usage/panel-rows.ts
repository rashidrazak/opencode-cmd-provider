// src/rates-usage/panel-rows.ts — the Rates & usage panel's row vocabulary and
// its pure composition, shared by every host that renders the panel: the TUI
// sidebar (v1 `sidebar_content`, v2 `sidebar.content`) and the OpenCode Desktop
// GUI panel. Nothing here touches a host runtime, a credential or the network,
// so the desktop window bundle can import it directly.
//
// The rows are five segments — Tier/Status, Allowance, Rates, Other Information
// and the live Usage block (issue #253). Users choose which segments show and in
// what order from the `/cmd-rates-usage` dialog, persisted per host
// (src/rates-usage/segments.ts); the composer joins the visible segments with
// exactly one blank line, skips a segment that renders no rows (Usage before its
// first load), and emits nothing when every segment is hidden.
//
// Every Command Code model gets the full fixed row set — a row the model has no
// data for reads `N/A` instead of vanishing. Models from other providers get
// nothing: the panel's visibility gate is the provider id.
import { DEAL_SOURCE_URL, PLAN_CATALOG } from "./catalog.js"
import { discountLabel, formatRate, todayIso } from "./format.js"
import {
  defaultLayout,
  visibleSegments,
  type RatesUsageLayout,
  type RatesUsageSegmentId,
} from "./segments.js"
import { renderUsageRows } from "./usage.js"
import type { UsagePanelState } from "./usage-panel.js"
import type { PlanId } from "../catalog/plans.js"

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
export type V1Model = {
  options?: { cmd?: Record<string, unknown> }
  cost?: CmdCost | undefined
}

/** The v2 panel's model slice: `settings` (v2's options rename) plus cost. */
export type V2PanelModel = {
  settings?: Readonly<Record<string, unknown>>
  cost?: readonly CmdCost[] | undefined
}

/**
 * The colour token a usage meter bar renders in, mapped by the panel to the
 * host theme's tone colours (`success`/`warning`/`error` on v1; the v2
 * theme's `text.feedback` pair, see `v2ThemeColors`).
 */
export type RatesUsageRowTone = "success" | "warning" | "error"

/**
 * One rendered sidebar line. `[label, value]` renders as `label: value`; an
 * empty value renders the label bare and emphasized (`[text, ""]` — the
 * unavailable banner; `[text, "", "heading"]` — a segment heading, underlined
 * as well); `[text, "", "value"]` renders a bare muted line with no emphasis
 * (a rate-values line or a usage subsection label); `[bar, percent, "bar",
 * tone]` renders a usage meter bar in `tone` followed by the muted percentage
 * field; `["", ""]` is the blank line between segments.
 */
export type RatesUsageRow = [
  label: string,
  value: string,
  kind?: "heading" | "value" | "bar",
  tone?: RatesUsageRowTone,
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
function ratesRows(c: Cmd, base: CmdRates | undefined): RatesUsageRow[] {
  const rows: RatesUsageRow[] = []
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
 * compose time — so `ratesUsageSegments` leaves it empty.
 */
export interface RatesUsageSegments {
  /** The `Deals unavailable` banner rows, pinned above the visible segments. */
  banner: RatesUsageRow[]
  segments: Record<RatesUsageSegmentId, RatesUsageRow[]>
}

/** The Tier/Status block: the model's tier and free/paid state. */
function statusRows(c: Cmd): RatesUsageRow[] {
  return [
    ["Tier", typeof c.tier === "string" ? tierDisplay(c.tier) : NA],
    ["Status", c.free === true ? "FREE" : c.free === false ? "Paid" : NA],
  ]
}

/** The `Allowance` block: the heading over one row per rendered plan. */
function allowanceRows(c: Cmd): RatesUsageRow[] {
  const rows: RatesUsageRow[] = [["Allowance", "", "heading"]]
  for (const plan of PLAN_IDS) {
    const value = c.allowance?.[plan]
    rows.push([planDisplay(plan), typeof value === "number" ? `$${value}/mo` : NA])
  }
  return rows
}

/** The `Rates` block: the heading over the published bands (or the base price). */
function ratesSegmentRows(c: Cmd, base: CmdRates | undefined): RatesUsageRow[] {
  return [["Rates", "", "heading"], ...ratesRows(c, base)]
}

/** The `Other Information` block: the deal and benchmark rows. */
function infoRows(c: Cmd, today: string): RatesUsageRow[] {
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
 * The panel's five segment blocks for one `cmd` payload (identical on every
 * host). The row set inside every segment is fixed: a row the payload says
 * nothing about reads `N/A` instead of vanishing. An unavailable catalog leads
 * with the banner and reads `N/A` in every segment — no half-trusted values
 * behind it. `usage` starts empty and is filled by the composer from the live
 * state; the banner is pinned by the composer while a catalog segment shows.
 */
function ratesUsageSegmentsFrom(
  cmd: Cmd | undefined,
  base: CmdRates | undefined,
  today: string,
): RatesUsageSegments {
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
  providers: readonly { id?: unknown; models?: unknown }[],
  selected: { id: string; providerID: string } | undefined,
): V1Model | undefined {
  if (!selected || selected.providerID !== PROVIDER_ID) return undefined
  const models = providers.find((provider) => provider.id === selected.providerID)?.models
  if (typeof models !== "object" || models === null) return {}
  const model = (models as Record<string, V1Model | undefined>)[selected.id]
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
export function ratesUsageSegments(
  model: V1Model | undefined,
  today: string = todayIso(),
): RatesUsageSegments | undefined {
  if (!model) return undefined
  return ratesUsageSegmentsFrom(model.options?.cmd as Cmd | undefined, baseRates(model.cost), today)
}

/**
 * The v1 default row set: `ratesUsageSegments` composed under the out-of-the-box
 * layout (every segment, historic order) with no usage state — the shape the
 * panel rendered before layouts existed. The panel itself composes the live
 * usage state and the user's layout through `panelRows`.
 */
export function ratesUsageRows(
  model: V1Model | undefined,
  today: string = todayIso(),
): RatesUsageRow[] {
  return panelRows(ratesUsageSegments(model, today), defaultLayout(), undefined)
}

/** The catalog slice `v2ModelFor` reads (the v2 TUI data store's model list). */
export interface V2ModelCandidate {
  readonly id: string
  readonly providerID: string
  readonly settings?: Readonly<Record<string, unknown>> | undefined
  readonly cost?: readonly CmdCost[] | undefined
}

/**
 * The panel's visibility gate and model resolution in one place: a selected
 * model resolves only when its provider is Command Code, and a Command Code
 * model the catalog does not list still resolves to an empty record so the
 * panel renders the full all-N/A row set. Every host's lookup (the v2 TUI data
 * store, the desktop app's server data) funnels through this so the gate cannot
 * drift between them.
 */
export function selectedCommandCodeModel(
  selected: { id: string; providerID: string } | undefined,
  models: readonly V2ModelCandidate[] | undefined,
): V2PanelModel | undefined {
  if (!selected || selected.providerID !== PROVIDER_ID) return undefined
  return (
    models?.find(
      (candidate) => candidate.providerID === selected.providerID && candidate.id === selected.id,
    ) ?? {}
  )
}

/** The v2 data slice this lookup needs — session records and the model catalog. */
export interface V2ModelLookup {
  readonly session: {
    get(sessionID: string): { model?: { id: string; providerID: string } } | undefined
  }
  readonly location: { readonly model: { list(): readonly V2ModelCandidate[] | undefined } }
}

/**
 * v2 panel lookup: resolves the session's selected model in the v2 model
 * catalog (`data.location.model`), gated to Command Code. v2 reads the selected
 * model from the session record (`model.id`/`model.providerID`). A non-Command
 * Code selection resolves to undefined (panel hidden); a Command Code model
 * missing from the catalog falls back to an empty record, so the panel renders
 * the full all-N/A row set.
 */
export function v2ModelFor(data: V2ModelLookup, sessionID: string): V2PanelModel | undefined {
  return selectedCommandCodeModel(data.session.get(sessionID)?.model, data.location.model.list())
}

/**
 * v2 segment entry: v2 renamed the model's provider-option bag to `settings`
 * (ADR-0010), which is where `enrichCommandCodeModelsV2` writes `cmd`. The
 * model-cost array's untiered entry is the base price behind the `Rates`
 * fallback (tiered entries are the over-context bands the payload already
 * publishes). Gates identically to `ratesUsageSegments`: undefined model → no
 * segments, no payload → all-N/A.
 */
export function ratesUsageSegmentsV2(
  model: V2PanelModel | undefined,
  today: string = todayIso(),
): RatesUsageSegments | undefined {
  if (!model) return undefined
  const base = model.cost?.find((entry) => entry.tier === undefined)
  return ratesUsageSegmentsFrom(model.settings?.["cmd"] as Cmd | undefined, baseRates(base), today)
}

/** The v2 default row set — `ratesUsageRows`' rule through the v2 model slice. */
export function ratesUsageRowsV2(
  model: V2PanelModel | undefined,
  today: string = todayIso(),
): RatesUsageRow[] {
  return panelRows(ratesUsageSegmentsV2(model, today), defaultLayout(), undefined)
}

/** True for the blank separator row the composer inserts between segments. */
function isBlankRow(row: RatesUsageRow): boolean {
  return row[0] === "" && row[1] === ""
}

/**
 * A segment's rows without leading/trailing blank separators, so a segment
 * that ships its own edge blanks (the usage renderer carries a leading one)
 * composes without doubling them.
 */
function trimBlankEdges(rows: readonly RatesUsageRow[]): RatesUsageRow[] {
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
  segments: RatesUsageSegments | undefined,
  layout: RatesUsageLayout,
  usage: UsagePanelState | undefined,
  now?: number,
): RatesUsageRow[] {
  if (segments === undefined) return []
  const visible = visibleSegments(layout)
  const usageRows = usage === undefined ? [] : renderUsageRows(usage.result, { now })
  const blocks = visible
    .map((segment) => trimBlankEdges(segment === "usage" ? usageRows : segments.segments[segment]))
    .filter((rows) => rows.length > 0)
  const banner = visible.some((segment) => segment !== "usage") ? segments.banner : []
  const rows: RatesUsageRow[] = [...banner]
  for (const [index, block] of blocks.entries()) {
    if (index > 0) rows.push(["", ""])
    rows.push(...block)
  }
  return rows
}
