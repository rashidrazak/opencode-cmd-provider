// tests/catalog-sync.test.ts — the background catalog fetch (ADR-0024)
//
// This is the network half of the membership design, and its contract is
// narrow on purpose: it runs *behind* startup, it never rejects, and every
// failure mode leaves the previous cache (or the bundle) in place. Nothing here
// may ever surface as a plugin error or empty the model picker.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readCatalogCache, type CachedCatalog } from "../src/catalog/catalog-cache.js"
import {
  DISABLE_SYNC_ENV,
  catalogPayloadToCache,
  refreshCatalogCache,
  startCatalogSync,
} from "../src/plugin/catalog-sync.js"
import { assert, assertEqual, run } from "./harness.js"

const NOW = new Date("2026-10-27T12:00:00.000Z")

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-sync-"))
  return { dir, path: join(dir, "models.json") }
}

/** A catalog payload with one selectable record and one hidden record. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    catalogVersion: "test-catalog",
    data: [
      {
        id: "vendor/model",
        name: "Vendor Model",
        context_length: 1_000_000,
        reasoningEfforts: ["off", "low", "high"],
        inputModalities: ["text", "image"],
        pricing: { inputCost: 2, outputCost: 10, cacheReadCost: 0.2 },
      },
      { id: "vendor/hidden", name: "Hidden", context_length: 1000, hidden: true },
    ],
    ...overrides,
  }
}

/** A fetch stub returning the given payload. */
function fetchReturning(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = []
  const impl = (async (url: string) => {
    calls.push(String(url))
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }
  }) as unknown as typeof fetch
  return { impl, calls }
}

run([
  [
    "a successful fetch writes a cache for the next start",
    async () => {
      const { dir, path } = tempPath()
      try {
        const { impl, calls } = fetchReturning(payload())
        const wrote = await refreshCatalogCache({
          catalogURL: "http://mock/provider/v1/models?view=client",
          cachePath: path,
          fetch: impl,
          now: () => NOW,
        })
        assertEqual(wrote, true)
        assertEqual(calls.length, 1)
        const cache = readCatalogCache(path)
        assert(cache, "the cache must be readable")
        assertEqual(cache.catalogVersion, "test-catalog")
        assertEqual(cache.fetchedAt, NOW.toISOString())
        // Hidden records are not offered, so they never enter the cache.
        assertEqual(
          cache.rows.map((row) => row.id),
          ["vendor/model"],
        )
        assertEqual(cache.rows[0].contextLength, 1_000_000)
        assertEqual(cache.rows[0].cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 })
        // ADR-0019: "off" never becomes an advertised effort, even via the
        // live path (the refresh normalizes it; so must this).
        assertEqual(cache.rows[0].efforts, ["low", "high"])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a hidden record is skipped, not treated as a defect",
    () => {
      const cache = catalogPayloadToCache(payload(), NOW)
      assert(cache)
      assertEqual(
        cache.rows.map((row) => row.id),
        ["vendor/model"],
      )
    },
  ],

  [
    "an absent cacheWriteCost is an explicit zero (not a missing rate)",
    () => {
      const cache = catalogPayloadToCache(payload(), NOW)
      assert(cache)
      assertEqual(cache.rows[0].cost?.cacheWrite, 0)
    },
  ],

  [
    "a non-OK response leaves the previous cache untouched and resolves false",
    async () => {
      const { dir, path } = tempPath()
      try {
        // Seed a good cache, then fail the fetch.
        await refreshCatalogCache({
          catalogURL: "http://mock/catalog",
          cachePath: path,
          fetch: fetchReturning(payload()).impl,
          now: () => NOW,
        })
        const before = readCatalogCache(path)
        const wrote = await refreshCatalogCache({
          catalogURL: "http://mock/catalog",
          cachePath: path,
          fetch: fetchReturning({}, { ok: false, status: 500 }).impl,
        })
        assertEqual(wrote, false)
        assertEqual(
          readCatalogCache(path),
          before,
          "the previous cache must survive a failed fetch",
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a network error resolves false and never throws",
    async () => {
      const { dir, path } = tempPath()
      try {
        const impl = (async () => {
          throw new Error("ECONNREFUSED")
        }) as unknown as typeof fetch
        const wrote = await refreshCatalogCache({
          catalogURL: "http://mock/catalog",
          cachePath: path,
          fetch: impl,
        })
        assertEqual(wrote, false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "an unusable payload never overwrites a good cache",
    async () => {
      const { dir, path } = tempPath()
      try {
        await refreshCatalogCache({
          catalogURL: "http://mock/catalog",
          cachePath: path,
          fetch: fetchReturning(payload()).impl,
          now: () => NOW,
        })
        const before = readCatalogCache(path)
        for (const body of [
          { data: [] }, // no catalogVersion
          { catalogVersion: "v" }, // no data
          { catalogVersion: "v", data: [] }, // no selectable rows
          { catalogVersion: "v", data: [{ id: "x" }] }, // unusable record
        ]) {
          const wrote = await refreshCatalogCache({
            catalogURL: "http://mock/catalog",
            cachePath: path,
            fetch: fetchReturning(body).impl,
          })
          assertEqual(wrote, false, `an unusable payload must not write: ${JSON.stringify(body)}`)
        }
        assertEqual(readCatalogCache(path), before, "the good cache must survive unusable payloads")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    `the ${DISABLE_SYNC_ENV} escape hatch skips the fetch entirely`,
    async () => {
      const { dir, path } = tempPath()
      try {
        const { impl, calls } = fetchReturning(payload())
        const wrote = await refreshCatalogCache({
          catalogURL: "http://mock/catalog",
          cachePath: path,
          fetch: impl,
          env: { [DISABLE_SYNC_ENV]: "1" },
        })
        assertEqual(wrote, false)
        assertEqual(calls, [], "no request may be made when sync is disabled")
        assertEqual(readCatalogCache(path), undefined)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "startCatalogSync never rejects, even when the fetch throws",
    async () => {
      const { dir, path } = tempPath()
      try {
        const impl = (async () => {
          throw new Error("boom")
        }) as unknown as typeof fetch
        // Must resolve, not reject: the entry point fires this without awaiting.
        assertEqual(
          await startCatalogSync({
            catalogURL: "http://mock/catalog",
            cachePath: path,
            fetch: impl,
          }),
          false,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "the request targets the public catalog by default",
    async () => {
      const { dir, path } = tempPath()
      try {
        const { impl, calls } = fetchReturning(payload())
        await refreshCatalogCache({ cachePath: path, fetch: impl, env: {} })
        assertEqual(calls, ["https://api.commandcode.ai/provider/v1/models?view=client"])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "COMMANDCODE_API_BASE does NOT redirect the catalog (it is the transport base)",
    async () => {
      // Regression: the sync originally derived its URL from COMMANDCODE_API_BASE,
      // so any session pointed at a mock/compatible proxy (no ?view=client there)
      // silently disabled the refresh — every fetch 404'd in ~1 ms and the cache
      // never populated. The two concerns must stay separate.
      const { dir, path } = tempPath()
      try {
        const { impl, calls } = fetchReturning(payload())
        await refreshCatalogCache({
          cachePath: path,
          fetch: impl,
          env: { COMMANDCODE_API_BASE: "http://127.0.0.1:9" },
        })
        assertEqual(calls, ["https://api.commandcode.ai/provider/v1/models?view=client"])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "COMMANDCODE_CATALOG_URL overrides the catalog endpoint explicitly",
    async () => {
      const { dir, path } = tempPath()
      try {
        const { impl, calls } = fetchReturning(payload())
        await refreshCatalogCache({
          cachePath: path,
          fetch: impl,
          env: { COMMANDCODE_CATALOG_URL: "https://proxy.test/catalog" },
        })
        assertEqual(calls, ["https://proxy.test/catalog"])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "an explicit baseURL still targets that base's client view",
    async () => {
      const { dir, path } = tempPath()
      try {
        const { impl, calls } = fetchReturning(payload())
        await refreshCatalogCache({
          baseURL: "https://example.test",
          cachePath: path,
          fetch: impl,
          env: {},
        })
        assertEqual(calls, ["https://example.test/provider/v1/models?view=client"])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a record with no usable context is skipped rather than registered unpriceable",
    () => {
      const cache = catalogPayloadToCache(
        {
          catalogVersion: "v",
          data: [
            { id: "vendor/good", name: "Good", context_length: 1000 },
            { id: "vendor/no-context", name: "No Context" },
            { id: "vendor/bad-context", name: "Bad Context", context_length: 0 },
          ],
        },
        NOW,
      )
      assert(cache)
      assertEqual(
        cache.rows.map((row) => row.id),
        ["vendor/good"],
      )
    },
  ],

  [
    "the cache document carries its provenance for diagnostics",
    () => {
      const cache: CachedCatalog | undefined = catalogPayloadToCache(payload(), NOW)
      assert(cache)
      assertEqual(cache.catalogVersion, "test-catalog")
      assertEqual(cache.fetchedAt, "2026-10-27T12:00:00.000Z")
    },
  ],
])
