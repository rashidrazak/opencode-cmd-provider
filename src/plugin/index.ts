// src/plugin/index.ts — dual OpenCode plugin module (ADR-0010)
//
// OpenCode v1 (≤ 1.18.30) calls `server()` and consumes the returned hook map;
// OpenCode v2 (≥ 2.0.0) decodes the default export for an `{ id, setup }`
// definition and calls `setup(context)`. One default export carries both, which
// the v2 loader's schema admits because unknown keys are stripped and the v1
// loader only ever inspects `id`/`server`/`tui` (verified against both loaders;
// see ADR-0010). The two halves are independent implementations of the same
// three capabilities — v2 does not translate v1 hooks.
import { MODEL_SNAPSHOT } from "../catalog/snapshot.js"
import { getApiBase } from "../env.js"
import { augmentConfigCommandCodeModels, autoRegister } from "./models.js"
import { resolveProviderNpm } from "./version.js"
import {
  enrichCommandCodeModels,
  enrichCommandCodeModelsV2,
  planSummaryTool,
} from "../deals/index.js"
import { planSummaryV2Tool } from "../deals/plan-summary.js"
import { runAuthFlow } from "./auth.js"
import { setupCommandCode } from "./v2.js"
import type { Plugin } from "@opencode-ai/plugin"
import type { Config } from "@opencode-ai/sdk/v2"
import type { V2SetupContext } from "./v2-types.js"

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

/**
 * v2 host: the same three capabilities through the transform API. The two Deals
 * intelligence seams — the catalog enrichment pass and the `cmd_plan_summary`
 * tool — are supplied here, so deleting `src/deals/` plus these two lines still
 * leaves Core green (ADR-0004).
 */
const setup = async (ctx: V2SetupContext): Promise<void> =>
  setupCommandCode(ctx, {
    enrichCatalog: enrichCommandCodeModelsV2,
    tools: [planSummaryV2Tool()],
  })

export default { id: "commandcode", server, setup }
