// tests/contract.test.ts
import { createRequire } from "node:module"
import { run, assert, assertEqual } from "./harness.js"

const require = createRequire(import.meta.url)
const pkg = require("../package.json") as {
  engines?: Record<string, string>
  exports?: Record<string, string>
}

async function load(): Promise<Record<string, unknown>> {
  const mod = await import("../dist/index.js")
  return mod as Record<string, unknown>
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
])
