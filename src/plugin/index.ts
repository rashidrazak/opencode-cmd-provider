// src/plugin/index.ts — V1 opencode plugin module
import { MODEL_SNAPSHOT } from "../catalog/snapshot.js"
import { getApiBase } from "../env.js"
import { augmentConfigCommandCodeModels, autoRegister } from "./models.js"
import { resolveProviderNpm } from "./version.js"
import { enrichCommandCodeModels, planSummaryTool } from "../deals/index.js"
import { runAuthFlow } from "./auth.js"
import type { Plugin } from "@opencode-ai/plugin"
import type { Config } from "@opencode-ai/sdk/v2"

const server: Plugin = async () => {
  return {
    config: async (config) => {
      autoRegister(config as Config, MODEL_SNAPSHOT, {
        // Version-pinned on purpose (issue #152): opencode's package cache is
        // keyed by the exact specifier and never refreshed, so a bare name would
        // let the runtime provider drift away from the plugin that registered it.
        npm: resolveProviderNpm(),
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
