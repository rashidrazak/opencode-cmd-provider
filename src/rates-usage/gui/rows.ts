// src/rates-usage/gui/rows.ts — the desktop panel's view model: the shared row
// vocabulary (src/rates-usage/panel-rows.ts) mapped onto the DOM classes the
// GUI half renders. Pure and SDK-free, so the unit tests import it directly —
// panel.tsx, which touches `@opencode/plugin/gui`, is only ever exercised
// through the built bundle (tests/gui-panel.test.ts evaluates it the way the
// desktop host does).
//
// The desktop panel always renders the out-of-the-box layout: every segment,
// historic order. The TUI's segment settings dialog persists through host
// storage that needs an Effect Schema (see ADR-0025); until the window entry
// can carry one without the root effect@beta/host-4.1 split, the desktop half
// renders the fixed default.
import {
  panelRows,
  ratesUsageSegmentsV2,
  type RatesUsageRow,
  type V2PanelModel,
} from "../panel-rows.js"
import { defaultLayout } from "../segments.js"
import type { UsagePanelState } from "../usage-panel.js"
import { RATES_USAGE_COMPONENT_NAME } from "./styles.js"

export { RATES_USAGE_COMPONENT_NAME }

/**
 * One row as the DOM renders it. `gap` is the blank line between segments;
 * `heading` the underlined segment heading; `strong` a bare emphasized line
 * (the unavailable banner); `value` a bare muted mono line (rate values,
 * subsection labels); `row` a label/value grid row; `bar` the mono usage bar
 * (`label` carries the cells, `detail` the percentage) in `tone`.
 */
export interface GuiRowView {
  readonly kind: "gap" | "heading" | "strong" | "value" | "row" | "bar"
  readonly label: string
  readonly detail: string
  readonly tone?: RatesUsageRow[3]
}

/** Maps one shared row onto its view record; the single place the kinds meet. */
export function guiRowView(row: RatesUsageRow): GuiRowView {
  const [label, value, kind, tone] = row
  if (label === "" && value === "") return { kind: "gap", label: "", detail: "" }
  if (kind === "bar") return { kind: "bar", label, detail: value, tone: tone ?? "success" }
  if (kind === "heading") return { kind: "heading", label, detail: "" }
  if (kind === "value") return { kind: "value", label, detail: "" }
  if (value === "") return { kind: "strong", label, detail: "" }
  return { kind: "row", label, detail: value }
}

/** The panel's full row list as view records (same composition as the TUI). */
export function guiRowViews(rows: readonly RatesUsageRow[]): GuiRowView[] {
  return rows.map(guiRowView)
}

/**
 * The panel body's rows for one selected model and live usage state: the v2
 * segment composition under the fixed default layout — the same
 * `panelRows(ratesUsageSegmentsV2(model), …)` call the TUI makes, so a Command
 * Code model renders the identical rows in the identical order on both hosts,
 * and a non-Command Code selection renders none (the visibility gate).
 */
export function guiPanelRows(
  model: V2PanelModel | undefined,
  usage: UsagePanelState | undefined,
  now?: number,
): GuiRowView[] {
  return guiRowViews(panelRows(ratesUsageSegmentsV2(model), defaultLayout(), usage, now))
}
