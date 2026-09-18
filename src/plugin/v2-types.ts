// src/plugin/v2-types.ts — the OpenCode v2 plugin-context slice this package
// consumes, mirrored structurally (ADR-0010).
//
// OpenCode v2 loads a plugin's default export and calls `setup(context)`; the
// context *is* the extension API. We deliberately do not depend on
// `@opencode/plugin`: the host injects the context object, so this package
// never resolves that module at runtime — the same load-time landmine the
// `@opencode-ai/*` rule exists for (see tests/contract.test.ts). Only the
// members this plugin touches are declared; the shapes are hand-mirrored from
// `@opencode/plugin@2.0.8` (`dist/promise/{plugin,provider,model,integration,tool,aisdk}.d.ts`)
// and `@opencode/schema@2.0.8` (`Provider.Info`, `Model.Info`, `Tool.Info`,
// `Connection.Info`, `Credential.Value`). The `connection` surface has been
// byte-identical from 2.0.0 through 2.0.8. Bumping the supported v2 line means
// re-deriving these from the published package — tests/plugin-v2.test.ts pins
// the parts we depend on.

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

export interface V2ProviderRecord {
  readonly provider: V2ProviderInfo
  readonly models: ReadonlyMap<string, V2ModelInfo>
}

/**
 * `provider.transform` editor (real v2 API). Source definitions: `update`
 * edits provider settings, `models.update` edits an owned copy of a source
 * model. Both are upserts — a missing provider seeds from
 * `Provider.Info.empty(id)`, a missing model seeds from
 * `Model.Info.default(providerID, id)` — so gap-fill checks stay meaningful.
 */
export interface V2ProviderEditor {
  list(): readonly V2ProviderRecord[]
  get(providerID: string): V2ProviderRecord | undefined
  add(input: { info: V2ProviderInfo; models: readonly V2ModelInfo[] }): void
  update(providerID: string, update: (provider: V2ProviderInfo) => void): void
  remove(providerID: string): void
  readonly models: {
    set(providerID: string, models: readonly V2ModelInfo[]): void
    update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void
    remove(providerID: string, modelID: string): void
  }
}

/**
 * `model.transform` editor (real v2 API). Edits the active-provider candidate
 * collection; `provider` exposes immutable source definitions. `default`
 * selects the first-run fallback.
 */
export interface V2ModelEditor {
  list(providerID?: string): readonly V2ModelInfo[]
  get(providerID: string, modelID: string): V2ModelInfo | undefined
  update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void
  remove(providerID: string, modelID: string): void
  readonly default: {
    get(): { providerID: string; modelID: string } | undefined
    set(providerID: string, modelID: string): void
  }
  readonly provider: {
    list(): readonly V2ProviderRecord[]
    get(providerID: string): V2ProviderRecord | undefined
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

/** `Connection.Info`'s credential arm: a row in the Host's credential store. */
export interface V2ConnectionCredentialInfo {
  type: "credential"
  id: string
  label: string
}

/** `Connection.Info`'s env arm: a named environment variable the Host reads. */
export interface V2ConnectionEnvInfo {
  type: "env"
  name: string
}

/**
 * `Connection.Info` — where the active credential lives. `active()` picks one
 * of these (a stored credential, or an env var when no credential row exists)
 * and `resolve()` turns it into a `Credential.Value`.
 */
export type V2ConnectionInfo = V2ConnectionCredentialInfo | V2ConnectionEnvInfo

/**
 * The `Credential.Value` slice the plan summary reads: an API key credential,
 * or an OAuth one whose `access` token stands in for the key. The other OAuth
 * fields are deliberately not mirrored — nothing here touches them.
 */
export type V2CredentialValue = { type: "key"; key: string } | { type: "oauth"; access: string }

export interface V2ToolResult {
  content?: string | ReadonlyArray<{ type: "text"; text: string }>
  metadata?: Readonly<Record<string, unknown>>
}

/**
 * `Tool.Info` as the Promise adapter restates it: `input` is JSON Schema and
 * `execute` returns a Promise of the structured result. Declaring the single
 * input parameter is assignable to the host signature.
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
  readonly provider: {
    transform(callback: (editor: V2ProviderEditor) => void): Promise<unknown>
  }
  readonly model: {
    transform(callback: (editor: V2ModelEditor) => void): Promise<unknown>
  }
  readonly integration: {
    transform(callback: (editor: V2IntegrationEditor) => void): Promise<unknown>
    /**
     * The credential surface the model resolver uses for a provider's
     * `integrationID` — the only way a tool can learn which credential the Host
     * actually streams with (ADR-0015). `resolve` reads the named environment
     * variable itself for an `env` connection.
     */
    readonly connection: {
      active(integrationID: string): Promise<V2ConnectionInfo | undefined>
      resolve(connection: V2ConnectionInfo): Promise<V2CredentialValue | undefined>
    }
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

/** `Plugin` from `@opencode/plugin@2.0.5` — the v2 half of the dual export. */
export interface V2Plugin {
  readonly id: string
  readonly setup: (context: V2SetupContext) => Promise<void> | void
}
