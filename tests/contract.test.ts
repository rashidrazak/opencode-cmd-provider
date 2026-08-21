// tests/contract.test.ts
import { createRequire } from "node:module"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { run, assert, assertEqual } from "./harness.js"

const require = createRequire(import.meta.url)
const pkg = require("../package.json") as {
  engines?: Record<string, string>
  exports?: Record<string, string>
  files?: string[]
}

async function load(): Promise<Record<string, unknown>> {
  const mod = await import("../dist/index.js")
  return mod as Record<string, unknown>
}

async function loadTui(): Promise<Record<string, unknown>> {
  const mod = await import("../dist/tui.js")
  return mod as Record<string, unknown>
}

function listJsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    if (statSync(file).isDirectory()) {
      out.push(...listJsFiles(file))
    } else if (entry.endsWith(".js")) {
      out.push(file)
    }
  }
  return out
}

run([
  [
    "package.json never declares engines.opencode (compatibility gate)",
    () => {
      assertEqual(pkg.engines?.opencode, undefined)
    },
  ],
  [
    "exports exposes main and ./server entries",
    () => {
      assert(typeof pkg.exports?.["."] === "string")
      assert(typeof pkg.exports?.["./server"] === "string")
    },
  ],
  [
    "exports exposes ./tui entry pointing to dist/tui.js",
    () => {
      assertEqual(pkg.exports?.["./tui"], "./dist/tui.js")
    },
  ],
  [
    "files includes dist so published artifact contains server and tui",
    () => {
      assert(Array.isArray(pkg.files), "package.json files must be an array")
      const includesDist = pkg.files?.some(
        (f) => f === "dist" || f === "dist/tui.js" || f === "./dist/tui.js",
      )
      assert(includesDist, "files must include dist or dist/tui.js")
      // tsc emits dist/tui.js via bun build; contract fails fast if missing before npm pack check
      assert(typeof pkg.exports?.["./tui"] === "string")
    },
  ],
  [
    "dist/tui.js exists and re-exports Deals TUI plugin",
    async () => {
      const mod = await loadTui()
      const def = mod.default as { id?: unknown; tui?: unknown }
      assert(typeof def === "object" && def !== null)
      assertEqual(def.id, "commandcode.deals")
      assert(typeof def.tui === "function")
    },
  ],
  [
    "index.ts exports exactly one create* function",
    async () => {
      const mod = await load()
      const createKeys = Object.keys(mod).filter((key) => key.startsWith("create"))
      assertEqual(createKeys, ["createCommandCode"])
      assert(typeof mod.createCommandCode === "function")
    },
  ],
  [
    "default export is a V1 plugin module { id, server }",
    async () => {
      const mod = await load()
      const def = mod.default as { id?: unknown; server?: unknown }
      assert(typeof def === "object" && def !== null)
      assertEqual(def.id, "commandcode")
      assert(typeof def.server === "function")
    },
  ],
  [
    "built bundle has no runtime imports of optional peer deps (@opencode-ai/*)",
    () => {
      // A runtime `import ... from "@opencode-ai/*"` in the published bundle is a
      // load-time landmine: `@opencode-ai/plugin` is an optional peer dependency,
      // so `opencode plugin <pkg>` does not install it next to the plugin and the
      // whole server plugin fails to import (ERR_MODULE_NOT_FOUND) — which silently
      // drops auto-registration and /connect. Only `import type` (erased by tsc/bun)
      // may reference these packages.
      const offenders: string[] = []
      for (const file of listJsFiles(new URL("../dist", import.meta.url).pathname)) {
        const text = readFileSync(file, "utf-8")
        if (/^\s*import\s.*from\s+["']@opencode-ai\//m.test(text)) {
          offenders.push(file)
        }
      }
      assert(
        offenders.length === 0,
        `runtime @opencode-ai/* imports found in built bundle: ${offenders.join(", ")}`,
      )
    },
  ],
])
