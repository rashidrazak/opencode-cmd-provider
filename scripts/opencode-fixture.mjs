// Writes a throwaway opencode.json wired to the local package + mock endpoints.
//
// opencode's plugin `provider.models` hook only fires for providers already
// present in its models.dev catalog; `commandcode` is not in that catalog, so
// model discovery for this provider is driven by the config-declared `models`
// map (which the plugin's install instructions write for the user). The mock
// model entry here mirrors what the catalog hook would have produced.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "oc-cc-fixture-"))
const pluginPath = resolve(import.meta.dirname, "..", "dist", "index.js")
const config = {
  $schema: "https://opencode.ai/config.json",
  plugin: [`file://${pluginPath}`],
  provider: {
    commandcode: {
      npm: `file://${pluginPath}`,
      name: "Command Code",
      options: { baseURL: process.env.COMMANDCODE_API_BASE ?? "https://api.commandcode.ai" },
      models: {
        "claude-sonnet-5": {
          name: "Claude Sonnet 5",
          limit: { context: 200000, output: 65536 },
        },
      },
    },
  },
}
mkdirSync(join(dir, ".opencode"), { recursive: true })
writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2))
writeFileSync(join(dir, ".opencode", "package.json"), JSON.stringify({ private: true }))
process.stdout.write(dir)
