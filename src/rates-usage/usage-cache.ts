// src/rates-usage/usage-cache.ts — the sidebar usage segment's last-good snapshot
// cache (issue #251). The panel component is remounted by the host — a session
// switch, a model switch, and, in the plugin's own dev loop, every hot reload
// of the TUI module — and a fresh panel has no state, so the segment used to
// blank until a new billing chain settled (~15 s against the live API). This
// module keeps the last published state in TUI-process memory, keyed by
// session, so a remount renders it from the first frame and the mount chain
// refreshes over it.
//
// In-memory only, deliberately: the snapshot is display data resolved from
// whichever credential the session streams with, so a disk cache would outlive
// the process and could surface one account's numbers under another. The cache
// also dies with the process — a fresh TUI does one fresh chain, which #251's
// parallel legs make cheap.
//
// The default instance hangs off `globalThis`: the v2 TUI host re-evaluates
// the plugin module on hot reload (verified live: module eval count went 1 → 2
// per process on a source save, while the process stayed), so module-scope
// state would be wiped exactly on the remount the cache exists for.
// `globalThis` survives the re-evaluation and is dropped on process exit,
// which is the intended lifetime.
//
// Host-agnostic by design: no TUI runtime (solid-js), no runtime
// `@opencode-ai/*` import — only a type-only import of the controller's state
// shape.
import type { UsagePanelState } from "./tui-usage.js"

/**
 * How long a cached state stays seedable: stale numbers beat a blank segment
 * (the mount chain refreshes immediately), but a snapshot from yesterday
 * morning is not "the current usage". The TTL only gates the seed; a newer
 * write always replaces the entry.
 */
const USAGE_CACHE_TTL_MS = 30 * 60_000

/** The most recent sessions kept; sessions are few, this only bounds memory. */
const USAGE_CACHE_MAX_ENTRIES = 8

export interface UsageCacheOptions {
  /** Seedable age ceiling (defaults to 30 minutes). */
  ttlMs?: number
  /** Most recent entries kept (defaults to 8). */
  maxEntries?: number
  /** Clock seam for tests (defaults to Date.now()). */
  now?: () => number
}

/**
 * The cache seam the panel's host halves wire: read a session's last-good
 * state to seed a panel, write each published state back. A state older than
 * the TTL reads as a miss (and is dropped); every write prunes expired entries
 * and evicts the least recently touched session past the cap.
 */
export interface UsageCache {
  read(key: string): UsagePanelState | undefined
  write(key: string, state: UsagePanelState): void
}

/** One stored state with the instant it was written. */
interface CacheEntry {
  state: UsagePanelState
  savedAt: number
}

export function createUsageCache(options: UsageCacheOptions = {}): UsageCache {
  const ttlMs = options.ttlMs ?? USAGE_CACHE_TTL_MS
  const maxEntries = options.maxEntries ?? USAGE_CACHE_MAX_ENTRIES
  const now = options.now ?? Date.now
  // Insertion order is recency order: a hit or a write re-inserts the key, so
  // the first key is always the least recently used.
  const entries = new Map<string, CacheEntry>()

  const fresh = (entry: CacheEntry): boolean => now() - entry.savedAt <= ttlMs

  return {
    read(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (!fresh(entry)) {
        entries.delete(key)
        return undefined
      }
      // Re-insert so the hit counts as most recently used.
      entries.delete(key)
      entries.set(key, entry)
      return entry.state
    },
    write(key, state) {
      entries.delete(key)
      entries.set(key, { state, savedAt: now() })
      // Expire what is no longer seedable, then evict least-recently-used
      // entries past the cap (insertion order is recency order).
      for (const [candidate, entry] of entries) {
        if (!fresh(entry)) entries.delete(candidate)
      }
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}

const GLOBAL_KEY = Symbol.for("opencode-cmd-provider.usage-cache")

/**
 * The default cache instance the TUI halves share. Stored on `globalThis`
 * under a namespaced symbol so the plugin module's re-evaluation on a hot
 * reload keeps it (see the header); the factory stays the tests' seam.
 */
export function globalUsageCache(): UsageCache {
  const globals = globalThis as { [key: symbol]: UsageCache | undefined }
  const existing = globals[GLOBAL_KEY]
  if (existing !== undefined) return existing
  const created = createUsageCache()
  globals[GLOBAL_KEY] = created
  return created
}
