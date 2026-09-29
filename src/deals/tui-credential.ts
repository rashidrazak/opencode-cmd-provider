// src/deals/tui-credential.ts — the credential the TUI host's Deals panel
// reads usage with (issue #243, ADR-0020).
//
// The TUI host is a third process (ADR-0010) with no path to the ADR-0015
// server seam: the v1 TUI holds the provider records its sync store already
// fetched, and the v2 TUI holds the host's client-local integration data. This
// module is that seam's TUI counterpart — one resolver, per-host inputs, one
// ladder below them:
//
//   v1  the state record's own `options.apiKey ?? key`, then the TUI's own
//       `client.provider.list()` when the record carries neither at runtime;
//   v2  the provider's `integrationID` → the client-local integration record →
//       its active connection; only the env branch is reachable, so an active
//       stored credential resolves to undefined — the documented notice path —
//       and the package ladder below applies (ADR-0015 rule 2);
//   both  the package ladder: `COMMANDCODE_API_KEY`, then the legacy auth
//       files, keeping the file label as provenance.
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
import { isRecord, stringValue } from "../provider/converters.js"
import {
  hostCredentialFromEntry,
  hostCredentialFromV1,
  type V1ProviderListClient,
} from "./host-credential.js"
import type { UsageCredentialSource } from "./usage.js"
import type { V2TuiContext } from "../plugin/v2-tui-types.js"

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

/** v2 inputs: exactly what `V2TuiContext["data"]` already holds. */
export interface TuiCredentialV2Input {
  readonly host: "v2"
  /** The host's client-local data store (`ctx.data`). */
  readonly data: V2TuiContext["data"]
}

/** The caller's host inputs, discriminated by the TUI half asking. */
export type TuiCredentialInput = TuiCredentialV1Input | TuiCredentialV2Input

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
 * The v2 host rung: the `commandcode` provider's `integrationID` → the
 * client-local integration record → its active connection. The Host projects
 * `connections` in its own resolution order — stored credentials first, then
 * the env methods whose variable is set — and `connection.active()` is `[0]`,
 * so only the first connection is the one the session streams with. An active
 * credential connection holds a value this process never sees: the rung
 * yields undefined (the documented notice path) even when an env connection
 * sits behind it, and the ladder below then answers with its own provenance.
 */
function v2HostCredential(
  data: V2TuiContext["data"],
  env: NodeJS.ProcessEnv,
): TuiCredential | undefined {
  const provider = data.location.provider.list()?.find((entry) => entry.id === PROVIDER_ID)
  const integrationID = provider?.integrationID
  if (integrationID === undefined) return undefined
  const integration = data.location.integration.list()?.find((entry) => entry.id === integrationID)
  // The mirrored shape is trusted for types only: a host payload that dropped
  // `connections` is the next rung, never a crash (ADR-0020 rule 1).
  const connection = integration?.connections?.[0]
  if (connection?.type !== "env") return undefined
  const key = stringValue(env[connection.name])
  return key ? { key, source: { kind: "host" } } : undefined
}

/**
 * The package ladder below both hosts, as display provenance. The `option` arm
 * is unreachable through this resolver — it never hands the ladder an explicit
 * `apiKey` — so it maps to the host rung it would have stood for.
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
 * The credential the TUI host streams with, or `undefined` when none resolves:
 * the host's own rung first (per host), then the package ladder — never a
 * guessed account (ADR-0011). Callers make no request without a key.
 */
export async function resolveTuiCredential(
  input: TuiCredentialInput,
  options: TuiCredentialOptions = {},
): Promise<TuiCredential | undefined> {
  const env = options.env ?? process.env
  const host =
    input.host === "v1" ? await v1HostCredential(input, env) : v2HostCredential(input.data, env)
  if (host) return host

  const resolved = resolveApiKeyWithSource({
    env,
    authPaths: options.authPaths,
    homeDir: options.homeDir,
  })
  return resolved ? { key: resolved.key, source: ladderSource(resolved.source) } : undefined
}
