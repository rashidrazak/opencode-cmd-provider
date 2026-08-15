// Writes a throwaway opencode.json wiring the local package as the only
// plugin, with no declared provider or models. The plugin's config hook
// auto-registers the commandcode provider and every snapshot model, so model
// discovery proves auto-registration end-to-end. COMMANDCODE_API_BASE is read
// by the plugin (injected as options.baseURL) so requests reach the mock.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "oc-cc-fixture-"))
const pluginPath = resolve(import.meta.dirname, "..", "dist", "index.js")
const config = {
  $schema: "https://opencode.ai/config.json",
  plugin: [`file://${pluginPath}`],
}
mkdirSync(join(dir, ".opencode"), { recursive: true })
writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2))
writeFileSync(join(dir, ".opencode", "package.json"), JSON.stringify({ private: true }))
process.stdout.write(dir)
