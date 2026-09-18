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
import { hostCredentialFromV1 } from "../deals/host-credential.js"
import { runAuthFlow } from "./auth.js"
import { hostCredentialFromV2, setupCommandCode } from "./v2.js"
import type { Plugin } from "@opencode-ai/plugin"
import type { Config } from "@opencode-ai/sdk/v2"
import type { V2SetupContext } from "./v2-types.js"

const server: Plugin = async (input) => {
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
        {
          // Additive fallback (issue #145). Hosts render their own prompt for an
          // `api` method and store the pasted key through `auth.set` themselves:
          // core's `provider.oauth.authorize` returns early for anything that is
          // not `oauth`, so an `authorize` here would never run. Declaring it is
          // what makes OpenChamber render its API Key field
          // (`shouldShowApiKeyAuth`) and gives the TUI a paste prompt — the only
          // way in when the browser cannot reach the loopback callback server
          // (remote `OPENCODE_HOST`, blocked local-network access).
          type: "api",
          label: "Command Code API key",
        },
      ],
    },
    tool: {
      // The v1 Host resolves the credential itself (auth store above the env
      // method, a declared `options.apiKey` above both) and exposes the result
      // through the SDK client, so the tool asks there before the legacy auth
      // files — the same rule the v2 half applies through the connection
      // service (ADR-0015).
      cmd_plan_summary: planSummaryTool({
        hostCredential: () => hostCredentialFromV1(input.client, "commandcode"),
      }),
    },
  }
}

/**
 * v2 host: the same three capabilities through the transform API. The two Deals
 * intelligence seams — the provider enrichment pass and the `cmd_plan_summary`
 * tool — are supplied here, so deleting `src/deals/` plus these two lines still
 * leaves Core green (ADR-0004). The tool is handed the credential getter for the
 * Host's active connection, which is the only credential the session streams
 * with (ADR-0015).
 */
const setup = async (ctx: V2SetupContext): Promise<void> =>
  setupCommandCode(ctx, {
    enrichProvider: enrichCommandCodeModelsV2,
    tools: [planSummaryV2Tool({ hostCredential: hostCredentialFromV2(ctx) })],
  })

export default { id: "commandcode", server, setup }
