// scripts/snapshot-index.mjs — shared snapshot lookups for the deals scripts.
// src/catalog/snapshot.ts is the source of truth for model ids, but docs
// records can diverge from it in two ways:
//   - ids differ (claude-haiku-4-5 docs → claude-haiku-4-5-20251001 snapshot);
//   - display names collide (the paid and free MiniMax variants both render as
//     "MiniMax M3" / "MiniMax M2.7").
// One parser, one place to fix — both refresh-deals.mjs and
// check-deals-coverage.mjs consume this instead of re-implementing the regex.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const SNAPSHOT_PATH = resolve(import.meta.dirname, "..", "src", "catalog", "snapshot.ts")
const ENTRY_RE = /\{ id: "([^"]+)", name: "([^"]+)",/g

/**
 * Parses every `{ id, name }` entry of the snapshot file, in file order.
 *
 * Returns:
 * - `entries`: every entry, in order (a name may appear multiple times);
 * - `byName`: name → first-occurrence id. First wins on purpose: paid
 *   variants precede their free siblings, and docs allowance tables only list
 *   paid models, so the paid id keeps the allowance;
 * - `byId`: id → name for every entry;
 * - `nameCounts`: name → how many snapshot entries carry it (1 = unique).
 */
export function snapshotIndex() {
  const text = readFileSync(SNAPSHOT_PATH, "utf-8")
  const entries = [...text.matchAll(ENTRY_RE)].map((m) => ({ id: m[1], name: m[2] }))
  const byName = new Map()
  const byId = new Map()
  const nameCounts = new Map()
  for (const { id, name } of entries) {
    if (!byName.has(name)) byName.set(name, id)
    if (!byId.has(id)) byId.set(id, name)
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  return { entries, byName, byId, nameCounts }
}
