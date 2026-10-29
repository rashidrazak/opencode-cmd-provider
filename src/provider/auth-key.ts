// src/provider/auth-key.ts — API-key resolution (PLAN #2 Part A)
//
// Port of pi-commandcode-provider `getApiKey` with an `options.apiKey`
// precedent added (DESIGN §6.2). Precedence:
//   1. options.apiKey — set by opencode from /connect credentials or config
//   2. COMMANDCODE_API_KEY environment variable
//   3. Legacy auth files: ~/.commandcode/auth.json, ~/.omp/agent/auth.json,
//      ~/.pi/agent/auth.json (all three record shapes, malformed files skipped)
// Returns undefined when no key is found (callers emit the AI SDK error).
//
// `resolveApiKeyWithSource` is the same ladder returning the rung it resolved,
// for callers that render provenance (issue #205); `resolveApiKey` is its
// key-only face, so the transport path keeps its signature.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, sep } from "node:path"
import { isRecord, stringValue } from "./converters.js"

function defaultAuthPaths(home: string): string[] {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
  ]
}

/**
 * A file path as a display label: `~` for the home directory the default auth
 * files live under, the raw path otherwise. The label names the store, never
 * the account whose key sits in it.
 */
function authPathLabel(authPath: string, home: string): string {
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`
  return authPath.startsWith(prefix) ? `~${sep}${authPath.slice(prefix.length)}` : authPath
}

function apiKeyFromCredentialRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const type = stringValue(value.type)
  if (type === "api") return stringValue(value.key)
  if (type === "oauth") return stringValue(value.access)
  return stringValue(value.key) ?? stringValue(value.access)
}

/** The key an auth file's record carries, in any of the three legacy shapes. */
function apiKeyFromAuthRecord(parsed: Record<string, unknown>): string | undefined {
  // Legacy: direct apiKey or commandcode field.
  const apiKey = stringValue(parsed.apiKey)
  if (apiKey) return apiKey
  const commandcode = stringValue(parsed.commandcode)
  if (commandcode) return commandcode

  // pi stores OAuth credentials as {"commandcode": {"type":"oauth","access":"..."}}.
  // The official Command Code CLI stores API credentials under "command-code".
  return (
    apiKeyFromCredentialRecord(parsed.commandcode) ??
    apiKeyFromCredentialRecord(parsed["command-code"])
  )
}

export interface AuthKeyOptions {
  apiKey?: string
  env?: NodeJS.ProcessEnv
  authPaths?: readonly string[]
  homeDir?: () => string
}

/** This package's API-key variable. */
export const API_KEY_ENV = "COMMANDCODE_API_KEY"

/**
 * The official Command Code CLI's own variable (`command-code` 0.26.12+). This
 * package deliberately does not read it: two supported names with different
 * values would need an arbitrary precedence rule, and the host resolves the
 * environment before the plugin sees it. It is named in the missing-key message
 * instead, so a user who followed the CLI docs learns which name to use.
 */
export const OFFICIAL_CLI_API_KEY_ENV = "COMMAND_CODE_API_KEY"

/**
 * The official variable when it is set but cannot be used: our own variable is
 * absent (if it were set, a key would have resolved) and the official one
 * carries a value. Returns `undefined` when there is nothing to warn about.
 */
export function ignoredOfficialApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[API_KEY_ENV]) return undefined
  return env[OFFICIAL_CLI_API_KEY_ENV] ? OFFICIAL_CLI_API_KEY_ENV : undefined
}

/**
 * The no-credential error every transport path emits. The hint fires only when
 * nothing resolved, so it never changes which key is sent — it just names the
 * near-miss that would otherwise look like a working setup (#326).
 */
export function missingApiKeyMessage(env: NodeJS.ProcessEnv = process.env): string {
  const base = `No Command Code API key. Run /connect and select Command Code, set the ${API_KEY_ENV} env var, or configure an auth file.`
  const ignored = ignoredOfficialApiKeyEnv(env)
  return ignored === undefined
    ? base
    : `${base} (${ignored} is set, but this plugin reads ${API_KEY_ENV}.)`
}

/**
 * Where a Host got the credential it resolved for the provider. Provenance for
 * display only — never a key. `"host"` means the Host's own store (a v2
 * connection, or v1's `provider.key`, which is a store or env credential the
 * v1 payload does not distinguish); `"environment"` a named env var the Host
 * read itself; `"config"` a credential declared in the user's config.
 */
export type HostCredentialSource = "host" | "environment" | "config"

/**
 * A credential a Host resolved for the provider, as opposed to one this package
 * read from the environment or a legacy auth file. Both Host halves hand it to
 * the `cmd_plan_summary` tool as an async getter (ADR-0015): a v2 Host keeps its credential
 * in its own store and injects it into the provider SDK only, and a v1 Host
 * exposes its resolved credential through the plugin's SDK client.
 */
export interface HostCredential {
  key: string
  source: HostCredentialSource
}

/**
 * The rung of this module's own ladder that produced a key — the counterpart of
 * `HostCredentialSource` for a credential the package resolved itself. Display
 * provenance only: never a key, and a file rung carries the store's label
 * rather than anything read out of it.
 */
export type ApiKeySource =
  { kind: "option" } | { kind: "environment" } | { kind: "file"; label: string }

/** A key and the rung that produced it. */
export interface ResolvedApiKey {
  key: string
  source: ApiKeySource
}

/**
 * The ladder above, returning where the key came from. Callers that only need
 * the key call `resolveApiKey`; callers that render provenance (the plan
 * summary, issue #205) need the rung, because "a legacy file of another
 * account answered this" is exactly the fact that was invisible.
 */
export function resolveApiKeyWithSource(options: AuthKeyOptions = {}): ResolvedApiKey | undefined {
  if (options.apiKey) return { key: options.apiKey, source: { kind: "option" } }
  const env = options.env ?? process.env
  if (env[API_KEY_ENV]) {
    return { key: env[API_KEY_ENV], source: { kind: "environment" } }
  }

  const home = options.homeDir?.() ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home)

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!isRecord(parsed)) continue

      const key = apiKeyFromAuthRecord(parsed)
      if (key) return { key, source: { kind: "file", label: authPathLabel(authPath, home) } }
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }

  return undefined
}

export function resolveApiKey(options: AuthKeyOptions = {}): string | undefined {
  return resolveApiKeyWithSource(options)?.key
}
