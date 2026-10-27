// tests/helpers/catalog-sync-stub.ts — keeps the background catalog fetch
// (ADR-0024) inside the test process.
//
// Both plugin startup hooks (v1 `config`, v2 `setup`) fire `startCatalogSync()`,
// which fetches the public catalog and writes the XDG cache. A test that drives
// either hook would otherwise reach the network and overwrite the developer's
// real `~/.cache/opencode-cmd-provider/models.json` — and read it back on the
// next run. Installing this stub first points the cache at a temp directory and
// answers the catalog URL in-process, so the hook tests stay hermetic and can
// assert the sync actually started.
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultCatalogCachePath } from "../../src/catalog/catalog-cache.js"

/** The one row the stubbed catalog serves; its id appears in no Snapshot. */
export const STUB_CATALOG_MODEL_ID = "stub/catalog-sync-probe"

export interface CatalogSyncStub {
  /** Catalog URLs fetched since install (or the last `reset`). */
  calls: string[]
  /** The temp cache file both hooks now write. */
  cachePath: string
  /**
   * Whether the stubbed catalog answers. Off by default: the fetch is still
   * recorded but gets a 503, so the sync writes nothing and an unrelated test
   * keeps seeing exactly the bundled Snapshot. A test that wants a cache sets it.
   */
  serving: boolean
  /** Forgets recorded calls, removes the cache file, and stops serving. */
  reset(): void
  /** Resolves once a catalog fetch has been seen and the cache file exists. */
  settled(timeoutMs?: number): Promise<boolean>
}

/**
 * Isolates the catalog cache and stubs the catalog fetch for the rest of the
 * process. Any other request falls through to the real `fetch`, so mock
 * servers elsewhere in a test file keep working.
 */
export function installCatalogSyncStub(): CatalogSyncStub {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cc-sync-hooks-"))
  delete process.env.COMMANDCODE_DISABLE_CATALOG_SYNC
  delete process.env.COMMANDCODE_CATALOG_URL
  const cachePath = defaultCatalogCachePath()
  const calls: string[] = []
  const stub = { serving: false }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes("/provider/v1/models?view=client")) return realFetch(input, init)
    calls.push(url)
    if (!stub.serving) return new Response("", { status: 503 })
    return new Response(
      JSON.stringify({
        catalogVersion: "stub-catalog",
        data: [
          {
            id: STUB_CATALOG_MODEL_ID,
            name: "Catalog Sync Probe",
            context_length: 128_000,
            pricing: { inputCost: 1, outputCost: 2, cacheReadCost: 0.1 },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  return {
    calls,
    cachePath,
    get serving() {
      return stub.serving
    },
    set serving(value: boolean) {
      stub.serving = value
    },
    reset() {
      calls.splice(0)
      rmSync(cachePath, { force: true })
      stub.serving = false
    },
    async settled(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (calls.length > 0 && existsSync(cachePath)) return true
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return false
    },
  }
}
