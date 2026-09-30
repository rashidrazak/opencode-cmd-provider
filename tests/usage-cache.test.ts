// tests/usage-cache.test.ts — the usage segment's last-good cache (issue
// #251): the session-keyed store the panel seeds from, its TTL, its recency
// cap, and the process-global default that survives the TUI host's module
// re-evaluation on hot reload. Plain in-memory tests; no network, no TUI
// runtime.
import { createUsageCache, globalUsageCache } from "../src/deals/usage-cache.js"
import type { UsagePanelState } from "../src/deals/tui-usage.js"
import { assert, assertEqual, run } from "./harness.js"

const NOW = Date.parse("2026-10-01T12:00:00.000Z")

/** A minimal published state, distinguishable by its request count. */
function state(requests: number): UsagePanelState {
  return { result: { state: "usage", snapshot: { totals: { requests } } } }
}

run([
  [
    "a written state reads back under its own key only",
    () => {
      const cache = createUsageCache()
      cache.write("ses_1", state(1))
      assertEqual(cache.read("ses_1"), state(1))
      assertEqual(cache.read("ses_2"), undefined, "another session never sees it")
    },
  ],

  [
    "an entry older than the TTL is a miss and is dropped",
    () => {
      let now = NOW
      const cache = createUsageCache({ ttlMs: 60_000, now: () => now })
      cache.write("ses_1", state(1))
      now = NOW + 60_000
      assert(cache.read("ses_1") !== undefined, "exactly the TTL is still seedable")
      now = NOW + 60_001
      assertEqual(cache.read("ses_1"), undefined, "past the TTL the seed is a miss")
      now = NOW
      assertEqual(cache.read("ses_1"), undefined, "and the entry was dropped, not just hidden")
    },
  ],

  [
    "a write prunes expired entries before capping recency",
    () => {
      let now = NOW
      const cache = createUsageCache({ ttlMs: 60_000, maxEntries: 2, now: () => now })
      cache.write("a", state(1))
      cache.write("b", state(2))
      now = NOW + 120_000
      cache.write("c", state(3))
      assertEqual(cache.read("a"), undefined, "the expired entry was pruned by the write")
      assertEqual(cache.read("b"), undefined)
      assertEqual(cache.read("c"), state(3))
    },
  ],

  [
    "the store keeps only the most recently used sessions",
    () => {
      const cache = createUsageCache({ maxEntries: 2 })
      cache.write("a", state(1))
      cache.write("b", state(2))
      assert(cache.read("a") !== undefined, "touch a")
      cache.write("c", state(3))
      assertEqual(cache.read("a"), state(1), "the recently read entry survives the cap")
      assertEqual(cache.read("b"), undefined, "the least recently used entry is evicted")
      assertEqual(cache.read("c"), state(3))
    },
  ],

  [
    "the default cache is one process-global instance; the factory stays isolated",
    () => {
      const global = globalUsageCache()
      assert(global === globalUsageCache(), "the process has exactly one default cache")
      assert(createUsageCache() !== global, "a factory-built cache is its own store")
      global.write("__usage_cache_suite__", state(9))
      assertEqual(
        globalUsageCache().read("__usage_cache_suite__"),
        state(9),
        "the default survives repeated lookups (the hot-reload case)",
      )
    },
  ],
])
