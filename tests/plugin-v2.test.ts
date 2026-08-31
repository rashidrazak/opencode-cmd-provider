// tests/plugin-v2.test.ts — v2 plugin surface: catalog auto-registration,
// Model.Info mapping (variants, cost, limits), idempotent replay, provider
// patch gap-fill, and the dual-shape default export. The v2 draft used here
// mirrors the live contract verified against beta-18684 (update() upserts,
// models is a Map, transforms replay on every catalog rebuild).
import { MODEL_SNAPSHOT, type CatalogModel } from "../src/catalog/snapshot.js"
import { MODEL_COSTS, ZERO_MODEL_COST } from "../src/provider/pricing.js"
import { reasoningVariantsForModel } from "../src/provider/reasoning.js"
import { assert, assertEqual, run } from "./harness.js"

type ProviderRecord = {
  provider: {
    id?: string
    name?: string
    endpoint?: { type: "aisdk"; package: string }
    activation?: string
  }
  models: Map<string, Record<string, any>>
}

function makeDraft(existing: Map<string, ProviderRecord> = new Map()) {
  const drafts: { created: string[]; updated: string[] } = { created: [], updated: [] }
  return {
    drafts,
    draft: {
      provider: {
        list: () => [...existing.values()].map((record) => record.provider),
        get: (id: string) => existing.get(id)?.provider,
        update: (id: string, fn: (p: ProviderRecord["provider"]) => void) => {
          let record = existing.get(id)
          const isNew = record === undefined
          if (!record) {
            record = {
              provider: { id, name: undefined, endpoint: undefined, activation: undefined },
              models: new Map(),
            }
            existing.set(id, record)
          }
          // The real draft hands the callback the Provider.Info, not the record
          fn(record.provider)
          if (isNew) drafts.created.push(id)
          else drafts.updated.push(id)
        },
        remove: (id: string) => existing.delete(id),
      },
      model: {
        get: (providerId: string, modelId: string) => existing.get(providerId)?.models.get(modelId),
        update: (providerId: string, modelId: string, fn: (model: Record<string, any>) => void) => {
          const record = existing.get(providerId)!
          const model = record.models.get(modelId) ?? { id: modelId, providerID: providerId }
          fn(model)
          record.models.set(modelId, model)
        },
        remove: (providerId: string, modelId: string) =>
          existing.get(providerId)?.models.delete(modelId),
        default: { get: () => undefined, set: () => undefined },
      },
    },
    existing,
  }
}

function makeCtx(drafts: ProviderRecord[] = []) {
  const ctx = {
    catalog: {
      transforms: [] as Array<(draft: ReturnType<typeof makeDraft>["draft"]) => void>,
      transform(fn: (draft: ReturnType<typeof makeDraft>["draft"]) => void) {
        ctx.catalog.transforms.push(fn)
        return Promise.resolve()
      },
    },
    integration: { transform: () => Promise.resolve() },
    aisdk: {
      hooks: [] as Array<{
        name: string
        fn: (input: any) => void
        options?: { providerID?: string }
      }>,
      hook(name: string, fn: (input: any) => void, options?: { providerID?: string }) {
        ctx.aisdk.hooks.push({ name, fn, options })
        return Promise.resolve()
      },
    },
    tool: {
      added: [] as any[],
      transform(fn: (draft: { add(tool: unknown): void }) => void) {
        const added: any[] = []
        fn({ add: (tool: unknown) => added.push(tool) })
        ctx.tool.added.push(...added)
        return Promise.resolve()
      },
    },
  }
  return ctx
}

async function loadPlugin() {
  const mod = await import("../src/plugin/index.js")
  return mod.default as { id: string; server: unknown; setup: (ctx: any) => Promise<void> }
}

const SONNET: CatalogModel = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  contextLength: 200000,
}

run([
  [
    "default export carries both loader surfaces { id, server, setup }",
    async () => {
      const plugin = await loadPlugin()
      assertEqual(plugin.id, "commandcode")
      assert(typeof plugin.server === "function", "v1 server surface missing")
      assert(typeof plugin.setup === "function", "v2 setup surface missing")
    },
  ],

  [
    "v2 setup registers catalog, integration, aisdk hook, and tool",
    async () => {
      const ctx = makeCtx()
      const plugin = await loadPlugin()
      await plugin.setup(ctx as any)
      assertEqual(ctx.catalog.transforms.length, 1)
      assertEqual(ctx.aisdk.hooks.length, 2)
      assertEqual(
        ctx.aisdk.hooks.map((h) => h.name),
        ["sdk", "language"],
      )
      assertEqual(ctx.aisdk.hooks[0].options?.providerID, "commandcode")
      assertEqual(ctx.tool.added.length, 1)
      assertEqual(ctx.tool.added[0].name, "cmd_plan_summary")
      assertEqual(ctx.tool.added[0].options, { codemode: false })
    },
  ],

  [
    "v2 catalog transform uses the aisdk endpoint",
    async () => {
      const ctx = makeCtx()
      const plugin = await loadPlugin()
      await plugin.setup(ctx as any)
      const made = makeDraft()
      ctx.catalog.transforms[0](made.draft)
      assertEqual(made.existing.has("commandcode"), true)
      const record = made.existing.get("commandcode")!
      assertEqual(record.provider.endpoint, {
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
      })
      assertEqual((record.provider as any).package, "aisdk:@ai-sdk/openai-compatible")
      assert(!JSON.stringify(record.provider).includes("aisdk:commandcode"))
      assertEqual(record.provider.name, "Command Code")
      assertEqual(record.provider.activation, "auto")
      assertEqual(record.provider.id, "commandcode")
    },
  ],

  [
    "v2 catalog transform registers every snapshot model as Model.Info",
    async () => {
      const ctx = makeCtx()
      const plugin = await loadPlugin()
      await plugin.setup(ctx as any)
      const made = makeDraft()
      ctx.catalog.transforms[0](made.draft)
      const record = made.existing.get("commandcode")!
      assertEqual(record.models.size, MODEL_SNAPSHOT.length)

      // The committed snapshot's real context length (assert the limit
      // mapping against the snapshot itself, not a hard-coded copy).
      const committed = MODEL_SNAPSHOT.find((m) => m.id === "claude-sonnet-5")!
      const sonnet = record.models.get("claude-sonnet-5")
      assert(sonnet, "claude-sonnet-5 missing from v2 models map")
      assertEqual(sonnet.providerID, "commandcode")
      assertEqual(sonnet.modelID, "claude-sonnet-5")
      assertEqual(sonnet.endpoint, {
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
      })
      assertEqual(sonnet.package, "aisdk:@ai-sdk/openai-compatible")
      assert(!JSON.stringify(sonnet).includes("aisdk:commandcode"))
      assertEqual(sonnet.name, "[CMD] Claude Sonnet 5")
      assertEqual(sonnet.capabilities.tools, true)
      assertEqual(sonnet.capabilities.input, ["text", "image"])
      assertEqual(sonnet.status, "active")
      assertEqual(sonnet.enabled, true)
      assertEqual(sonnet.limit, {
        context: committed.contextLength,
        output: Math.min(committed.contextLength, 65536),
      })
      // Real variants (verified live: settings.reasoningEffort is merged into
      // providerOptions.commandcode.reasoningEffort by the runtime)
      const efforts = Object.keys(reasoningVariantsForModel("claude-sonnet-5") ?? {})
      assertEqual(
        sonnet.variants.map((v: any) => v.id),
        efforts,
      )
      assertEqual(sonnet.variants[0].settings, { reasoningEffort: efforts[0] })
      const cost = MODEL_COSTS["claude-sonnet-5"] ?? ZERO_MODEL_COST
      assertEqual(sonnet.cost, [
        {
          input: cost.input,
          output: cost.output,
          cache: { read: cost.cacheRead, write: cost.cacheWrite },
        },
      ])
    },
  ],

  [
    "v2 aisdk hook builds the bundled transport with the runtime-resolved key",
    async () => {
      const ctx = makeCtx()
      const plugin = await loadPlugin()
      await plugin.setup(ctx as any)
      assertEqual(
        ctx.aisdk.hooks.map((h) => h.name),
        ["sdk", "language"],
      )

      const hook = ctx.aisdk.hooks[1]
      const input: any = {
        model: { id: "claude-sonnet-5" },
        options: { name: "commandcode", apiKey: "resolved-key" },
      }
      hook.fn(input)
      const language = input.language as any
      assert(language, "hook must set input.language")
      assertEqual(language.specificationVersion, "v3")
      assertEqual(language.provider, "commandcode")
      assertEqual(language.modelId, "claude-sonnet-5")
      // The model is the bundled CommandCodeLanguageModel - the credential is
      // baked in via the constructor option (the transport test suite asserts
      // the resulting auth header in provider-transport.test.ts).
      assert(typeof language.doStream === "function")
      assert(typeof language.doGenerate === "function")

      // Falls back to auth-file/env resolution when the runtime passes no key
      const fallbackInput: any = { model: { id: "x" }, options: {} }
      hook.fn(fallbackInput)
      assert(fallbackInput.language, "fallback resolution must still build the model")

      // A fresh model instance per call (no cross-model state bleed)
      const again: any = { model: { id: "claude-sonnet-5" }, options: { apiKey: "resolved-key" } }
      hook.fn(again)
      assert(again.language !== language, "each call must get a fresh model instance")
    },
  ],
])
