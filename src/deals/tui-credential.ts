// src/deals/tui-credential.ts — the credential the v1 TUI host's Deals panel
// reads usage with (issue #243, ADR-0020).
//
// The TUI host is a third process (ADR-0010) with no path to the ADR-0015
// server seam, so each half resolves the credential from the state it already
// holds. This module is the **v1** half: the provider records the TUI sync
// store was seeded with, whose `options.apiKey ?? key` are the very fields the
// v1 Host resolves the credential into and serializes without stripping
// (ADR-0015's verified read), with the TUI's own `client.provider.list()` as
// the same payload's live fallback. Below it, the package ladder:
// `COMMANDCODE_API_KEY`, then the legacy auth files, keeping the file label as
// provenance.
//
// The **v2** half does not resolve locally: v2's provider payload no longer
// carries the credential, and the TUI context has no connection service, so
// the credential lives only behind the Host's server-side seam. The v2 panel
// therefore asks the plugin's own server half over the plugin-RPC bridge
// (src/deals/usage-rpc.ts), which resolves the Host's active connection —
// stored credentials included — and fetches the snapshot itself. No key ever
// reaches the TUI process for v2, and no fallback is attempted: the bridge
// answers with the connected account or the notice.
//
// The result is `{ key, source }`: the key for the caller, a display-only
// `UsageCredentialSource` for the panel's `via …` line (Host connection /
// `COMMANDCODE_API_KEY` / a legacy file's label). No path here logs or renders
// the key, and nothing resolves to a guessed account: when nothing answers the
// resolver is `undefined` and callers render a notice and make no request
// (ADR-0011).
import {
  resolveApiKeyWithSource,
  type ApiKeySource,
  type AuthKeyOptions,
} from "../provider/auth-key.js"
import { isRecord } from "../provider/converters.js"
import {
  hostCredentialFromEntry,
  hostCredentialFromV1,
  type V1ProviderListClient,
} from "./host-credential.js"
import type { UsageCredentialSource } from "./usage.js"

/** Provider id both hosts register under — the record this resolver reads. */
const PROVIDER_ID = "commandcode"

/** A TUI-resolved credential: the key to read usage with, and its rung. */
export interface TuiCredential {
  key: string
  source: UsageCredentialSource
}

/** v1 inputs: exactly what `api.state.provider` and `api.client` already hold. */
export interface TuiCredentialV1Input {
  readonly host: "v1"
  /** The provider records the v1 TUI sync store holds (`api.state.provider`). */
  readonly providers: readonly unknown[]
  /** The TUI's own SDK client — the fallback when the state record carries no credential. */
  readonly client?: V1ProviderListClient | undefined
}

/**
 * Injection seams for tests and for callers with their own paths: the package
 * ladder's own options minus `apiKey` — this resolver never takes an explicit
 * key, because the host's rungs come first and a declared TUI credential does
 * not exist.
 */
export type TuiCredentialOptions = Omit<AuthKeyOptions, "apiKey">

/** The `commandcode` entry of a v1 provider list, or undefined when it is absent. */
function v1ProviderEntry(providers: readonly unknown[]): Record<string, unknown> | undefined {
  return providers.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === PROVIDER_ID,
  )
}

/**
 * The v1 host rung: the record the TUI state already holds, then the TUI's own
 * client listing when that record carries neither field at runtime. Either way
 * the credential is the Host's own — the record's `source` cannot stand in for
 * provenance (the final config re-apply stamps `"config"` on every
 * config-declared provider), and the plan summary's env/store distinction
 * (ADR-0015) is not carried: this panel's three display rungs collapse the
 * Host's own resolution into "Host connection".
 *
 * A failing client is the next rung, never an error (ADR-0015 rule 2).
 */
async function v1HostCredential(
  input: TuiCredentialV1Input,
  env: NodeJS.ProcessEnv,
): Promise<TuiCredential | undefined> {
  const entry = v1ProviderEntry(input.providers)
  if (entry) {
    const credential = hostCredentialFromEntry(entry, env)
    if (credential) return { key: credential.key, source: { kind: "host" } }
  }
  if (!input.client) return undefined
  try {
    const credential = await hostCredentialFromV1(input.client, PROVIDER_ID, env)
    return credential ? { key: credential.key, source: { kind: "host" } } : undefined
  } catch {
    return undefined
  }
}

/**
 * The package ladder below the host rung, as display provenance. The `option`
 * arm is unreachable through this resolver — it never hands the ladder an
 * explicit `apiKey` — so it maps to the host rung it would have stood for.
 */
function ladderSource(source: ApiKeySource): UsageCredentialSource {
  switch (source.kind) {
    case "environment":
      return { kind: "environment" }
    case "file":
      return { kind: "file", label: source.label }
    case "option":
      return { kind: "host" }
  }
}

/**
 * The credential the v1 TUI host streams with, or `undefined` when none
 * resolves: the host's own record first, then the package ladder — never a
 * guessed account (ADR-0011). Callers make no request without a key.
 */
export async function resolveTuiCredential(
  input: TuiCredentialV1Input,
  options: TuiCredentialOptions = {},
): Promise<TuiCredential | undefined> {
  const env = options.env ?? process.env
  const host = await v1HostCredential(input, env)
  if (host) return host

  const resolved = resolveApiKeyWithSource({
    env,
    authPaths: options.authPaths,
    homeDir: options.homeDir,
  })
  return resolved ? { key: resolved.key, source: ladderSource(resolved.source) } : undefined
}
