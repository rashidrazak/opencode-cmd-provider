/** @jsxImportSource @opentui/solid */
// src/tui/index.tsx — TUI plugin: "Command Code" deals section in the session
// sidebar (sidebar_content slot). Renders deal details from the picked model's
// enriched options.cmd (produced by the server plugin's config hook). Renders
// nothing when the model has no deals data — zero sidebar noise.
import { For, Show, createMemo } from "solid-js"
import type { Provider } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

type Cmd = {
  free?: unknown
  tier?: unknown
  allowance?: Record<string, unknown> | undefined
  discount?: { pct?: unknown; endsAt?: unknown } | undefined
  benchmark?: { intelligence?: unknown; tokPerSec?: unknown } | undefined
  peakOffPeak?: { windows?: unknown } | undefined
}

export function dealsRows(
  model: { options?: { cmd?: Record<string, unknown> } } | undefined,
): Array<[string, string]> {
  const cmd = model?.options?.cmd as Cmd | undefined
  if (!cmd) return []
  const rows: Array<[string, string]> = []
  if (cmd.free === true) rows.push(["Status", "FREE"])
  if (typeof cmd.tier === "string") rows.push(["Tier", cmd.tier])
  if (cmd.allowance) {
    for (const [plan, value] of Object.entries(cmd.allowance)) {
      if (typeof value === "number") rows.push([`${plan} allowance`, `$${value}/mo`])
    }
  }
  if (cmd.discount && typeof cmd.discount.pct === "number") {
    rows.push([
      "Deal",
      `${cmd.discount.pct}% off${typeof cmd.discount.endsAt === "string" ? ` until ${cmd.discount.endsAt}` : ""}`,
    ])
  }
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

const id = "commandcode.deals"

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx, props) {
        return <DealsPanel api={api} session_id={props.session_id} />
      },
    },
  })
}

function DealsPanel(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const model = createMemo(() => {
    const session = props.api.state.session.get(props.session_id)
    if (!session?.model) return undefined
    return props.api.state.provider.find(
      (provider: Provider) => provider.id === session.model?.providerID,
    )?.models[session.model.id]
  })
  const rows = createMemo(() => dealsRows(model()))
  return (
    <Show when={rows().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Command Code</b>
        </text>
        <For each={rows()}>
          {(row) => (
            <text fg={theme().textMuted}>
              {row[0]}: {row[1]}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
