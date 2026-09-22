// tests/plugin-v2.test.ts — the OpenCode v2 half of the dual entrypoint
// (ADR-0010).
//
// The host is faked at the draft level, reproducing the two seeding rules the
// real editors apply (`provider/model/integration` editors at v2.0.5):
//
//   provider.update(id) on a missing provider seeds `Provider.Info.empty(id)`
//     = { id, name: id, activation: "auto", package: "" }
//   model.update(id) on a missing model seeds `Model.Info.default(providerID, id)`
//     = { name: id, capabilities: { tools: true, input: ["text","image"],
//         output: ["text"] }, variants: [], time: { released: 0 }, cost: [],
//         status: "active", enabled: true, limit: { context: 200_000, output: 32_000 } }
//
// Gap-fill behaviour ("a declared value wins") is only observable against those
// seeds, so they are reproduced exactly rather than approximated. `replay()`
// rebuilds the catalog from a fresh draft by re-applying every registered
// transform onto it — which is what the host does whenever a registration
// changes — so replay stability is exercised, not assumed.
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import {
  AISDK_PREFIX,
  API_KEY_ENV,
  FIRST_RUN_DEFAULT_MODEL_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  hostCredentialFromV2,
  provideSdk,
  registerIntegration,
  registerModels,
  registerProvider,
  setupCommandCode,
} from "../src/plugin/v2.js"
import { resolveProviderNpm } from "../src/plugin/version.js"
import { MODEL_DEALS } from "../src/deals/catalog.js"
import { enrichCommandCodeModelsV2 } from "../src/deals/enrichment.js"
import {
  planSummaryTool,
  planSummaryV2Tool,
  PLAN_SUMMARY_ARG_DESCRIPTION,
} from "../src/deals/plan-summary.js"
import { assert, assertEqual, run, withEnvVars } from "./harness.js"
import type {
  V2ProviderEditor,
  V2ModelEditor,
  V2IntegrationEditor,
  V2IntegrationMethodRegistration,
  V2ModelInfo,
  V2ProviderInfo,
  V2ConnectionInfo,
  V2CredentialValue,
  V2SDKEvent,
  V2SetupContext,
  V2ToolDefinition,
} from "../src/plugin/v2-types.js"

type ProviderRecord = { provider: V2ProviderInfo; models: Map<string, V2ModelInfo> }
type IntegrationRecord = { id: string; name: string; methods: unknown[] }
type DefaultRef = { value?: { providerID: string; modelID: string } }

/** `Provider.Info.empty(id)` — @opencode/schema 2.0.5. */
function emptyProvider(id: string): V2ProviderInfo {
  return { id, name: id, activation: "auto", package: "" }
}

/** `Model.Info.default(providerID, id)` — @opencode/schema 2.0.5. */
function defaultModel(providerID: string, id: string): V2ModelInfo {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }
}

/** `Provider/Editor` + `Model/Editor` over one draft, with the host's upsert seeds. */
function providerEditor(draft: Map<string, ProviderRecord>): V2ProviderEditor {
  const record = (providerID: string): ProviderRecord => {
    const current = draft.get(providerID)
    if (current) return current
    const created: ProviderRecord = { provider: emptyProvider(providerID), models: new Map() }
    draft.set(providerID, created)
    return created
  }
  return {
    list: () => [...draft.values()],
    get: (providerID) => draft.get(providerID),
    add: (input) => {
      if (draft.has(input.info.id)) return
      draft.set(input.info.id, {
        provider: { ...input.info },
        models: new Map(input.models.map((m) => [m.id, { ...m }])),
      })
    },
    update: (providerID, update) => {
      const current = record(providerID)
      update(current.provider)
      current.provider.id = providerID
    },
    remove: (providerID) => void draft.delete(providerID),
    models: {
      set: (providerID, models) => {
        const current = record(providerID)
        current.models = new Map(models.map((m) => [m.id, { ...m }]))
      },
      update: (providerID, modelID, update) => {
        const current = record(providerID)
        const model = current.models.get(modelID) ?? defaultModel(providerID, modelID)
        if (!current.models.has(modelID)) current.models.set(modelID, model)
        update(model)
        model.id = modelID
        model.providerID = providerID
      },
      remove: (providerID, modelID) => void draft.get(providerID)?.models.delete(modelID),
    },
  }
}

function modelEditor(draft: Map<string, ProviderRecord>, defaultRef: DefaultRef): V2ModelEditor {
  return {
    list: (providerID) => {
      const all: V2ModelInfo[] = []
      for (const [pid, rec] of draft) {
        if (providerID !== undefined && pid !== providerID) continue
        all.push(...rec.models.values())
      }
      return all
    },
    get: (providerID, modelID) => draft.get(providerID)?.models.get(modelID),
    update: (providerID, modelID, update) => {
      const model = draft.get(providerID)?.models.get(modelID)
      if (model) update(model)
    },
    remove: (providerID, modelID) => void draft.get(providerID)?.models.delete(modelID),
    default: {
      get: () => defaultRef.value,
      set: (providerID, modelID) => {
        defaultRef.value = { providerID, modelID }
      },
    },
    provider: {
      list: () => [...draft.values()],
      get: (providerID) => draft.get(providerID),
    },
  }
}

/** `Integration.Editor` over one draft, with the host's upsert seed. */
function integrationEditor(draft: Map<string, IntegrationRecord>): V2IntegrationEditor {
  const record = (id: string) => {
    const current = draft.get(id)
    if (current) return current
    const created: IntegrationRecord = { id, name: id, methods: [] }
    draft.set(id, created)
    return created
  }
  return {
    list: () => [...draft.values()],
    get: (id) => draft.get(id),
    update: (id, update) => {
      const current = record(id)
      update(current)
      current.id = id
    },
    remove: (id) => void draft.delete(id),
    method: {
      list: (integrationID) => (draft.get(integrationID)?.methods ?? []) as never,
      update: (input: V2IntegrationMethodRegistration) => {
        const current = record(input.integrationID)
        const key = JSON.stringify(input.method)
        const index = current.methods.findIndex((method) => JSON.stringify(method) === key)
        if (index === -1) current.methods.push(input.method)
        else current.methods[index] = input.method
      },
      remove: (integrationID, method) => {
        const current = draft.get(integrationID)
        if (!current) return
        const key = JSON.stringify(method)
        current.methods = current.methods.filter((item) => JSON.stringify(item) !== key)
      },
    },
  }
}

interface FakeHost {
  ctx: V2SetupContext
  /** Replays every provider transform onto a fresh draft; returns the draft. */
  replay(): Map<string, ProviderRecord>
  /** Replays provider + model transforms and returns the resulting default model. */
  replayDefault(): { providerID: string; modelID: string } | undefined
  /** Replays every integration transform onto a fresh draft. */
  replayIntegrations(): Map<string, IntegrationRecord>
  /** Replays every tool transform onto a fresh draft. */
  tools(): Map<string, V2ToolDefinition<never>>
  /** Runs the registered SDK hooks for one model and returns the event. */
  sdkEvent(model?: Partial<V2ModelInfo>): V2SDKEvent
  /** Seeds a draft before the first replay, as the config transforms would. */
  seedCatalog(seed: (draft: Map<string, ProviderRecord>) => void): void
  /** Seeds an already-chosen default model before the first replay. */
  seedDefault(providerID: string, modelID: string): void
  /**
   * Sets the Host's active connection + its resolved value, as the credential
   * store would. `undefined` = no credential and no env method (ADR-0015).
   */
  setConnection(connection: V2ConnectionInfo | undefined, credential?: V2CredentialValue): void
}

function fakeHost(): FakeHost {
  const providerTransforms: Array<(editor: V2ProviderEditor) => void> = []
  const modelTransforms: Array<(editor: V2ModelEditor) => void> = []
  const integrationTransforms: Array<(editor: V2IntegrationEditor) => void> = []
  const toolTransforms: Array<(editor: ToolEditor) => void> = []
  const sdkHooks: Array<{ callback: (event: V2SDKEvent) => void; providerID?: string }> = []
  const catalogSeeds: Array<(draft: Map<string, ProviderRecord>) => void> = []
  const defaultSeeds: Array<{ providerID: string; modelID: string }> = []
  let active:
    | { integrationID: string; connection: V2ConnectionInfo; credential?: V2CredentialValue }
    | undefined
  const build = (): { draft: Map<string, ProviderRecord>; defaultRef: DefaultRef } => {
    const draft = new Map<string, ProviderRecord>()
    for (const seed of catalogSeeds) seed(draft)
    const defaultRef: DefaultRef = {}
    const seeded = defaultSeeds[0]
    if (seeded) defaultRef.value = { ...seeded }
    return { draft, defaultRef }
  }

  const ctx: V2SetupContext = {
    provider: {
      transform: async (callback) => {
        providerTransforms.push(callback)
        return {}
      },
    },
    model: {
      transform: async (callback) => {
        modelTransforms.push(callback)
        return {}
      },
    },
    integration: {
      transform: async (callback) => {
        integrationTransforms.push(callback)
        return {}
      },
      // Mirrors the Host service: `active` answers for the integration the
      // provider points at, `resolve` reads the env var for an env connection.
      connection: {
        active: async (integrationID) =>
          active?.integrationID === integrationID ? active.connection : undefined,
        resolve: async (connection) => {
          if (connection.type === "env") {
            const value = process.env[connection.name]
            return value ? { type: "key", key: value } : undefined
          }
          return active?.credential
        },
      },
    },
    tool: {
      transform: async (callback) => {
        toolTransforms.push(callback)
        return {}
      },
    },
    aisdk: {
      hook: async (name, callback, options) => {
        assertEqual(name, "sdk")
        sdkHooks.push({ callback, providerID: options?.providerID })
        return {}
      },
    },
  }

  const replayWith = (): { draft: Map<string, ProviderRecord>; defaultRef: DefaultRef } => {
    const { draft, defaultRef } = build()
    const peditor = providerEditor(draft)
    for (const transform of providerTransforms) transform(peditor)
    const meditor = modelEditor(draft, defaultRef)
    for (const transform of modelTransforms) transform(meditor)
    return { draft, defaultRef }
  }

  return {
    ctx,
    replay: () => replayWith().draft,
    replayDefault: () => replayWith().defaultRef.value,
    replayIntegrations: () => {
      const draft = new Map<string, IntegrationRecord>()
      const editor = integrationEditor(draft)
      for (const transform of integrationTransforms) transform(editor)
      return draft
    },
    tools: () => {
      const draft = new Map<string, V2ToolDefinition<never>>()
      for (const transform of toolTransforms) transform(toolEditor(draft))
      return draft
    },
    sdkEvent: (model) => {
      const event: V2SDKEvent = {
        model: { ...defaultModel(PROVIDER_ID, "gpt-5.6-terra"), ...model },
        package: resolveProviderNpm(),
        options: {},
      }
      for (const hook of sdkHooks) {
        if (hook.providerID !== undefined && hook.providerID !== event.model.providerID) continue
        hook.callback(event)
      }
      return event
    },
    seedCatalog: (seed) => void catalogSeeds.push(seed),
    seedDefault: (providerID, modelID) => void defaultSeeds.push({ providerID, modelID }),
    setConnection: (connection, credential) => {
      active = connection
        ? { integrationID: PROVIDER_ID, connection, ...(credential ? { credential } : {}) }
        : undefined
    },
  }
}

type ToolEditor = {
  list(): readonly V2ToolDefinition<never>[]
  get(id: string): V2ToolDefinition<never> | undefined
  add(tool: V2ToolDefinition<never>): void
  update(id: string, update: (tool: V2ToolDefinition<never>) => void): void
  remove(id: string): void
}

function toolEditor(draft: Map<string, V2ToolDefinition<never>>): ToolEditor {
  return {
    list: () => [...draft.values()],
    get: (id) => draft.get(id),
    add: (tool) => void draft.set(tool.name, tool),
    update: (id, update) => {
      const tool = draft.get(id)
      if (tool) update(tool)
    },
    remove: (id) => void draft.delete(id),
  }
}

/** The plugin as the v2 host installs it, Deals seams included. */
async function installed(): Promise<FakeHost> {
  const host = fakeHost()
  await setupCommandCode(host.ctx, {
    enrichProvider: enrichCommandCodeModelsV2,
    tools: [planSummaryV2Tool()],
  })
  return host
}

/**
 * The package entrypoint's v2 half — the real `setup`, not a rehearsal — so the
 * Deals tool is exercised with the credential wiring the Host actually gets
 * (ADR-0015).
 */
async function installedFromEntrypoint(): Promise<FakeHost> {
  const host = fakeHost()
  const mod = (await import("../src/plugin/index.js")) as {
    default: { setup?: (ctx: V2SetupContext) => Promise<void> | void }
  }
  await mod.default.setup?.(host.ctx)
  return host
}

run([
  [
    "provider registers with the aisdk-prefixed pinned specifier, the integration link, and the API base",
    async () => {
      const provider = (await installed()).replay().get(PROVIDER_ID)?.provider
      assert(provider, "the commandcode provider must be registered")
      assertEqual(provider.name, PROVIDER_NAME)
      assertEqual(provider.package, `${AISDK_PREFIX}${resolveProviderNpm()}`)
      assertEqual(provider.integrationID, PROVIDER_ID)
      assertEqual(provider.activation, "auto")
      assertEqual(provider.settings?.["baseURL"], "https://api.commandcode.ai")
    },
  ],
  [
    "every Snapshot model is auto-registered under the provider",
    async () => {
      const catalog = (await installed()).replay()
      assertEqual(catalog.get(PROVIDER_ID)?.models.size, MODEL_SNAPSHOT.length)
    },
  ],
  [
    "a Snapshot row keeps its Display name, limits, modalities, and rates in v2",
    async () => {
      const catalog = (await installed()).replay()
      const row = MODEL_SNAPSHOT.find(
        (model) => model.cost !== null && model.contextLength !== null,
      )
      assert(row, "the Snapshot must carry a fully-specified row")
      const model = catalog.get(PROVIDER_ID)?.models.get(row.id)
      assert(model, `${row.id} must be registered`)
      assertEqual(model.name, `[CMD] ${row.name}`)
      assertEqual(model.limit.context, row.contextLength)
      assertEqual(model.limit.output, Math.min(row.contextLength as number, 65_536))
      assertEqual(model.capabilities.tools, true)
      assertEqual(model.capabilities.output, ["text"])
      assertEqual(model.cost[0]?.input, row.cost?.input)
      assertEqual(model.cost[0]?.cache.read, row.cost?.cacheRead)
      assertEqual(model.status, "active")
    },
  ],
  [
    "a Snapshot row with a missing price advertises no cost entry (never a $0 tier)",
    async () => {
      const row = MODEL_SNAPSHOT.find((model) => model.cost === null)
      if (!row) return // every row priced: nothing to assert this run
      const catalog = (await installed()).replay()
      assertEqual(catalog.get(PROVIDER_ID)?.models.get(row.id)?.cost, [])
    },
  ],
  [
    "reasoning efforts become variants whose settings carry the effort",
    async () => {
      const row = MODEL_SNAPSHOT.find((model) => (model.efforts?.length ?? 0) > 0)
      assert(row, "the Snapshot must carry an efforts row")
      const catalog = (await installed()).replay()
      const model = catalog.get(PROVIDER_ID)?.models.get(row.id)
      assertEqual(
        model?.variants.map((variant) => variant.id),
        [...(row.efforts as readonly string[])],
      )
      assertEqual(model?.variants[0]?.settings, { reasoningEffort: row.efforts?.[0] })
    },
  ],
  [
    "the first-run default model is registered when nothing claimed the default",
    async () => {
      assertEqual((await installed()).replayDefault(), {
        providerID: PROVIDER_ID,
        modelID: FIRST_RUN_DEFAULT_MODEL_ID,
      })
    },
  ],
  [
    "a default model the user already chose is never overridden",
    async () => {
      const host = await installed()
      host.seedDefault("anthropic", "claude-sonnet-5")
      assertEqual(host.replayDefault(), { providerID: "anthropic", modelID: "claude-sonnet-5" })
    },
  ],
  [
    "replaying the transforms is stable — the Deals tier is never duplicated",
    async () => {
      const host = await installed()
      const first = host.replay()
      const second = host.replay()
      assertEqual(
        JSON.stringify([...second.get(PROVIDER_ID)!.models.entries()]),
        JSON.stringify([...first.get(PROVIDER_ID)!.models.entries()]),
      )
    },
  ],
  [
    "a declared provider name, package, and baseURL win over Auto-registration",
    async () => {
      const host = fakeHost()
      host.seedCatalog((draft) => {
        draft.set(PROVIDER_ID, {
          provider: {
            ...emptyProvider(PROVIDER_ID),
            name: "My Command Code",
            package: "aisdk:@me/cmd",
            settings: { baseURL: "https://proxy.example/v1", display_prefix: ">> " },
          },
          models: new Map(),
        })
      })
      await setupCommandCode(host.ctx, {})
      const catalog = host.replay()
      const provider = catalog.get(PROVIDER_ID)?.provider
      assertEqual(provider?.name, "My Command Code")
      assertEqual(provider?.package, "aisdk:@me/cmd")
      assertEqual(provider?.settings?.["baseURL"], "https://proxy.example/v1")
      // The declared display prefix is read for Display names, never overwritten.
      assertEqual(provider?.settings?.["display_prefix"], ">> ")
      const row = MODEL_SNAPSHOT[0]!
      assertEqual(catalog.get(PROVIDER_ID)?.models.get(row.id)?.name, `>> ${row.name}`)
    },
  ],
  [
    "a declared model keeps its name and limits and gains only missing variants",
    async () => {
      const row = MODEL_SNAPSHOT.find((model) => (model.efforts?.length ?? 0) > 0)!
      const host = fakeHost()
      host.seedCatalog((draft) => {
        draft.set(PROVIDER_ID, {
          provider: emptyProvider(PROVIDER_ID),
          models: new Map([
            [
              row.id,
              {
                ...defaultModel(PROVIDER_ID, row.id),
                name: "My Name",
                limit: { context: 12_345, output: 999 },
              },
            ],
          ]),
        })
      })
      await setupCommandCode(host.ctx, {})
      const model = host.replay().get(PROVIDER_ID)?.models.get(row.id)
      assertEqual(model?.name, "My Name")
      assertEqual(model?.limit, { context: 12_345, output: 999 })
      assertEqual(
        model?.variants.map((variant) => variant.id),
        [...(row.efforts as readonly string[])],
      )
    },
  ],
  [
    "an integration carries the env key and a key method, named for the provider",
    async () => {
      const integration = (await installed()).replayIntegrations().get(PROVIDER_ID)
      assertEqual(integration?.name, PROVIDER_NAME)
      assertEqual(integration?.methods, [
        { type: "env", names: [API_KEY_ENV] },
        { type: "key", label: `${PROVIDER_NAME} API key` },
      ])
    },
  ],
  [
    "a declared integration name wins",
    () => {
      const integrations = new Map<string, IntegrationRecord>()
      integrations.set(PROVIDER_ID, { id: PROVIDER_ID, name: "Mine", methods: [] })
      registerIntegration(integrationEditor(integrations))
      assertEqual(integrations.get(PROVIDER_ID)?.name, "Mine")
    },
  ],
  [
    "cmd_plan_summary registers once with the shared description and a JSON Schema argument",
    async () => {
      const tool = (await installed()).tools().get("cmd_plan_summary")
      assert(tool, "the Deals tool must be registered")
      assertEqual(tool.description, planSummaryTool().description)
      assertEqual(tool.input, {
        type: "object",
        properties: {
          plan: { type: "string", description: PLAN_SUMMARY_ARG_DESCRIPTION },
        },
        additionalProperties: false,
      })
    },
  ],
  [
    "the v2 tool returns the same rendered plan summary as the v1 tool",
    async () => {
      const result = await planSummaryV2Tool().execute({ plan: "go" })
      assert(typeof result.content === "string" && result.content.length > 0)
      assertEqual(result.content, await planSummaryTool().execute({ plan: "go" }))
    },
  ],
  [
    "hostCredentialFromV2 maps the active connection to a key and its provenance (issue #201)",
    async () => {
      const host = fakeHost()
      const getter = hostCredentialFromV2(host.ctx)
      assertEqual(await getter(), undefined, "no connection must not invent a credential")

      host.setConnection(
        { type: "credential", id: "cred_1", label: "Command Code" },
        { type: "key", key: "host_key" },
      )
      assertEqual(await getter(), { key: "host_key", source: "host" })

      // A connection whose value cannot be resolved (deleted credential row)
      // falls through rather than reporting a key.
      host.setConnection({ type: "credential", id: "cred_1", label: "Command Code" })
      assertEqual(await getter(), undefined)

      host.setConnection(
        { type: "credential", id: "cred_2", label: "Command Code" },
        { type: "oauth", access: "oauth_key" },
      )
      assertEqual(await getter(), { key: "oauth_key", source: "host" })

      await withEnvVars({ [API_KEY_ENV]: "env_key" }, async () => {
        host.setConnection({ type: "env", name: API_KEY_ENV })
        assertEqual(await getter(), { key: "env_key", source: "environment" })
      })
    },
  ],
  [
    "the v2 Host's active connection credential drives cmd_plan_summary (issue #201)",
    async () => {
      const host = await installedFromEntrypoint()
      host.setConnection(
        { type: "credential", id: "cred_1", label: "Command Code" },
        { type: "key", key: "host_key" },
      )
      const tool = host.tools().get("cmd_plan_summary") as
        V2ToolDefinition<{ plan?: string }> | undefined
      assert(tool, "the Deals tool must be registered")
      const headers: Array<Record<string, string>> = []
      const stub = (async (url: string, init: RequestInit) => {
        headers.push((init.headers ?? {}) as Record<string, string>)
        return url.includes("subscriptions")
          ? new Response(
              JSON.stringify({ data: { status: "active", planId: "individual-goat" } }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ org: null }), { status: 200 })
      }) as unknown as typeof fetch
      const previous = globalThis.fetch
      globalThis.fetch = stub
      try {
        const result = await tool.execute({})
        assert(
          typeof result.content === "string" && result.content.includes("GOAT"),
          `the Host credential's plan must be rendered, got: ${String(result.content).slice(0, 60)}`,
        )
        assertEqual(headers[0]?.authorization, "Bearer host_key")
        // Resolved per call, never at registration: a /connect mid-session is
        // picked up by the next summary.
        host.setConnection(
          { type: "credential", id: "cred_2", label: "Command Code" },
          { type: "key", key: "next_key" },
        )
        await tool.execute({})
        assertEqual(headers[2]?.authorization, "Bearer next_key")
      } finally {
        globalThis.fetch = previous
      }
    },
  ],
  [
    "the sdk hook hands the host the runtime SDK for commandcode models only",
    async () => {
      const host = await installed()
      const sdk = host.sdkEvent().sdk as { languageModel(id: string): unknown } | undefined
      assert(sdk, "the commandcode model must receive an SDK")
      const model = sdk.languageModel("gpt-5.6-terra") as {
        doStream?: unknown
        doGenerate?: unknown
      }
      assertEqual(typeof model.doStream, "function")
      assertEqual(typeof model.doGenerate, "function")
      assertEqual(host.sdkEvent({ providerID: "anthropic" }).sdk, undefined)
    },
  ],
  [
    "the SDK the v2 hook supplies is built from the host's prepared model options",
    () => {
      const event: V2SDKEvent = {
        model: defaultModel(PROVIDER_ID, "gpt-5.6-terra"),
        package: resolveProviderNpm(),
        options: { baseURL: "https://example.test/v1", headers: { "x-test": "1" } },
      }
      provideSdk(event)
      assert(event.sdk, "provideSdk must set the sdk")
    },
  ],
  [
    "registerProvider leaves a non-empty package alone (idempotent replay)",
    () => {
      const draft = new Map<string, ProviderRecord>()
      const editor = providerEditor(draft)
      registerProvider(editor, "aisdk:first")
      registerProvider(editor, "aisdk:second")
      assertEqual(draft.get(PROVIDER_ID)?.provider.package, "aisdk:first")
    },
  ],
  [
    "registerModels is additive and never drops a declared model",
    () => {
      const draft = new Map<string, ProviderRecord>()
      const editor = providerEditor(draft)
      editor.models.update(PROVIDER_ID, "my-model", (model) => {
        model.name = "Mine"
      })
      registerModels(editor)
      assertEqual(draft.get(PROVIDER_ID)?.models.size, MODEL_SNAPSHOT.length + 1)
      assertEqual(draft.get(PROVIDER_ID)?.models.get("my-model")?.name, "Mine")
    },
  ],
  [
    "the Deals enrichment carries over to v2 without overwriting declared values",
    () => {
      const draft = new Map<string, ProviderRecord>()
      const editor = providerEditor(draft)
      registerModels(editor)
      const overContextId = Object.entries(MODEL_DEALS).find(
        ([, entry]) => entry.overContext !== undefined,
      )?.[0]
      assert(overContextId, "the Deals catalog must carry an over-context rate")
      editor.models.update(PROVIDER_ID, overContextId, (model) => {
        model.settings = { cmd: { declared: true } }
      })
      enrichCommandCodeModelsV2(editor)
      const model = draft.get(PROVIDER_ID)?.models.get(overContextId)
      assertEqual(model?.settings?.["cmd"], { declared: true })
      assertEqual(model?.cost.filter((entry) => entry.tier?.size === 200_000).length, 1)
    },
  ],
  [
    "an empty Deals catalog surfaces the mitigated unavailable state in v2",
    () => {
      const draft = new Map<string, ProviderRecord>()
      const editor = providerEditor(draft)
      registerModels(editor)
      enrichCommandCodeModelsV2(editor, {})
      const row = MODEL_SNAPSHOT.find(({ id }) => id === "Qwen/Qwen3.8-27B")!
      const model = draft.get(PROVIDER_ID)?.models.get(row.id)
      assertEqual(model?.family, "qwen", "family is vendor-derived, never from deals")
      assertEqual(model?.settings?.["cmd"], {
        unavailable: true,
      })
    },
  ],
  [
    "the package default export wires the v2 setup, Deals seams included",
    async () => {
      const entry = (await import("../src/plugin/index.js")) as {
        default: { id: string; setup: (ctx: V2SetupContext) => Promise<void> }
      }
      assertEqual(entry.default.id, PROVIDER_ID)
      assertEqual(typeof entry.default.setup, "function")
      const host = fakeHost()
      await entry.default.setup(host.ctx)
      const provider = host.replay().get(PROVIDER_ID)?.provider
      assertEqual(provider?.package, `${AISDK_PREFIX}${resolveProviderNpm()}`)
      assert(host.tools().has("cmd_plan_summary"), "the Deals tool must be registered")
      assertEqual(host.replayIntegrations().get(PROVIDER_ID)?.name, PROVIDER_NAME)
    },
  ],
  [
    "the v2.0.5 loader schema admits the dual export and strips the v1 half",
    async () => {
      // The assumption the whole dual entrypoint rests on: the v2 loader decodes
      // the default export with this exact Effect Schema and `Schema.Struct`
      // strips keys it does not declare, so `server` is invisible to v2 while v1
      // (which only looks for id/server/tui) ignores `setup`. Rather than trust
      // that, run the loader's own schema. Verbatim from
      // `packages/core/src/plugin/module.ts` @ v2.0.5 (`Schema.declare` guards
      // elided to the shape check that matters here).
      const effect = await import("effect").catch(() => undefined)
      if (effect === undefined) {
        // `effect` arrives transitively via @opencode-ai/plugin; losing it must
        // not turn a compatibility check into a build failure.
        console.log("skip - effect not installed")
        return
      }
      const { Schema } = effect
      const Module = Schema.Struct({
        default: Schema.Union([
          Schema.Struct({
            id: Schema.String,
            effect: Schema.declare((input: unknown) => typeof input === "function"),
          }),
          Schema.Struct({
            id: Schema.String,
            setup: Schema.declare((input: unknown) => typeof input === "function"),
          }),
        ]),
      })
      const mod = (await import("../src/plugin/index.js")) as Record<string, unknown>
      const decoded = Schema.decodeUnknownSync(Module)(mod) as {
        default: Record<string, unknown>
      }
      assertEqual(decoded.default["id"], PROVIDER_ID)
      assertEqual(typeof decoded.default["setup"], "function")
      assertEqual(Object.keys(decoded.default).sort(), ["id", "setup"])
      // The v1 half is exactly what v2 dropped.
      assertEqual(typeof (mod.default as Record<string, unknown>)["server"], "function")
    },
  ],
])
