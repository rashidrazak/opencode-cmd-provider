// src/plugin/catalog-sync.ts — the background catalog fetch (ADR-0024)
//
// This is the only place the plugin talks to the model-catalog endpoint, and it
// runs *behind* startup rather than on it:
//
//   config hook → read cache (fast) → register models → return
//                                          └─▶ refreshCatalogCache() (unawaited)
//
// The result is cached for the NEXT start. That is the whole point: the host
// awaits the `config` hook before it reads `provider.config`, and `commandcode`
// is not in models.dev (so the lazy `provider.models` hook never fires), which
// makes a blocking fetch here a startup stall for the length of the request
// timeout. The bundled Snapshot is always the floor, so a slow, broken or
// blocked endpoint costs freshness and nothing else.
//
// Every failure is swallowed on purpose. This is an accelerator: a captive
// portal, a 500, an unparseable body, a read-only home — none of them may
// surface as a plugin error or affect the models a user gets this session.
import {
  writeCatalogCache,
  type CachedCatalog,
  type CachedCatalogRow,
} from "../catalog/catalog-cache.js"

/** The catalog client view: the same resource the Command Code CLI resolves. */
const CATALOG_PATH = "/provider/v1/models?view=client"

/**
 * The catalog endpoint is deliberately **not** derived from
 * `COMMANDCODE_API_BASE`. That variable points the *transport* at a mock or a
 * compatible proxy during tests; the membership catalog is a different concern,
 * and reusing it meant a test-shaped base URL silently disabled the refresh for
 * the whole session (no mock serves `?view=client`, so every fetch 404'd in
 * ~1 ms and the cache never populated).
 *
 * `COMMANDCODE_CATALOG_URL` overrides it explicitly when a test or a proxy
 * really does serve a catalog.
 */
const DEFAULT_CATALOG_URL = "https://api.commandcode.ai/provider/v1/models?view=client"

/**
 * How long the background fetch may take before it is abandoned. Deliberately
 * short: nothing waits on it, so a hung request should free its socket rather
 * than linger for the whole session.
 */
const BACKGROUND_TIMEOUT_MS = 10_000

/**
 * Escape hatch, mirroring the CLI's own `CMD_DISABLE_REMOTE_MODEL_CATALOG`:
 * `1` disables the background fetch entirely, so a locked-down or air-gapped
 * machine behaves exactly as it did before ADR-0024.
 */
export const DISABLE_SYNC_ENV = "COMMANDCODE_DISABLE_CATALOG_SYNC"

export interface CatalogSyncOptions {
  /** API base override; defaults to `COMMANDCODE_API_BASE` or the public host. */
  baseURL?: string
  /** Override the catalog URL outright (tests point at the mock). */
  catalogURL?: string
  /** Cache destination; defaults to the XDG cache path. */
  cachePath?: string
  /** Injected for tests. */
  fetch?: typeof fetch
  /** Injected for tests. */
  now?: () => Date
  /** Env override, so a test does not have to mutate `process.env`. */
  env?: NodeJS.ProcessEnv
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function finiteRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The thinking-ladder `off` is never an advertised effort (ADR-0019: it means
 * "send nothing"), so it is dropped here exactly as the refresh drops it. A
 * fetch that skipped this would put `off` into the variant cycle at runtime —
 * the one place the refresh's normalization could be bypassed.
 */
const NON_VOCABULARY_EFFORTS = new Set(["off"])

/**
 * One catalog record → a cache row, or undefined when the record is unusable.
 * A `hidden` record is returned as null so the caller can count it as "not
 * offered" rather than as a defect.
 */
function toCachedRow(record: unknown): CachedCatalogRow | null | undefined {
  if (!isRecord(record)) return undefined
  if (record.hidden === true) return null
  const { id, name, context_length: contextLength } = record
  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof name !== "string" || name.length === 0) return undefined
  // A record without a usable context cannot be registered: OpenCode requires a
  // numeric limit, and guessing one would be worse than skipping the row (the
  // bundled Snapshot already has a correct value for every model it ships).
  if (typeof contextLength !== "number" || !Number.isInteger(contextLength) || contextLength <= 0) {
    return undefined
  }
  const efforts = isStringArray(record.reasoningEfforts)
    ? record.reasoningEfforts.filter((level) => !NON_VOCABULARY_EFFORTS.has(level))
    : null
  let cost: CachedCatalogRow["cost"] = null
  if (isRecord(record.pricing)) {
    const input = finiteRate(record.pricing.inputCost)
    const output = finiteRate(record.pricing.outputCost)
    const cacheRead = finiteRate(record.pricing.cacheReadCost)
    const cacheWrite = finiteRate(record.pricing.cacheWriteCost) ?? 0
    if (input !== undefined && output !== undefined && cacheRead !== undefined) {
      cost = { input, output, cacheRead, cacheWrite }
    }
  }
  return {
    id,
    name,
    contextLength,
    efforts: efforts !== null && efforts.length > 0 ? efforts : null,
    cost,
  }
}

/**
 * Converts a catalog payload into a cache document. Returns undefined when the
 * payload is not a usable catalog at all (no version, no data array, no
 * selectable rows) — the caller then leaves the previous cache in place rather
 * than overwriting it with nothing.
 */
export function catalogPayloadToCache(payload: unknown, now: Date): CachedCatalog | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.catalogVersion !== "string" || payload.catalogVersion.length === 0) {
    return undefined
  }
  if (!Array.isArray(payload.data)) return undefined
  const rows: CachedCatalogRow[] = []
  const seen = new Set<string>()
  for (const record of payload.data) {
    const row = toCachedRow(record)
    if (row === undefined || row === null) continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  if (rows.length === 0) return undefined
  return {
    catalogVersion: payload.catalogVersion,
    fetchedAt: now.toISOString(),
    rows,
  }
}

/**
 * Fetches the catalog and writes it to the cache for the next start. Resolves
 * to true when a cache was written.
 *
 * Never rejects: every failure mode (disabled, network error, non-OK, bad JSON,
 * unusable payload, failed write) resolves to false.
 */
export async function refreshCatalogCache(options: CatalogSyncOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env
  if (env[DISABLE_SYNC_ENV] === "1") return false
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== "function") return false
  const url =
    options.catalogURL ??
    env.COMMANDCODE_CATALOG_URL ??
    (options.baseURL === undefined ? DEFAULT_CATALOG_URL : `${options.baseURL}${CATALOG_PATH}`)
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(BACKGROUND_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const cache = catalogPayloadToCache(
      await response.json(),
      (options.now ?? (() => new Date()))(),
    )
    if (cache === undefined) return false
    return writeCatalogCache(cache, options.cachePath)
  } catch {
    return false
  }
}

/**
 * Starts the background refresh without awaiting it. The returned promise never
 * rejects, so a host that ignores it (or a runtime that reports unhandled
 * rejections) is unaffected.
 */
export function startCatalogSync(options: CatalogSyncOptions = {}): Promise<boolean> {
  return refreshCatalogCache(options).catch(() => false)
}
