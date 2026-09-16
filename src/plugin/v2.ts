// src/plugin/v2.ts — OpenCode v2 half of the dual entrypoint (ADR-0010).
//
// v2 calls `setup(context)` once at plugin load; the context is both the
// server client and the extension API, and every edit a plugin makes is a
// *transform*: a synchronous, replayable state edit the host re-applies onto a
// fresh value whenever registrations change. The three v1 hooks therefore have
// three v2 destinations:
//
//   v1 `config` hook      → `ctx.catalog.transform`      (Auto-registration)
//   v1 `auth` hook        → `ctx.integration.transform`  (`/connect` + env key)
//   v1 `tool` map         → `ctx.tool.transform`
//   v1 runtime provider   → `ctx.aisdk.hook("sdk")`      (the LanguageModelV3)
//
// The runtime half matters: in v2 the auto-registered provider's `package` is
// `aisdk:<Provider specifier>`, which the model resolver deliberately refuses to
// install — it requires a plugin to hand it the SDK. `ctx.aisdk.hook("sdk")` is
// that seam, and the object it hands over is the very same `createCommandCode`
// factory the v1 provider entry exports.
import { MODEL_SNAPSHOT, type CatalogModel } from "../catalog/snapshot.js"
import { getApiBase } from "../env.js"
import { createCommandCode } from "../provider/index.js"
import { catalogModelForV2, catalogVariantsForV2, DEFAULT_DISPLAY_PREFIX } from "./models.js"
import { resolveProviderNpm } from "./version.js"
import type {
  V2CatalogEditor,
  V2IntegrationEditor,
  V2ModelInfo,
  V2ProviderInfo,
  V2SDKEvent,
  V2SetupContext,
  V2ToolDefinition,
} from "./v2-types.js"

export const PROVIDER_ID = "commandcode"
export const PROVIDER_NAME = "Command Code"
/** Ordered environment variable names that can supply the credential. */
export const API_KEY_ENV = "COMMANDCODE_API_KEY"
/** v2's marker for "a plugin supplies this model's runtime SDK". */
export const AISDK_PREFIX = "aisdk:"
/**
 * First-run default model (ADR-0001): v1 lands here through OpenCode's
 * hardcoded provider-priority list, so v2 has to ask for it explicitly. Set
 * only when no default exists yet — a user's configured model always wins,
 * because the config transform is registered before this one and replays first.
 */
export const FIRST_RUN_DEFAULT_MODEL_ID = "gpt-5.6-terra"

/** Deals-intelligence seams; Core never imports the slice (ADR-0004). */
export interface V2SetupExtensions {
  /** Extra catalog pass, replayed after Auto-registration. */
  enrichCatalog?: (catalog: V2CatalogEditor) => void
  /** Extra tools registered alongside the core set. */
  tools?: readonly V2ToolDefinition[]
}

/**
 * Registers everything the `commandcode` provider needs in an OpenCode v2 host.
 * Pure with respect to the host: each callback mutates only the draft it is
 * handed, so a replay rebuilds the same state from the same inputs.
 */
export async function setupCommandCode(
  ctx: V2SetupContext,
  extensions: V2SetupExtensions = {},
): Promise<void> {
  // Resolved once per load, never at import time (ADR-0009): a degraded
  // registration beats a plugin that will not load.
  const specifier = `${AISDK_PREFIX}${resolveProviderNpm()}`
  await ctx.catalog.transform((catalog) => {
    registerProvider(catalog, specifier)
    registerModels(catalog)
    extensions.enrichCatalog?.(catalog)
    selectFirstRunDefault(catalog)
  })
  await ctx.integration.transform(registerIntegration)
  if (extensions.tools !== undefined && extensions.tools.length > 0) {
    const tools = extensions.tools
    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool)
    })
  }
  await ctx.aisdk.hook("sdk", provideSdk, { providerID: PROVIDER_ID })
}

/**
 * Provider-level gap-fill. The editor seeds a missing provider from
 * `Provider.Info.empty(id)` (`{ id, name: id, activation: "auto", package: "" }`)
 * and the config transform has already applied the user's declared
 * `providers.commandcode` entry, so "still at the seed value" is exactly the
 * "user left it unset" signal — the v2 counterpart of v1's `??=` fills.
 */
export function registerProvider(catalog: V2CatalogEditor, specifier: string): void {
  catalog.provider.update(PROVIDER_ID, (provider: V2ProviderInfo) => {
    if (provider.name === provider.id) provider.name = PROVIDER_NAME
    if (provider.package === "") provider.package = specifier
    // Ties the provider to the credential that unlocks it, so availability
    // follows the connection — the same coupling as v1's declared `env`.
    if (provider.integrationID === undefined) provider.integrationID = PROVIDER_ID
    if (provider.settings?.["baseURL"] === undefined) {
      provider.settings ??= {}
      provider.settings["baseURL"] = getApiBase()
    }
  })
}

/**
 * Snapshot → v2 catalog. A model the draft already carries came from the user's
 * config or an earlier plugin, and Declared models are never modified — the one
 * exception is the reasoning gap-fill v1 also performed on declared entries
 * (`augmentConfigCommandCodeModels`): variants are added only when the entry has
 * none, so a declared effort list survives.
 */
export function registerModels(
  catalog: V2CatalogEditor,
  snapshot: readonly CatalogModel[] = MODEL_SNAPSHOT,
): void {
  const prefix = displayPrefixFromDraft(catalog)
  for (const model of snapshot) {
    const declared = catalog.model.get(PROVIDER_ID, model.id) !== undefined
    catalog.model.update(PROVIDER_ID, model.id, (entry: V2ModelInfo) => {
      if (declared) {
        if (entry.variants.length === 0) entry.variants = catalogVariantsForV2(model.id)
        return
      }
      Object.assign(entry, catalogModelForV2(model, prefix))
    })
  }
}

/**
 * Reads the Display name prefix from the draft: a declared
 * `providers.commandcode.settings.display_prefix` string wins, anything else
 * falls back to `[CMD] `. Read-only, and never written back into the provider
 * entry — the prefix is presentation, not configuration.
 */
function displayPrefixFromDraft(catalog: V2CatalogEditor): string {
  const settings = catalog.provider.get(PROVIDER_ID)?.provider.settings
  const value = settings?.["display_prefix"]
  return typeof value === "string" ? value : DEFAULT_DISPLAY_PREFIX
}

/**
 * `/connect` and `COMMANDCODE_API_KEY` in v2 terms: an integration record plus
 * the two methods that can produce a key credential. The browser OAuth flow
 * stays v1-only — a v2 OAuth method must yield a refresh/access token pair
 * (`Credential.OAuth`), and Command Code issues an API key, so registering the
 * flow there would store a credential the host would then try to refresh.
 */
export function registerIntegration(integrations: V2IntegrationEditor): void {
  integrations.update(PROVIDER_ID, (integration) => {
    if (integration.name === integration.id) integration.name = PROVIDER_NAME
  })
  integrations.method.update({
    integrationID: PROVIDER_ID,
    method: { type: "env", names: [API_KEY_ENV] },
  })
  integrations.method.update({
    integrationID: PROVIDER_ID,
    method: { type: "key", label: `${PROVIDER_NAME} API key` },
  })
}

/**
 * Hands the host the runtime SDK for `commandcode` models. The host passes the
 * model's merged settings/headers/body as `options` and a transport-aware
 * `fetch`; both flow into the same factory the v1 provider entry exports, so
 * streaming, retries, and redaction are one implementation.
 */
export function provideSdk(event: V2SDKEvent): void {
  if (event.model.providerID !== PROVIDER_ID) return
  event.sdk = createCommandCode({ ...event.options, name: PROVIDER_ID })
}

/**
 * First-run default (ADR-0001): only when nothing has claimed the default yet
 * and the documented model is still in the Snapshot.
 */
function selectFirstRunDefault(
  catalog: V2CatalogEditor,
  snapshot: readonly CatalogModel[] = MODEL_SNAPSHOT,
): void {
  if (catalog.model.default.get() !== undefined) return
  if (!snapshot.some((model) => model.id === FIRST_RUN_DEFAULT_MODEL_ID)) return
  catalog.model.default.set(PROVIDER_ID, FIRST_RUN_DEFAULT_MODEL_ID)
}
