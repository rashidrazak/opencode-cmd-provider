// tests/catalog-cache.test.ts — the catalog disk tier (ADR-0024)
//
// The cache is what keeps the network off OpenCode's startup path: the host
// awaits the plugin `config` hook before it reads `provider.config`, so a
// blocking fetch there is a startup stall. The read is a file read; the fetch
// runs behind it for the next start.
//
// The two properties that make a stale cache safe are pinned here:
//   1. union semantics — the cache may add models, never remove a bundled one;
//   2. any defect degrades to the bundle, silently (it is an accelerator).
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mergeCachedCatalog,
  parseCatalogCache,
  readCatalogCache,
  writeCatalogCache,
  type CachedCatalog,
  type CachedCatalogRow,
} from "../src/catalog/catalog-cache.js"
import { assert, assertEqual, run } from "./harness.js"

const ROW: CachedCatalogRow = {
  id: "vendor/model",
  name: "Vendor Model",
  contextLength: 1_000_000,
  efforts: ["low", "high"],
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
}

const CATALOG: CachedCatalog = {
  catalogVersion: "test-catalog",
  fetchedAt: "2026-10-27T00:00:00.000Z",
  rows: [ROW],
}

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-cache-"))
  return { dir, path: join(dir, "models.json") }
}

run([
  [
    "a written cache reads back identically",
    () => {
      const { dir, path } = tempPath()
      try {
        assertEqual(writeCatalogCache(CATALOG, path), true, "write must succeed")
        assertEqual(readCatalogCache(path), CATALOG)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a missing cache file is undefined, never a throw",
    () => {
      const { dir, path } = tempPath()
      try {
        assertEqual(readCatalogCache(path), undefined)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "unreadable or malformed cache content degrades to undefined",
    () => {
      const { dir, path } = tempPath()
      try {
        writeFileSync(path, "not json at all")
        assertEqual(readCatalogCache(path), undefined, "malformed JSON must not throw")
        writeFileSync(path, JSON.stringify({ catalogVersion: "v" }))
        assertEqual(readCatalogCache(path), undefined, "missing rows must not throw")
        writeFileSync(path, JSON.stringify({ catalogVersion: "v", fetchedAt: "d", rows: [] }))
        assertEqual(readCatalogCache(path), undefined, "an empty cache is no cache")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a row missing a ship-bar field is dropped, the rest of the cache survives",
    () => {
      const parsed = parseCatalogCache(
        JSON.stringify({
          catalogVersion: "v",
          fetchedAt: "d",
          rows: [
            ROW,
            { ...ROW, id: "vendor/no-context", contextLength: null },
            { ...ROW, id: "vendor/no-name", name: "" },
            { ...ROW, id: "vendor/bad-cost", cost: { input: "nope" } },
          ],
        }),
      )
      assert(parsed, "the cache must still parse")
      assertEqual(
        parsed.rows.map((row) => row.id),
        ["vendor/model"],
      )
    },
  ],

  [
    "duplicate ids in a cache keep the first row only",
    () => {
      const parsed = parseCatalogCache(
        JSON.stringify({
          catalogVersion: "v",
          fetchedAt: "d",
          rows: [ROW, { ...ROW, name: "Second" }],
        }),
      )
      assert(parsed)
      assertEqual(parsed.rows.length, 1)
      assertEqual(parsed.rows[0].name, "Vendor Model")
    },
  ],

  [
    "a failed write returns false instead of throwing (read-only home)",
    () => {
      // A path whose parent is a regular file cannot be created.
      const { dir, path } = tempPath()
      try {
        writeFileSync(path, "blocker")
        const impossible = join(path, "nested", "models.json")
        assertEqual(writeCatalogCache(CATALOG, impossible), false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "merge adds a cache-only model and keeps every bundled model",
    () => {
      const bundled = [{ id: "vendor/bundled" }]
      const merged = mergeCachedCatalog(bundled, CATALOG, (row) => ({ id: row.id }))
      assertEqual(
        merged.map((row) => row.id),
        ["vendor/bundled", "vendor/model"],
        "the bundle's ids must all survive and the cache-only id must be appended",
      )
    },
  ],

  [
    "merge never removes a bundled model the cache omits (a stale cache cannot hide one)",
    () => {
      // The central safety property: a cache written before a package upgrade
      // must not shrink what this build ships.
      const bundled = [{ id: "vendor/bundled" }, { id: "vendor/new-in-this-release" }]
      const merged = mergeCachedCatalog(bundled, CATALOG, (row) => ({ id: row.id }))
      assertEqual(
        merged.map((row) => row.id),
        ["vendor/bundled", "vendor/new-in-this-release", "vendor/model"],
      )
    },
  ],

  [
    "a cached row for a bundled id wins on its fields (the cache is newer)",
    () => {
      const bundled = [{ id: "vendor/model", name: "Old Name" }]
      const merged = mergeCachedCatalog(bundled, CATALOG, (row) => ({ id: row.id, name: row.name }))
      assertEqual(merged.length, 1, "no duplicate row for the same id")
      assertEqual(merged[0].name, "Vendor Model")
    },
  ],

  [
    "no cache means the bundle is returned untouched (identity, not a copy)",
    () => {
      const bundled = [{ id: "vendor/bundled" }]
      assertEqual(
        mergeCachedCatalog(bundled, undefined, (row) => ({ id: row.id })),
        bundled,
      )
      assertEqual(
        mergeCachedCatalog(bundled, { catalogVersion: "v", fetchedAt: "d", rows: [] }, (row) => ({
          id: row.id,
        })),
        bundled,
      )
    },
  ],

  [
    "bundle order is preserved so an unchanged catalog keeps a stable picker order",
    () => {
      const bundled = [{ id: "vendor/a" }, { id: "vendor/b" }, { id: "vendor/c" }]
      const merged = mergeCachedCatalog(
        bundled,
        { catalogVersion: "v", fetchedAt: "d", rows: [{ ...ROW, id: "vendor/b" }] },
        (row) => ({ id: row.id }),
      )
      assertEqual(
        merged.map((row) => row.id),
        ["vendor/a", "vendor/b", "vendor/c"],
      )
    },
  ],

  [
    "the cache file is created with the recursive parent directories",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "cc-cache-deep-"))
      const path = join(dir, "a", "b", "c", "models.json")
      try {
        assertEqual(writeCatalogCache(CATALOG, path), true)
        assertEqual(readCatalogCache(path), CATALOG)
        mkdirSync(join(dir, "a"), { recursive: true }) // sanity: tree exists
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "the cache is written atomically (no temp file is left behind)",
    () => {
      const { dir, path } = tempPath()
      try {
        writeCatalogCache(CATALOG, path)
        writeCatalogCache({ ...CATALOG, catalogVersion: "second" }, path)
        assertEqual(JSON.parse(readFileSync(path, "utf-8")).catalogVersion, "second")
        const leftovers = readDirSafe(dir).filter((name) => name.endsWith(".tmp"))
        assertEqual(leftovers, [], "no temp files may remain after a rename")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],
])

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
