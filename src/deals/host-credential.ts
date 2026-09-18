// src/deals/host-credential.ts — the v1 Host's resolved credential, read
// through the plugin's SDK client (issue #203, ADR-0015).
//
// A v1 Host resolves the provider credential itself: the auth store outranks
// COMMANDCODE_API_KEY, and a declared `options.apiKey` outranks both at model
// init (`options.apiKey ??= provider.key`, packages/opencode v1.18.30
// provider/provider.ts). `PluginInput.client` reaches that result — `GET
// /provider` serializes the record, and `Provider.toPublicInfo` strips neither
// `key` nor `options`. `source` is *not* provenance: the final config re-apply
// stamps `"config"` on every config-declared provider, so this module reports
// where the key came from instead.
//
// Two constraints shape the read:
//   - the SDK's generated response type for `/provider` omits `key`, `source`
//     and `options` even though the runtime payload carries them, so the shape
//     is parsed structurally (no casts, no runtime `@opencode-ai/*` import —
//     ADR-0010);
//   - anything unexpected — a missing provider, an error response, neither
//     field set — is `undefined`, which the tool seam treats as the next rung
//     of the ladder rather than a guessed account (ADR-0015).
//
// Timing matters: the v1 client is an *in-process* app fetch (the host builds it
// with this directory, and with no listening `serverUrl` it dispatches straight
// into the app), so calling it while the instance is still booting the plugin
// deadlocks. The getter therefore runs per tool call — after the instance is up
// — never at registration (ADR-0015, verified against 1.18.30).
import type { HostCredential } from "../provider/auth-key.js"
import { isRecord, stringValue } from "../provider/converters.js"

/**
 * The slice of the v1 SDK client this module reads. The generated client
 * resolves to `{ data, error, request, response }`; a host that hands back the
 * body directly is tolerated too.
 */
export interface V1ProviderListClient {
  provider: {
    list(): Promise<unknown>
  }
}

/** The `all[]` entry for `providerID`, or undefined when the payload misses it. */
function providerEntry(result: unknown, providerID: string): Record<string, unknown> | undefined {
  if (isRecord(result) && result.error) return undefined
  const payload =
    isRecord(result) && result.all !== undefined
      ? result
      : isRecord(result)
        ? result.data
        : undefined
  if (!isRecord(payload) || !Array.isArray(payload.all)) return undefined
  return payload.all.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === providerID,
  )
}

/**
 * The credential the v1 Host will use for `providerID`: `options.apiKey` (a
 * declared credential, which the Host prefers) before `key` (whatever the env
 * method or the auth store resolved). `source` distinguishes an env-supplied
 * key from a store one by matching it against the provider's own `env` names.
 *
 * A rejection is deliberately *not* caught here — the tool seam already maps a
 * failing Host to the next ladder rung in one place.
 */
export async function hostCredentialFromV1(
  client: V1ProviderListClient,
  providerID: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostCredential | undefined> {
  const entry = providerEntry(await client.provider.list(), providerID)
  if (!entry) return undefined

  if (isRecord(entry.options)) {
    const configured = stringValue(entry.options.apiKey)
    if (configured) return { key: configured, source: "config" }
  }

  const key = stringValue(entry.key)
  if (!key) return undefined
  const names = Array.isArray(entry.env) ? entry.env : []
  const fromEnvironment = names.some((name) => typeof name === "string" && env[name] === key)
  return { key, source: fromEnvironment ? "environment" : "host" }
}
