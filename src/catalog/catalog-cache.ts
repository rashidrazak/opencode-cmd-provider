// src/catalog/catalog-cache.ts — the disk tier of the model list (ADR-0024)
//
// Membership has three tiers, in precedence order:
//
//   1. this cache  — the last catalog a background fetch accepted
//   2. the bundled Snapshot (`snapshot.ts`) — what the release shipped
//   3. nothing     — never: the bundled Snapshot is always present
//
// The cache is what keeps the network off OpenCode's startup path. The host
// awaits the plugin `config` hook before it reads `provider.config`, and
// `commandcode` is not in models.dev so the lazy async `provider.models` hook
// never fires for us — which makes `config` startup-critical by definition. A
// blocking fetch there would stall startup for the whole request timeout
// whenever the endpoint is slow or a captive portal intercepts it, so the read
// is a file read (~1 ms) and the fetch runs behind it for the next start.
//
// Two rules make a stale cache safe:
//   - **Union, never replace.** The cache may add models the bundle lacks; it
//     may never remove one the bundle carries. A cache written before a
//     downgrade therefore cannot hide a model the running package ships.
//   - **Any defect is "no cache".** A missing, unreadable, malformed or
//     wrong-shaped file degrades to the bundled Snapshot with no user-visible
//     error — this file is an accelerator, never a dependency.
//
// The write is atomic (tmp + rename) and copies the auth-mirror's conventions
// (XDG-aware directory, recursive mkdir, mode preservation).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

/** One cached catalog row. Mirrors the Snapshot's ship-bar fields. */
export interface CachedCatalogRow {
  id: string
  name: string
  contextLength: number
  efforts: string[] | null
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
}

export interface CachedCatalog {
  /** The catalog payload's own version string, for diagnostics and diffs. */
  catalogVersion: string
  /** ISO date the fetch that produced this cache resolved. */
  fetchedAt: string
  rows: CachedCatalogRow[]
}

/**
 * The cache directory: `XDG_CACHE_HOME` when set, else `~/.cache`. Mirrors the
 * XDG convention `src/plugin/auth-mirror.ts` uses for the data directory, but
 * under the cache root — this file is regenerable, so it does not belong in
 * persistent data.
 */
function cacheHome(): string {
  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
}

/** The cache file for the `commandcode` provider. */
export function defaultCatalogCachePath(): string {
  return join(cacheHome(), "opencode-cmd-provider", "models.json")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

/** A finite non-negative number, or undefined when the value is not one. */
function finiteRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Validates one cached row. Returns undefined for anything unusable: a cache is
 * an accelerator, so a single bad row drops that row rather than discarding the
 * whole file's value — but a row must never be half-trusted.
 */
function parseRow(value: unknown): CachedCatalogRow | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, contextLength, efforts, cost } = value
  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof name !== "string" || name.length === 0) return undefined
  if (typeof contextLength !== "number" || !Number.isInteger(contextLength) || contextLength <= 0) {
    return undefined
  }
  if (efforts !== null && !isStringArray(efforts)) return undefined
  let parsedCost: CachedCatalogRow["cost"] = null
  if (cost !== null && cost !== undefined) {
    if (!isRecord(cost)) return undefined
    const input = finiteRate(cost.input)
    const output = finiteRate(cost.output)
    const cacheRead = finiteRate(cost.cacheRead)
    const cacheWrite = finiteRate(cost.cacheWrite)
    if (
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined
    ) {
      return undefined
    }
    parsedCost = { input, output, cacheRead, cacheWrite }
  }
  return {
    id,
    name,
    contextLength,
    efforts: efforts === null ? null : efforts,
    cost: parsedCost,
  }
}

/**
 * Parses a cache document. Returns undefined when the document as a whole is
 * unusable (not an object, no rows survive validation); never throws.
 */
export function parseCatalogCache(text: string): CachedCatalog | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (typeof parsed.catalogVersion !== "string") return undefined
  if (typeof parsed.fetchedAt !== "string") return undefined
  if (!Array.isArray(parsed.rows)) return undefined
  const rows: CachedCatalogRow[] = []
  const seen = new Set<string>()
  for (const entry of parsed.rows) {
    const row = parseRow(entry)
    if (row === undefined || seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  if (rows.length === 0) return undefined
  return { catalogVersion: parsed.catalogVersion, fetchedAt: parsed.fetchedAt, rows }
}

/**
 * Reads the cache. Any failure — absent file, unreadable file, malformed JSON,
 * unusable shape — is `undefined`: the caller falls back to the bundled
 * Snapshot. Never throws, never logs (a first run has no cache by definition,
 * and that is not a warning).
 */
export function readCatalogCache(path: string = defaultCatalogCachePath()): CachedCatalog | undefined {
  try {
    return parseCatalogCache(readFileSync(path, "utf-8"))
  } catch {
    return undefined
  }
}

/**
 * Writes the cache atomically. Returns false when the write could not happen
 * (read-only home, full disk, a permissions surprise): the cache is an
 * accelerator, so a failed write must never surface as a plugin failure.
 */
export function writeCatalogCache(
  catalog: CachedCatalog,
  path: string = defaultCatalogCachePath(),
): boolean {  try {
    const dir = join(path, "..")
    mkdirSync(dir, { recursive: true })
    const existingMode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
    const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`)
    writeFileSync(tmp, `${JSON.stringify(catalog, null, 2)}\n`, { mode: existingMode })
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * Merges cached rows over the bundled Snapshot, returning the rows to
 * register.
 *
 * Union semantics: every bundled row ships, and a cached row is added only when
 * the bundle does not already carry that id — except that a cached row for an
 * id the bundle DOES carry wins on its own fields, because the cache is newer.
 * The id set is therefore `bundled ∪ cached`, never `cached` alone, so a stale
 * cache can never hide a model the running package ships.
 *
 * `bundled` rows are the generated `CatalogModel`s; only the ship-bar fields
 * are read, so this stays free of a Snapshot import (the caller passes them).
 */
export function mergeCachedCatalog<T extends { id: string }>(
  bundled: readonly T[],
  cached: CachedCatalog | undefined,
  toRow: (row: CachedCatalogRow) => T,
): readonly T[] {
  if (cached === undefined || cached.rows.length === 0) return bundled
  const byId = new Map(bundled.map((row) => [row.id, row]))
  for (const cachedRow of cached.rows) {
    byId.set(cachedRow.id, toRow(cachedRow))
  }
  // Preserve the bundle's order for known ids and append the cache-only ones,
  // so an unchanged catalog produces a byte-identical picker order.
  const merged: T[] = bundled.map((row) => byId.get(row.id) ?? row)
  for (const cachedRow of cached.rows) {
    if (!bundled.some((row) => row.id === cachedRow.id)) merged.push(toRow(cachedRow))
  }
  return merged
}
