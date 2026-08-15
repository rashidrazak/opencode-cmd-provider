// src/plugin/index.ts — V1 opencode plugin module (PLAN #11)
import { getApiBase, getModelsUrl, getModelsTimeoutMs, getDataDir } from "../env.js"
import { loadCommandCodeModels } from "../provider/models.js"
import { augmentConfigCommandCodeModels, catalogToOpenCodeModels } from "./models.js"
import { runAuthFlow } from "./auth.js"
import type { Plugin } from "@opencode-ai/plugin"
import type { Config } from "@opencode-ai/sdk/v2"
import { join } from "node:path"
import { mkdirSync } from "node:fs"

const server: Plugin = async () => {
  return {
    config: async (config) => {
      augmentConfigCommandCodeModels(config as Config)
    },
    auth: {
      provider: "commandcode",
      methods: [
        {
          type: "oauth",
          label: "Command Code",
          authorize: async () => runAuthFlow(),
        },
      ],
    },
    provider: {
      id: "commandcode",
      models: async () => {
        const cacheDir = getDataDir()
        mkdirSync(cacheDir, { recursive: true })
        const cachePath =
          process.env.COMMANDCODE_MODELS_CACHE ?? join(cacheDir, "commandcode-models.json")
        const loaded = await loadCommandCodeModels({
          url: getModelsUrl(),
          cachePath,
          timeoutMs: getModelsTimeoutMs(),
        })
        return catalogToOpenCodeModels(loaded.models, {
          npm: "opencode-cmd-provider",
          url: getApiBase(),
        })
      },
    },
  }
}

export default { id: "commandcode", server }
