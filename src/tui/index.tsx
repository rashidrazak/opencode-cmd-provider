/** @jsxImportSource @opentui/solid */
// src/tui/index.tsx — TUI plugin: "Command Code" deals section in the session
// sidebar (sidebar_content slot). Renders deal details from the picked model's
// enriched options.cmd (produced by the server plugin's config hook). Renders
// nothing when the model has no deals data — zero sidebar noise.
import { Show, createMemo, onMount } from "solid-js"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
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

type ModelRef = { id: string; providerID: string; variant?: string }

const DEBUG_LOG = join(process.env.HOME ?? "/tmp", ".commandcode-deals-debug.log")

function debugLog(line: string) {
  try {
    appendFileSync(DEBUG_LOG, `${Date.now()} ${line}\n`)
  } catch {
    // ignore
  }
}

let mountCount = 0

const tui: TuiPlugin = async (api) => {
  debugLog(`tui init; registerCount will log per call`)
  let lastRegistered: string | undefined
  const register = (modelId: string | undefined) => {
    debugLog(`register called modelId=${modelId} last=${lastRegistered}`)
    if (modelId === lastRegistered) return
    lastRegistered = modelId
    api.slots.register({
      order: 200,
      slots: {
        sidebar_content(_ctx, props) {
          return <DealsPanel api={api} session_id={props.session_id} onModelChange={register} />
        },
      },
    })
    debugLog(`register done modelId=${modelId}`)
  }
  register(undefined)
}

function DealsPanel(props: {
  api: TuiPluginApi
  session_id: string
  onModelChange: (modelId: string | undefined) => void
}) {
  const myMount = ++mountCount
  const theme = () => props.api.theme.current
  const model = createMemo(() => {
    const current = props.api.state.session.get(props.session_id)?.model
    if (!current) return undefined
    return props.api.state.provider.find((provider: Provider) => provider.id === current.providerID)
      ?.models[current.id]
  })
  const rows = createMemo(() => {
    const r = dealsRows(model())
    debugLog(`panel#${myMount} rows=${JSON.stringify(r)}`)
    return r
  })
  onMount(() => {
    debugLog(`panel#${myMount} mounted session_id=${props.session_id}`)
    const off = props.api.event.on("session.updated", (event) => {
      if (event.properties.info.id !== props.session_id) return
      debugLog(`panel#${myMount} session.updated model=${event.properties.info.model?.id}`)
      props.onModelChange(event.properties.info.model?.id)
    })
    props.api.lifecycle.onDispose(off)
  })
  const lines = createMemo(() => {
    const r = rows()
    if (r.length === 0) return undefined
    return ["Command Code", ...r.map(([key, value]) => `${key}: ${value}`)].join("\n")
  })
  debugLog(`panel#${myMount} rendered lines=${JSON.stringify(lines())?.slice(0, 100)}`)
  return (
    <Show when={lines()}>
      <text fg={theme().textMuted}>{lines()}</text>
    </Show>
  )
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
