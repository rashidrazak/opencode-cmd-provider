// src/plugin/version.ts — the runtime provider specifier (issue #152)
//
// opencode keys its package cache by the exact specifier string and never
// refreshes an install that already exists (verified against 1.18.30; see
// ADR-0009), while the plugin loader appends `@latest` to a bare plugin spec
// and the provider loader uses this value verbatim. Registering the bare
// package name therefore guarantees a second cache entry that is not tied to
// the plugin's version — in either direction. Pinning the provider to our own
// exact version makes the two halves of the package inseparable.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** This package's name — also the marker that identifies our own manifest. */
const PACKAGE_NAME = "opencode-cmd-provider"
/**
 * Levels walked up from the starting module. The built layout
 * (`dist/src/plugin/version.js`) needs three; the cap only bounds the search,
 * it never decides the result.
 */
const MAX_LOOKUP_DEPTH = 6

interface OwnManifest {
  version: string
}

/**
 * The specifier opencode installs for the runtime provider:
 * `<package>@<exact version>` from our own shipped `package.json`.
 *
 * Deliberately total: every failure — no matching manifest within the lookup
 * depth, an unreadable file, invalid JSON, a missing or non-string version —
 * falls back to the bare package name, i.e. the pre-#152 behavior. A degraded
 * registration beats a plugin that will not load: auto-registration,
 * `/connect` and the model list all depend on this module importing cleanly.
 *
 * `startUrl` exists for tests; production always uses the module's own URL.
 */
export function resolveProviderNpm(startUrl: string | URL = import.meta.url): string {
  const manifest = findOwnManifest(startUrl)
  return manifest ? `${PACKAGE_NAME}@${manifest.version}` : PACKAGE_NAME
}

function findOwnManifest(startUrl: string | URL): OwnManifest | null {
  let current = toUrl(startUrl)
  if (!current) return null

  for (let depth = 0; depth < MAX_LOOKUP_DEPTH; depth++) {
    const manifest = readManifest(new URL("package.json", current))
    // Manifests without our name are skipped, never terminal: build tooling can
    // drop its own package.json inside `dist/`, and the walk must still reach
    // ours at the package root. A name match settles the question — a bad
    // version there is a broken install, not a reason to keep looking for
    // another copy of the package higher up.
    if (manifest?.name === PACKAGE_NAME) {
      const version = manifest.version
      return typeof version === "string" && version.length > 0 ? { version } : null
    }
    const parent = new URL("../", current)
    if (parent.href === current.href) return null
    current = parent
  }
  return null
}

function toUrl(startUrl: string | URL): URL | null {
  if (startUrl instanceof URL) return startUrl
  try {
    return new URL(startUrl)
  } catch {
    return null
  }
}

function readManifest(url: URL): { name?: unknown; version?: unknown } | null {
  if (url.protocol !== "file:") return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(url), "utf-8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as { name?: unknown; version?: unknown }
  } catch {
    // Missing file, unreadable file, or invalid JSON: keep walking.
    return null
  }
}
