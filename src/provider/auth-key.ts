// src/provider/auth-key.ts — API-key resolution (PLAN #2 Part A)
//
// Port of pi-commandcode-provider `getApiKey` with an `options.apiKey`
// precedent added (DESIGN §6.2). Precedence:
//   1. options.apiKey — set by opencode from /connect credentials or config
//   2. COMMANDCODE_API_KEY environment variable
//   3. Legacy auth files: ~/.commandcode/auth.json, ~/.omp/agent/auth.json,
//      ~/.pi/agent/auth.json (all three record shapes, malformed files skipped)
// Returns undefined when no key is found (callers emit the AI SDK error).
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isRecord, stringValue } from "./converters.js"

function defaultAuthPaths(home: string): string[] {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
  ]
}

function apiKeyFromCredentialRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const type = stringValue(value.type)
  if (type === "api") return stringValue(value.key)
  if (type === "oauth") return stringValue(value.access)
  return stringValue(value.key) ?? stringValue(value.access)
}

export interface AuthKeyOptions {
  apiKey?: string
  env?: NodeJS.ProcessEnv
  authPaths?: readonly string[]
  homeDir?: () => string
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
 * the Deals tool as an async getter (ADR-0015): a v2 Host keeps its credential
 * in its own store and injects it into the provider SDK only, and a v1 Host
 * exposes its resolved credential through the plugin's SDK client.
 */
export interface HostCredential {
  key: string
  source: HostCredentialSource
}

export function resolveApiKey(options: AuthKeyOptions = {}): string | undefined {
  if (options.apiKey) return options.apiKey
  const env = options.env ?? process.env
  if (env.COMMANDCODE_API_KEY) return env.COMMANDCODE_API_KEY

  const home = options.homeDir?.() ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home)

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!isRecord(parsed)) continue

      // Legacy: direct apiKey or commandcode field.
      const apiKey = stringValue(parsed.apiKey)
      if (apiKey) return apiKey
      const commandcode = stringValue(parsed.commandcode)
      if (commandcode) return commandcode

      // pi stores OAuth credentials as {"commandcode": {"type":"oauth","access":"..."}}.
      // The official Command Code CLI stores API credentials under "command-code".
      const providerKey =
        apiKeyFromCredentialRecord(parsed.commandcode) ??
        apiKeyFromCredentialRecord(parsed["command-code"])
      if (providerKey) return providerKey
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }

  return undefined
}
