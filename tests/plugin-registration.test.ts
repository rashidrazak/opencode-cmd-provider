// tests/plugin-registration.test.ts — the Provider specifier opencode installs
// for `provider.commandcode` (issue #152). Auto-registration must pin the
// runtime provider to the plugin's own version: the package name plus the exact
// version of the package that is running, so opencode's specifier-keyed package
// cache can never hold a runtime provider from a different release than the
// plugin that registered it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { resolveProviderNpm } from "../src/plugin/version.js"
import { assert, assertEqual, run } from "./harness.js"

const require = createRequire(import.meta.url)
// The package's own manifest is the source of truth for the expected specifier:
// the test derives both halves instead of re-typing them (spec #108).
const pkg = require("../package.json") as { name: string; version: string }
const PINNED = `${pkg.name}@${pkg.version}`

/** Writes a throwaway directory tree; keys are repo-relative paths. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oc-plugin-specifier-"))
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return root
}

/**
 * Runs the plugin entry's config hook the way opencode does and returns the
 * config it produced. Everything below the entry — snapshot Auto-registration,
 * enrichment, version resolution — runs for real; only opencode's own plumbing
 * is absent.
 */
async function configAfterHook(declared?: Record<string, unknown>): Promise<any> {
  const entry = (await import("../src/plugin/index.js")) as { default: any }
  const hooks = await entry.default.server()
  const config: any = declared ?? {}
  await hooks.config(config)
  return config
}

run([
  [
    "resolves the plugin's own specifier from a module nested like the built layout",
    () => {
      const root = tree({
        "package.json": JSON.stringify({ name: pkg.name, version: "9.9.9" }),
        "dist/src/plugin/version.js": "// module under test",
      })
      const start = pathToFileURL(join(root, "dist", "src", "plugin", "version.js")).href
      assertEqual(resolveProviderNpm(start), `${pkg.name}@9.9.9`)
    },
  ],
  [
    "skips a nearer manifest that is not ours (opencode's cache wrapper)",
    () => {
      const root = tree({
        "package.json": JSON.stringify({ name: pkg.name, version: "9.9.9" }),
        // What arborist writes one level above the installed package: no `name`,
        // only dependency records. It must never be mistaken for our manifest.
        "dist/package.json": JSON.stringify({ dependencies: { [pkg.name]: "9.9.9" } }),
        "dist/src/plugin/version.js": "// module under test",
      })
      const start = pathToFileURL(join(root, "dist", "src", "plugin", "version.js")).href
      assertEqual(resolveProviderNpm(start), `${pkg.name}@9.9.9`)
    },
  ],
  [
    "falls back to the bare package name when no manifest of ours is found",
    () => {
      const root = tree({ "somewhere/module.js": "// no manifests at all" })
      const start = pathToFileURL(join(root, "somewhere", "module.js")).href
      assertEqual(resolveProviderNpm(start), pkg.name)
    },
  ],
  [
    "falls back to the bare package name on unparseable or versionless manifests",
    () => {
      const cases: Array<[string, string]> = [
        ["invalid JSON", "{ not json"],
        ["no version", JSON.stringify({ name: pkg.name })],
        ["non-string version", JSON.stringify({ name: pkg.name, version: 7 })],
        ["empty version", JSON.stringify({ name: pkg.name, version: "" })],
        ["JSON that is not an object", JSON.stringify([pkg.name])],
      ]
      for (const [label, manifest] of cases) {
        const root = tree({ "package.json": manifest, "src/plugin/version.js": "" })
        const start = pathToFileURL(join(root, "src", "plugin", "version.js")).href
        assertEqual(resolveProviderNpm(start), pkg.name, label)
      }
    },
  ],
  [
    "falls back to the bare package name for unusable start URLs, never throwing",
    () => {
      assertEqual(resolveProviderNpm("not a url"), pkg.name)
      assertEqual(resolveProviderNpm("https://example.com/dist/src/plugin/version.js"), pkg.name)
    },
  ],
  [
    "resolves this package's own specifier from the module's real location",
    () => {
      assertEqual(resolveProviderNpm(), PINNED)
    },
  ],
  [
    "the plugin entry registers the version-pinned provider specifier",
    async () => {
      const config = await configAfterHook()
      assertEqual(config.provider.commandcode.npm, PINNED)
    },
  ],
  [
    "the plugin entry still auto-registers every snapshot model",
    async () => {
      const config = await configAfterHook()
      assert(config.provider.commandcode.models, "Auto-registration must still happen")
      assertEqual(
        Object.keys(config.provider.commandcode.models).length,
        MODEL_SNAPSHOT.length,
        "every snapshot model must register",
      )
    },
  ],
  [
    "a declared provider npm still wins over the pinned specifier",
    async () => {
      const config = await configAfterHook({
        provider: { commandcode: { npm: `${pkg.name}@1.0.0` } },
      })
      assertEqual(config.provider.commandcode.npm, `${pkg.name}@1.0.0`)
    },
  ],
])
