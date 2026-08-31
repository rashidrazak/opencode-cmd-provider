// src/plugin/index.ts — v1 server and v2 setup surfaces.
import { MODEL_SNAPSHOT } from "../catalog/snapshot.js"
import {
  autoRegister,
  augmentConfigCommandCodeModels,
  autoRegisterOptions,
  v2ModelInfoFor,
  v2ProviderPatch,
  AISDK_ENDPOINT_PACKAGE,
  AISDK_PACKAGE,
} from "./models.js"
import { enrichCommandCodeModels } from "../deals/enrichment.js"
import { planSummaryTool } from "../deals/plan-summary.js"
import { runAuthFlow } from "./auth.js"
import type { Config } from "@opencode-ai/sdk/v2"
import { createCommandCode } from "../provider/index.js"
import { resolveApiKey } from "../provider/auth-key.js"

const PROVIDER_ID = "commandcode"
// ---------------------------------------------------------------------------
// v2 surface
// ---------------------------------------------------------------------------

type PluginContext = {
  catalog: {
    transform: (fn: (draft: any) => void) => any
    reload?: () => Promise<void>
  }
  integration: {
    transform: (fn: (draft: any) => void) => any
  }
  aisdk: {
    hook: (
      name: "sdk" | "language",
      fn: (input: {
        model?: { id?: string }
        options?: Record<string, any>
        sdk?: any
        language?: any
      }) => void,
      options?: { providerID?: string },
    ) => any
  }
  tool?: {
    transform: (fn: (draft: { add(tool: unknown): void }) => void) => any
  }
}

async function setupV2(ctx: PluginContext): Promise<void> {
  await ctx.catalog.transform((draft) => {
    draft.provider.update(PROVIDER_ID, (provider: any) => {
      const userEntry = v2ProviderPatch(provider)
      provider.name ??= userEntry.name
      provider.endpoint = { type: "aisdk", package: AISDK_ENDPOINT_PACKAGE }
      provider.package = AISDK_PACKAGE
      provider.activation ??= "auto"
    })
    for (const model of MODEL_SNAPSHOT) {
      if (draft.model.get(PROVIDER_ID, model.id)) continue
      const info = v2ModelInfoFor(model, PROVIDER_ID)
      if (info)
        draft.model.update(PROVIDER_ID, model.id, (target: any) => Object.assign(target, info))
    }
  })

  await ctx.integration.transform((draft) => {
    if (draft.get(PROVIDER_ID) === undefined) {
      draft.update(PROVIDER_ID, (integration: any) => {
        integration.name ??= "Command Code"
      })
    }
    draft.method.update({
      integrationID: PROVIDER_ID,
      method: { type: "env", names: ["COMMANDCODE_API_KEY"] },
    })
    draft.method.update({
      integrationID: PROVIDER_ID,
      method: { id: `${PROVIDER_ID}-studio`, type: "oauth", label: "Command Code" },
      authorize: async () => {
        const result = await runAuthFlow({ mirror: {} })
        return {
          url: result.url,
          instructions: result.instructions,
          async callback() {
            const outcome = await result.callback()
            if (outcome.type !== "success" || !("key" in outcome)) {
              return { type: "failed" as const }
            }
            return {
              type: "success" as const,
              key: outcome.key,
            }
          },
        }
      },
    })
  })

  await ctx.aisdk.hook(
    "sdk",
    (input) => {
      input.sdk = createCommandCode()
    },
    { providerID: PROVIDER_ID },
  )
  await ctx.aisdk.hook(
    "language",
    (input) => {
      const modelId = input.model?.id ?? ""
      const apiKey =
        typeof input.options?.apiKey === "string" && input.options.apiKey.length > 0
          ? input.options.apiKey
          : resolveApiKey({ authPaths: undefined })
      input.language = createCommandCode({ apiKey }).languageModel(modelId) as any
    },
    { providerID: PROVIDER_ID },
  )

  if (ctx.tool)
    await ctx.tool.transform((draft) => {
      draft.add(v2PlanSummaryTool())
    })
}

// ---------------------------------------------------------------------------
// Shared v2 tool adaptation
// ---------------------------------------------------------------------------

function v2PlanSummaryTool() {
  const v1 = planSummaryTool()
  return {
    name: "cmd_plan_summary",
    description: v1.description,
    input: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "go|goat|pro|max|max20|teampro|provider",
        },
      },
      additionalProperties: false,
    },
    output: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: false },
    async execute(args: { plan?: string }) {
      const markdown = await v1.execute({ plan: args?.plan })
      return { title: "cmd_plan_summary", output: markdown, metadata: {} }
    },
  }
}

// ---------------------------------------------------------------------------
// v1 surface (unchanged behavior, shared core)
// ---------------------------------------------------------------------------

const server = async () => ({
  config: async (config: Config) => {
    autoRegister(config as Config, MODEL_SNAPSHOT, autoRegisterOptions())
    augmentConfigCommandCodeModels(config as Config)
    enrichCommandCodeModels(config as Config)
  },
  auth: {
    provider: PROVIDER_ID,
    methods: [
      {
        type: "oauth" as const,
        label: "Command Code",
        authorize: async () => runAuthFlow(),
      },
    ],
  },
  tool: {
    cmd_plan_summary: planSummaryTool(),
  },
})

export default { id: PROVIDER_ID, server, setup: setupV2 }
