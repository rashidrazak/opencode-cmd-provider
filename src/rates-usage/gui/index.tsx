// src/rates-usage/gui/index.tsx — the OpenCode Desktop GUI half's default
// export: the `./gui-experimental` bundle's `Plugin.define`. The desktop host
// evaluates dist/gui-experimental.cjs (scripts/vite-gui.config.mjs) in every
// window with the server plugin's id (`commandcode`), so `ctx.id` names the
// same plugin the TUI and server halves register under.
//
// One setup, four contributions: the stylesheet, the side panel, the palette
// command and the + menu launcher (src/rates-usage/gui/panel.tsx). Nothing else
// runs here — no storage (the window SDK's stores need an Effect Schema, which
// the root-beta/host-4.1 split forbids; see ADR-0025), no main process, no
// declared stores, and no slash command (see registerRatesUsageCommand).
import { Plugin } from "@opencode/plugin/gui"
import { registerRatesUsageGui } from "./panel.js"

export default Plugin.define({
  setup(ctx) {
    registerRatesUsageGui(ctx)
  },
})
