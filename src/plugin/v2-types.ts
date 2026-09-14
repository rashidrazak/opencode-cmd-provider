// src/plugin/v2-types.ts — the OpenCode v2 plugin-context slice this package
// consumes, mirrored structurally (ADR-0010).
//
// OpenCode v2 loads a plugin's default export and calls `setup(context)`; the
// context *is* the extension API. We deliberately do not depend on
// `@opencode/plugin`: the host injects the context object, so this package
// never resolves that module at runtime — the same load-time landmine the
// `@opencode-ai/*` rule exists for (see tests/contract.test.ts). Only the
// members this plugin touches are declared; the shapes are hand-mirrored from
// `@opencode/plugin@2.0.3` (`dist/promise/{plugin,catalog,integration,tool,aisdk}.d.ts`)
// and `@opencode/schema@2.0.3` (`Provider.Info`, `Model.Info`, `Tool.Info`).
// Bumping the supported v2 line means re-deriving these from the published
// package — tests/plugin-v2.test.ts pins the parts we depend on.

/** Provider record draft: `Provider.Info` with `DeepMutable` applied. */
export interface V2ProviderInfo {
  id: string
  canonical?: string
  integrationID?: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

/** One context-tier cost entry: `Model.Cost` with `DeepMutable` applied. */
export interface V2ModelCost {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface V2ModelVariant {
  id: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

/** Model record draft: `Model.Info` with `DeepMutable` applied. */
export interface V2ModelInfo {
  id: string
  modelID: string
  providerID: string
  canonical?: string
  family?: string
  name: string
  compatibility?: { reasoningField?: string; requireReasoning?: boolean }
  package?: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
  capabilities: { tools: boolean; input: string[]; output: string[] }
  variants: V2ModelVariant[]
  time: { released: number }
  cost: V2ModelCost[]
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; input?: number; output: number }
}

export interface V2CatalogProviderRecord {
  provider: V2ProviderInfo
  models: ReadonlyMap<string, V2ModelInfo>
}

/**
 * `catalog.transform` editor. Edits are replayable: the host rebuilds the
 * visible catalog by replaying every active transform onto a fresh value, so a
 * callback must stay synchronous, cheap, and free of one-time side effects.
 *
 * `provider.update` / `model.update` are upserts — a record that does not exist
 * yet is seeded from `Provider.Info.empty(id)` (`{ id, name: id, activation:
 * "auto", package: "" }`) or `Model.Info.default(providerID, id)` (`name = id`,
 * default capabilities, empty `cost`, `limit` 200k/32k) before the callback
 * runs. That seeding is what makes the gap-fill checks below meaningful.
 */
export interface V2CatalogEditor {
  provider: {
    list(): readonly V2CatalogProviderRecord[]
    get(providerID: string): V2CatalogProviderRecord | undefined
    update(providerID: string, update: (provider: V2ProviderInfo) => void): void
    remove(providerID: string): void
  }
  model: {
    get(providerID: string, modelID: string): V2ModelInfo | undefined
    update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void
    remove(providerID: string, modelID: string): void
    default: {
      get(): { providerID: string; modelID: string } | undefined
      set(providerID: string, modelID: string): void
    }
  }
}

export interface V2IntegrationRef {
  id: string
  name: string
}

export interface V2IntegrationEnvMethod {
  type: "env"
  names: readonly string[]
}

export interface V2IntegrationKeyMethod {
  type: "key"
  label?: string
}

export type V2IntegrationMethodRegistration =
  | { integrationID: string; method: V2IntegrationEnvMethod }
  | { integrationID: string; method: V2IntegrationKeyMethod }

/** `integration.transform` editor (`Integration.Editor`). */
export interface V2IntegrationEditor {
  list(): readonly V2IntegrationRef[]
  get(id: string): V2IntegrationRef | undefined
  update(id: string, update: (integration: V2IntegrationRef) => void): void
  remove(id: string): void
  method: {
    list(integrationID: string): readonly (V2IntegrationEnvMethod | V2IntegrationKeyMethod)[]
    update(input: V2IntegrationMethodRegistration): void
    remove(integrationID: string, method: V2IntegrationEnvMethod | V2IntegrationKeyMethod): void
  }
}

export interface V2ToolResult {
  content?: string | ReadonlyArray<{ type: "text"; text: string }>
  metadata?: Readonly<Record<string, unknown>>
}

/**
 * `Tool.Info` as the Promise adapter restates it: `input` is JSON Schema (or a
 * schema codec) and `execute` returns a Promise of the structured result.
 * Declaring the single input parameter is assignable to the host signature.
 */
export interface V2ToolDefinition<Input = Record<string, unknown>> {
  name: string
  description: string
  input: Record<string, unknown>
  execute(input: Input): Promise<V2ToolResult>
}

/** `tool.transform` editor. Missing ids are ignored by `update`, never created. */
export interface V2ToolEditor {
  list(): readonly V2ToolDefinition[]
  get(id: string): V2ToolDefinition | undefined
  add(tool: V2ToolDefinition): void
  update(id: string, update: (tool: V2ToolDefinition) => void): void
  remove(id: string): void
}

export interface V2SDKEvent {
  readonly model: V2ModelInfo
  readonly package: string
  readonly options: Record<string, unknown>
  sdk?: unknown
}

/**
 * The context slice `setup` consumes. `transform`/`hook` resolve to a
 * `Registration` in the host API; the plugin keeps no registrations, so the
 * resolved value is not part of the mirror.
 */
export interface V2SetupContext {
  readonly catalog: {
    transform(callback: (editor: V2CatalogEditor) => void): Promise<unknown>
  }
  readonly integration: {
    transform(callback: (editor: V2IntegrationEditor) => void): Promise<unknown>
  }
  readonly tool: {
    transform(callback: (editor: V2ToolEditor) => void): Promise<unknown>
  }
  readonly aisdk: {
    hook(
      name: "sdk",
      callback: (event: V2SDKEvent) => void,
      options?: { providerID?: string },
    ): Promise<unknown>
  }
}

/** `Plugin` from `@opencode/plugin@2.0.3` — the v2 half of the dual export. */
export interface V2Plugin {
  readonly id: string
  readonly setup: (context: V2SetupContext) => Promise<void> | void
}
