// Builds dist/tui.js (the "./tui" export) from src/tui/index.tsx.
//
// tsc's `react-jsx` emit is not reactive: every JSX prop is evaluated eagerly
// when the element is created, so props like `when={rows().length > 0}` or
// `each={rows()}` freeze at mount time and the sidebar panel never repaints
// when the session model changes mid-session.
//
// This build compiles the TSX with @opentui/solid's solid transform instead
// (deferred prop getters + reactive inserts, the same transform opencode's own
// TUI uses), which keeps the panel live. The host runtime rewrites
// `@opentui/*` / `solid-js` imports to its own module instances at plugin load
// time, so they are marked external.
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const out = await Bun.build({
  entrypoints: [new URL("../src/tui/index.tsx", import.meta.url).pathname],
  target: "bun",
  outdir: new URL("../dist", import.meta.url).pathname,
  naming: "tui.js",
  plugins: [
    createSolidTransformPlugin({
      // Keep the emit's runtime imports bare (@opentui/solid, solid-js); the
      // opencode host rewrites them to its own instances at plugin load time.
      resolvePath: () => null,
    }),
  ],
  external: ["solid-js", "solid-js/*", "@opentui/*", "@opencode-ai/*"],
  minify: false,
})

if (!out.success) {
  for (const log of out.logs) console.error(log)
  process.exit(1)
}
