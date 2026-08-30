// src/plugin/index.ts — dual-shape opencode plugin module
//
// The default export carries BOTH loader surfaces so one package serves the
// two opencode generations:
//
// - OpenCode v2 (beta): validates the default export against its plugin
//   schema and calls `setup(context)`. The v2 surface is authoritative here:
//   provider auto-registration goes through `catalog.transform` (the v2
//   catalog draft upserts providers/models), authentication registers env +
//   OAuth methods on the `commandcode` integration, reasoning-effort cycling
//   is delivered through real `Model.Info` variants, and inference is routed
//   to the bundled transport via `aisdk.hook("language")` — the v2 runtime
//   dispatches models whose provider `package` carries the `aisdk:` prefix
//   to that hook instead of loading an npm SDK package.
//
// - OpenCode v1 (1.18.x): ignores the unknown `setup` key and calls the
//   `server` plugin function (config-hook auto-registration + /connect auth),
//   exactly as before. Verified against a real 1.18.25 binary.
//
// Both surfaces share the same pure registration/enrichment core in
// ./core.js, so the model catalog and its metadata stay byte-identical
// across generations.
import { MODEL_SNAPSHOT } from "../catalog/snapshot.js"
import { getApiBase } from "../env.js"
import {
  autoRegister,
  augmentConfigCommandCodeModels,
  resolveDisplayPrefix,
  autoRegisterOptions,
  v2ModelInfoFor,
  v2ProviderPatch,
  DISPLAY_PREFIX_OPTION,
} from "./core.js"
import { enrichCommandCodeModels } from "../deals/enrichment.js"
import { planSummaryTool } from "../deals/plan-summary.js"
import { runAuthFlow } from "./auth.js"
import type { Config } from "@opencode-ai/sdk/v2"
import { createCommandCode } from "../provider/index.js"
import { resolveApiKey } from "../provider/auth-key.js"

const PROVIDER_ID = "commandcode"
/** v2 runtime marker: models under a provider whose package carries the
 * `aisdk:` prefix resolve through the plugin `aisdk.hook("language")` seam
 * instead of an npm SDK package (verified against beta-18684). */
const AISDK_PACKAGE = `aisdk:${PROVIDER_ID}`

// ---------------------------------------------------------------------------
// v2 surface
// ---------------------------------------------------------------------------

async function setupV2(ctx: {
  catalog: {
    transform: (fn: (draft: any) => void) => Promise<void>
    reload?: () => Promise<void>
  }
  integration: {
    transform: (fn: (draft: any) => void) => Promise<void>
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
    ) => Promise<void>
  }
  tool?: {
    transform: (fn: (draft: { add(tool: unknown): void }) => void) => Promise<void>
  }
}): Promise<void> {
  // 1. Catalog: upsert the commandcode provider with every snapshot model.
  //    update() upserts (creates the provider when missing), and transforms
  //    replay on every catalog rebuild — the pass must be idempotent.
  await ctx.catalog.transform((draft) => {
    draft.provider.update(PROVIDER_ID, (provider: any) => {
      const userEntry = v2ProviderPatch(provider)
      provider.name ??= userEntry.name
      provider.package = AISDK_PACKAGE
      provider.activation ??= "auto"
    })
    const record = draft.provider.get(PROVIDER_ID)
    if (!record) return
    const prefix = resolveDisplayPrefixFromOptions(record)
    const declaredById = new Set([...record.models.keys()].map((key) => key))
    for (const model of MODEL_SNAPSHOT) {
      if (declaredById.has(model.id)) continue
      const info = v2ModelInfoFor(model, PROVIDER_ID, prefix)
      if (info) record.models.set(model.id, info)
    }
  })

  // 2. Integration: expose auth methods for the commandcode provider. The env
  //    method resolves COMMANDCODE_API_KEY (when present in the service env)
  //    into the language hook's `options.apiKey`; the OAuth method wraps the
  //    same studio callback flow the v1 /connect path uses.
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

  // 3. Inference: route every commandcode model through the bundled
  //    LanguageModelV3 transport. The v2 AISDK resolver first runs "sdk"
  //    hooks — one must return an SDK object (its `languageModel(id)` builds
  //    the model when no language hook overrides it); we register both:
  //    the sdk hook returns the bundled factory, and the language hook
  //    bakes the runtime-resolved credential into the model instance. The
  //    auth-file fallback stays as a last resort for v1-style setups.
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

  // 4. Deals tool (v2 first-class tool, code-mode disabled so results reach
  //    the model reliably on current betas).
  await ctx.tool?.transform((draft) => {
    draft.add(v2PlanSummaryTool())
  })
}

/**
 * Reads the display prefix from a v2 provider record. v2 provider records do
 * not expose the free-form `options` bag v1 config entries had, so the prefix
 * customization is read from the record's `settings` when present
 * (`settings[DISPLAY_PREFIX_OPTION]`).
 */
function resolveDisplayPrefixFromOptions(record: {
  provider?: { settings?: Record<string, unknown> }
}): string {
  const settings = record.provider?.settings
  if (settings && typeof settings === "object" && DISPLAY_PREFIX_OPTION in settings) {
    const value = (settings as Record<string, unknown>)[DISPLAY_PREFIX_OPTION]
    if (typeof value === "string") return value
  }
  return resolveDisplayPrefix(undefined)
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
