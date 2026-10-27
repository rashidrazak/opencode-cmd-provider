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
  mergeCachedCatalog,
  readCatalogCache,
  type CachedCatalogRow,
} from "../catalog/catalog-cache.js"
import { startCatalogSync } from "./catalog-sync.js"
import type { CatalogModel } from "../catalog/snapshot.js"
import {
  enrichCommandCodeModels,
  enrichCommandCodeModelsV2,
  planSummaryTool,
  registerUsageRpc,
} from "../rates-usage/index.js"
import { planSummaryV2Tool } from "../rates-usage/plan-summary.js"
import { hostCredentialFromV1 } from "../rates-usage/host-credential.js"
import { runAuthFlow } from "./auth.js"
import { hostCredentialFromV2, setupCommandCode } from "./v2.js"
import type { Plugin } from "@opencode-ai/plugin"
import type { Config } from "@opencode-ai/sdk/v2"
import type { V2SetupContext } from "./v2-types.js"

const server: Plugin = async (input) => {
  return {
    config: async (config) => {
      autoRegister(config as Config, runtimeSnapshot(), {
        // Version-pinned on purpose (issue #152): opencode's package cache is
        // keyed by the exact specifier and never refreshed, so a bare name would
        // let the runtime provider drift away from the plugin that registered it.
        npm: resolveProviderNpm(),
        name: "Command Code",
        baseURL: getApiBase(),
      })
      augmentConfigCommandCodeModels(config as Config)
      enrichCommandCodeModels(config as Config)
      // Membership refresh runs *behind* registration (ADR-0024): the models
      // above came from the disk cache or the bundle, so the host never waits on
      // the network. The fetch primes the cache for the next start.
      void startCatalogSync()
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
 * The membership rows to register this session (ADR-0024): the bundled
 * Snapshot, with any catalog the background fetch cached last session merged
 * over it.
 *
 * The merge is a union — a cached row can add a model the bundle does not have
 * and can refresh the fields of one it does, but it can never remove a bundled
 * model. So a stale cache (or one written by an older package) cannot hide a
 * model this build ships.
 *
 * The disk read is deliberate and cheap (~1 ms): it is what keeps the network
 * off the startup path, since the host awaits `config` before reading
 * `provider.config`. Any cache defect degrades to the bundle.
 */
export function runtimeSnapshot(cachePath?: string): readonly CatalogModel[] {
  const cached = readCatalogCache(cachePath)
  if (cached === undefined) return MODEL_SNAPSHOT
  return snapshotWithCache(MODEL_SNAPSHOT, cached.rows)
}

/**
 * Merges cached rows over the bundled Snapshot rows.
 *
 * A cached row's provenance is reported as `"catalog"` — it *is* a catalog
 * observation, just a live one rather than a build-time one, and
 * `contextSource`/`costSource` only feed the refresh diff, never the runtime.
 */
export function snapshotWithCache(
  bundled: readonly CatalogModel[],
  cached: readonly CachedCatalogRow[],
): readonly CatalogModel[] {
  const toCatalogModel = (row: CachedCatalogRow): CatalogModel => ({
    id: row.id,
    name: row.name,
    contextLength: row.contextLength,
    contextSource: "catalog",
    efforts: row.efforts,
    cost: row.cost,
    // A cached row always carries a registered cost (`catalogCache` only ships
    // rows the provider can price); the null branch is unreachable but keeps the
    // generated type honest.
    costSource: "catalog",
  })
  return mergeCachedCatalog(
    bundled,
    { catalogVersion: "", fetchedAt: "", rows: [...cached] },
    toCatalogModel,
  )
}

/**
 * v2 host: the same three capabilities through the transform API. The Rates &
 * usage seams — the provider enrichment pass, the `cmd_plan_summary`
 * tool and the usage RPC bridge — are supplied here, so deleting `src/rates-usage/`
 * plus these registrations still leaves Core green (ADR-0004). The tool and
 * the bridge are handed the credential getter for the Host's active
 * connection, which is the only credential the session streams with (ADR-0015).
 */
const setup = async (ctx: V2SetupContext): Promise<void> =>
  setupCommandCode(ctx, {
    snapshot: runtimeSnapshot(),
    enrichProvider: enrichCommandCodeModelsV2,
    tools: [planSummaryV2Tool({ hostCredential: hostCredentialFromV2(ctx) })],
    rpc: (rpcCtx) => registerUsageRpc(rpcCtx, hostCredentialFromV2(rpcCtx)),
  })

export default { id: "commandcode", server, setup }
