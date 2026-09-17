/** @jsxImportSource @opentui/solid */
// src/deals/tui.tsx — TUI plugin: "Command Code" deals section in the session
// sidebar. Renders deal details from the picked model's enriched `cmd`
// (produced by the server plugin's config hook on v1 and its provider transform
// on v2). Renders nothing when the model has no deals data — zero sidebar
// noise.
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
import type { PlanId } from "../catalog/plans.js"
import type { V2TuiContext, V2TuiModel, V2TuiPluginDefinition } from "../plugin/v2-tui-types.js"

type Cmd = {
  unavailable?: unknown
  free?: unknown
  tier?: unknown
  allowance?: Record<string, unknown> | undefined
  discount?: { pct?: unknown; endsAt?: unknown } | undefined
  benchmark?: { intelligence?: unknown; tokPerSec?: unknown } | undefined
  peakOffPeak?: { windows?: unknown } | undefined
  was?: { input?: unknown; output?: unknown } | undefined
  now?: { input?: unknown; output?: unknown } | undefined
}

/** One rendered sidebar line: `[label, value]`, or `[message, ""]` for a banner. */
export type DealsRow = [string, string]

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

function rateString(rates: { input?: unknown; output?: unknown }): string | undefined {
  if (typeof rates.input !== "number" || typeof rates.output !== "number") return undefined
  return `$${rates.input}/$${rates.output} in/out`
}

/** Renders the `cmd` payload (identical on both hosts) into sidebar rows. */
function cmdRows(cmd: Cmd | undefined): DealsRow[] {
  if (!cmd) return []
  if (cmd.unavailable === true) {
    return [
      [`Deals unavailable — ${DEAL_SOURCE_URL}`, ""],
      ["Tier", "—"],
      ["Intelligence", "—"],
      ["Tok/s", "—"],
    ]
  }
  const rows: DealsRow[] = []
  if (typeof cmd.tier === "string") rows.push(["Tier", tierDisplay(cmd.tier)])
  if (cmd.free === true) rows.push(["Status", "FREE"])
  if (cmd.allowance) {
    for (const [plan, value] of Object.entries(cmd.allowance)) {
      if (typeof value === "number") rows.push([`${planDisplay(plan)} allowance`, `$${value}/mo`])
    }
  }
  if (cmd.discount && typeof cmd.discount.pct === "number") {
    rows.push([
      "Deal",
      `${cmd.discount.pct}% off${typeof cmd.discount.endsAt === "string" ? ` until ${cmd.discount.endsAt}` : ""}`,
    ])
  }
  const was = cmd.was ? rateString(cmd.was) : undefined
  const now = cmd.now ? rateString(cmd.now) : undefined
  if (was) rows.push(["Was", was])
  if (now) rows.push(["Now", now])
  if (cmd.benchmark) {
    rows.push([
      "Intelligence",
      typeof cmd.benchmark.intelligence === "number" ? String(cmd.benchmark.intelligence) : "—",
    ])
    rows.push([
      "Tok/s",
      typeof cmd.benchmark.tokPerSec === "number" ? String(cmd.benchmark.tokPerSec) : "—",
    ])
  }
  if (cmd.peakOffPeak) {
    rows.push([
      "Rates",
      `peak/off-peak${typeof cmd.peakOffPeak.windows === "string" ? ` (${cmd.peakOffPeak.windows})` : ""}`,
    ])
  }
  return rows
}

/**
 * v1 model entry: the config hook's enrichment writes the model's provider
 * options into `options.cmd` (both for auto-registered and declared models).
 */
export function dealsRows(
  model: { options?: { cmd?: Record<string, unknown> } } | undefined,
): DealsRow[] {
  return cmdRows(model?.options?.cmd as Cmd | undefined)
}

/**
 * v2 model entry: v2 renamed the model's provider-option bag to `settings`
 * (ADR-0010), which is where `enrichCommandCodeModelsV2` writes `cmd`.
 */
export function dealsRowsV2(
  model: { settings?: Readonly<Record<string, unknown>> } | undefined,
): DealsRow[] {
  return cmdRows(model?.settings?.["cmd"] as Cmd | undefined)
}

const id = "commandcode.deals"

/**
 * Resolves the session's selected model in the v2 model catalog. v2 reads the
 * selected model from the session record (`model.id`/`model.providerID`) and the
 * catalog from `data.location.model` — the v2 counterpart of v1's
 * `state.session` × `state.provider` lookup.
 */
export function v2ModelFor(data: V2TuiContext["data"], sessionID: string): V2TuiModel | undefined {
  const current = data.session.get(sessionID)?.model
  if (!current) return undefined
  return data.location.model
    .list()
    ?.find(
      (candidate: V2TuiModel) =>
        candidate.providerID === current.providerID && candidate.id === current.id,
    )
}

/** The panel itself, shared by both hosts: rows in, theme colours in. */
function DealsPanel(props: { rows: () => DealsRow[]; text: () => RGBA; textMuted: () => RGBA }) {
  return (
    <Show when={props.rows().length > 0}>
      <box>
        <text fg={props.text()}>
          <b>Command Code</b>
        </text>
        <For each={props.rows()}>
          {(row) => <text fg={props.textMuted()}>{row[1] ? `${row[0]}: ${row[1]}` : row[0]}</text>}
        </For>
      </box>
    </Show>
  )
}

function DealsPanelV1(props: { api: TuiPluginApi; session_id: string }) {
  // Mid-session model switches update the session record (`session.updated`
  // reconciles it into the sync store), so reading `session.model` reactively
  // is enough — no event subscription needed.
  const model = createMemo(() => {
    const current = props.api.state.session.get(props.session_id)?.model
    if (!current) return undefined
    return props.api.state.provider.find((provider: Provider) => provider.id === current.providerID)
      ?.models[current.id]
  })
  return (
    <DealsPanel
      rows={() => dealsRows(model())}
      text={() => props.api.theme.current.text}
      textMuted={() => props.api.theme.current.textMuted}
    />
  )
}

function DealsPanelV2(props: { ctx: V2TuiContext; sessionID: string }) {
  // Same idea as v1 against the v2 data store: `data` is the host's live
  // client-local state, so reading the session's model and the model catalog
  // inside the memo re-renders the panel when either changes.
  const model = createMemo(() => v2ModelFor(props.ctx.data, props.sessionID))
  return (
    <DealsPanel
      rows={() => dealsRowsV2(model())}
      text={() => props.ctx.theme.text.default}
      textMuted={() => props.ctx.theme.text.subdued}
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
