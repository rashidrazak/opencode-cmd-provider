// scripts/vite-gui.config.mjs — builds the OpenCode Desktop GUI half into the
// ONE prebuilt CommonJS file the host evaluates per window:
// dist/gui-experimental.cjs (package export "./gui-experimental").
//
// The desktop host's `evaluatePluginBundle` runs the file as
// `new Function("require", "module", "exports", code)` where `require` serves
// ONLY the modules the app shares: `@opencode/plugin/gui`,
// `@opencode/plugin/gui/main`, `@opencode/plugin/rpc`, `@opencode/schema/rpc`,
// `@opencode/client` (+`/effect`, `/solid`), `effect` and the `solid-js`
// family; everything else fails the evaluation ("requires a module the app
// does not share"). So the bundle keeps exactly those externals and inlines
// everything else — the shared Rates & usage modules are pure TypeScript and
// carry no runtime `@opencode/*` import, which is why they can inline.
//
// Why vite and not bun/tsc: JSX compiles with vite-plugin-solid's
// babel-preset-solid (the DOM runtime the window provides), and bun is not a
// guaranteed tool (scripts/build-tui.ts documents the repo's bun dependency;
// this config deliberately adds none — vite is a devDependency). Plain tsc
// cannot emit the solid DOM runtime for this program (tsconfig.gui.json type
// checks with `jsx: preserve` only).
//
// Verified live against the registry contract: the host identity-checks the
// `Panel`/`Command`/`MenuItem`/`Style` tokens, so `@opencode/plugin/gui` must
// stay a require at runtime — never inlined. tests/gui-panel.test.ts evaluates
// the built bundle exactly like the host and pins the require set.
import { fileURLToPath } from "node:url"
import { copyFileSync, mkdirSync } from "node:fs"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

/**
 * The modules this bundle must keep EXTERNAL — the subset of the desktop
 * host's shared-module set that src/rates-usage/gui/ actually imports. The
 * canonical host allowlist (the wider set) lives in
 * tests/gui-shared-modules.ts and is what both test guards check against;
 * keep this list a subset of it.
 */
const SHARED = ["@opencode/plugin/gui", "solid-js", "solid-js/web", "solid-js/store"]

const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url))
const DEV_DIR = fileURLToPath(new URL("../dev/opencode-plugin/", import.meta.url))

/**
 * Copies the built bundle into `dev/opencode-plugin/gui-experimental.cjs` (the
 * CONTRIBUTING.md dev flow's plugin directory). A local *directory* plugin has
 * no package.json name, so the host resolves the GUI entry as a literal
 * `gui-experimental.cjs` FILE in the directory — and a re-export wrapper
 * (`export … from`, like server.mjs/tui.mjs) cannot work here: the desktop
 * window evaluates exactly this file under the host's require, which serves
 * only the shared modules. The copy is a generated artifact, gitignored like
 * dist/.
 */
function copyToDevDir() {
  return {
    name: "copy-gui-bundle-to-dev-dir",
    closeBundle() {
      mkdirSync(DEV_DIR, { recursive: true })
      copyFileSync(DIST_DIR + "gui-experimental.cjs", DEV_DIR + "gui-experimental.cjs")
    },
  }
}

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    // Unminified: the bundle is small, and a readable artifact is greppable —
    // tests/contract.test.ts and tests/gui-panel.test.ts read it as text.
    minify: false,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL("../src/rates-usage/gui/index.tsx", import.meta.url)),
      formats: ["cjs"],
      fileName: () => "gui-experimental.cjs",
    },
    rollupOptions: {
      external: (id) => SHARED.some((shared) => id === shared || id.startsWith(`${shared}/`)),
      output: {
        // A fixed single-file name regardless of entry hashing.
        entryFileNames: "gui-experimental.cjs",
        chunkFileNames: "gui-experimental.cjs",
      },
    },
    target: "es2022",
  },
  plugins: [solid(), copyToDevDir()],
})
