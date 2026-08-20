// src/plugin/index.ts — V1 opencode plugin module
import { MODEL_SNAPSHOT } from "../catalog/snapshot.js"
import { getApiBase } from "../env.js"
import { augmentConfigCommandCodeModels, autoRegister } from "./models.js"
import { enrichCommandCodeModels } from "./deals-enrichment.js"
import { planSummaryTool } from "./plan-summary.js"
import { runAuthFlow } from "./auth.js"
import type { Plugin } from "@opencode-ai/plugin"
import type { Config } from "@opencode-ai/sdk/v2"

const server: Plugin = async () => {
  return {
    config: async (config) => {
      autoRegister(config as Config, MODEL_SNAPSHOT, {
        npm: "opencode-cmd-provider",
        name: "Command Code",
        baseURL: getApiBase(),
      })
      augmentConfigCommandCodeModels(config as Config)
      enrichCommandCodeModels(config as Config)
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
    tool: {
      cmd_plan_summary: planSummaryTool(),
    },
  }
}

export default { id: "commandcode", server }
