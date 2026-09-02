// scripts/parse-rsc.mjs — Command Code RSC stream parser for the deals
// catalog. The Next.js docs site serves three pages whose flight payload
// embeds the model data as JSON:
//
//   /docs/resources/pricing-limits
//     - availability array  (paid + free models, with `tiers`, `deal`,
//       `caps`, `contextWindow`, `intelligenceIndex`, `outputTokensPerSec`)
//     - compact array       (paid models only, with `planAllowanceUsd`)
//   /docs/plans/goat
//     - slug records array  (per-model records, vendor-prefixed id, used
//       as the source of truth for the snapshot `id` and `name`)
//   /docs/plans/pro
//     - slug records array  (same shape as goat)
//
// The legacy HTML scrape (parse-docs.mjs) read these via the rendered
// `<table>` elements + per-object extraction from the flight payload. The
// RSC surface is more stable: it's the actual structured data, not a
// rendered table, so column reshuffles and class renames can't break it.
//
// Pure functions: each takes a string (the un-escaped RSC body) and
// returns plain JS objects. No network, no file I/O. Tests pin the field
// shape per record so a Command Code schema change fails loudly instead of
// silently shipping wrong rates.
import { findJsonValues, parseJsonValue } from "./json-stream.mjs"

function decodeEscapedJson(html) {
  // Same escape rules the legacy parse-docs.mjs uses; the RSC payload
  // arrives with the same `\\"` / `\\n` / `\\u0026` escapes as the HTML.
  return html.replaceAll('\\"', '"').replaceAll("\\n", "\n").replaceAll("\\u0026", "&")
}

// pricing-limits carries two parallel arrays. The availability array has
// `tiers` and `deal`; the compact array has `planAllowanceUsd`. They share
// `id` as the join key. The first element of each array is enough to tell
// them apart, so the predicate scans the first record of each candidate
// array.
function isAvailabilityArray(arr) {
  const first = arr[0]
  return (
    first &&
    typeof first === "object" &&
    typeof first.id === "string" &&
    Array.isArray(first.tiers) &&
    typeof first.caps === "object"
  )
}

function isCompactArray(arr) {
  const first = arr[0]
  return (
    first &&
    typeof first === "object" &&
    typeof first.id === "string" &&
    typeof first.planAllowanceUsd === "object" &&
    first.planAllowanceUsd !== null
  )
}

function isSlugRecordsArray(arr) {
  const first = arr[0]
  return (
    first &&
    typeof first === "object" &&
    typeof first.slug === "string" &&
    typeof first.id === "string" &&
    // The slug array's id is vendor-prefixed (`MiniMaxAI/MiniMax-M3`).
    first.id.includes("/")
  )
}

// Returns the two pricing-limits arrays. The RSC stream is variable in
// order (Command Code has reshuffled the payload in the past), so we
// identify each array by its first-element shape rather than by position.
// Returns `{}` if either array is missing — that means the page no longer
// carries the data and the caller should fall back to HTML (or fail
// loudly; both are valid per the spec's "schema change" handling).
//
// The arrays live inside wrapper objects (Command Code's current shape
// embeds them as `{models: [...]}` and `{rows: [...]}` envelopes), so
// the scan descends into nested objects until it finds a candidate.
export function extractPricingLimitsRsc(html) {
  const text = decodeEscapedJson(html)
  const out = {}
  // findJsonValues recursively scans for values matching a predicate. The
  // wrapper objects are short-lived intermediate hits we filter out.
  for (const value of findJsonValues(text, (v) => Array.isArray(v) && v.length > 0)) {
    if (!out.availability && isAvailabilityArray(value)) out.availability = value
    else if (!out.compact && isCompactArray(value)) out.compact = value
    if (out.availability && out.compact) break
  }
  return out
}

// Returns the per-plan (goat or pro) slug records array as a Map keyed
// by the snapshot id. The per-plan pages only ever embed one of these
// per request, so the scan will return exactly one match.
//
// The slug records' `id` field is rewritten in place to the snapshot id
// (via applySlugIdAlias) so callers don't need to re-do the join. The Map
// key is also the snapshot id, so iterating the Map yields snapshot-id
// → record entries. Models not in SLUG_ID_TO_SNAPSHOT_ID pass through
// unchanged — `poolside/laguna-s-2.1-free` keeps its vendor prefix and
// free-variant suffix.
export function extractPlanPageRsc(html) {
  const text = decodeEscapedJson(html)
  const candidates = findJsonValues(text, (v) => Array.isArray(v) && isSlugRecordsArray(v))
  const records = new Map()
  if (candidates.length === 0) return records
  // Use the longest match — defensive, in case the page embeds more than
  // one (e.g. a fallback copy).
  const longest = candidates.reduce((a, b) => (a.length >= b.length ? a : b))
  for (const record of longest) {
    if (typeof record.id !== "string") continue
    // Apply the slug-id → snapshot-id alias. The record's `id` is mutated
    // so downstream consumers (refresh-deals.mjs, the deals catalog) see
    // the same id the snapshot uses, with no second join step.
    record.id = applySlugIdAlias(record.id)
    records.set(record.id, record)
  }
  return records
}

// Slug-id → snapshot-id alias map. The RSC's per-model `id` field is the
// docs site's stable id, but the snapshot's id space includes date
// suffixes that the RSC omits (e.g. the snapshot ships
// `claude-haiku-4-5-20251001` while the RSC carries `claude-haiku-4-5`).
// Without this map, the deal record keyed by the RSC id would not join
// against the snapshot, and the deals catalog would silently drop the
// "Command Code" sidebar section for that model.
//
// This map grows as Command Code ships new date-suffixed ids. Review on
// every release: a new entry here is the only way the deals catalog picks
// up a date-suffixed snapshot. The keys are RSC ids (the form the docs
// site emits); the values are the matching snapshot ids.
/** @type {Record<string, string>} */
export const SLUG_ID_TO_SNAPSHOT_ID = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
}

// Returns the snapshot id for a RSC id, or the input unchanged if no
// alias is configured. Pure: no I/O, no side effects. Used by
// `extractPlanPageRsc` (to key the returned Map) and by callers that
// want to normalise the `id` field on availability/compact records
// pulled from `extractPricingLimitsRsc`.
export function applySlugIdAlias(id) {
  return SLUG_ID_TO_SNAPSHOT_ID[id] ?? id
}

// Find a single JSON object in `text` starting at the given index. Useful
// for callers that already know where a record begins (e.g. a marker the
// upstream RSC emits). Returns `undefined` if the value is not a parseable
// JSON object. Re-exported here for callers that want to skip the array
// scan.
export { parseJsonValue as findJsonObject }

// Shape-pinning fields. The schema we rely on for the deals catalog: any
// record that lacks one of these is either malformed upstream or a schema
// change. The cron calls the refresh script, which calls this parser; if
// the shape changes, the test in parse-rsc.test.ts fails first, so the
// cron never ships a degraded catalog.
//
// The check is intentionally field-presence, not field-typed — Command
// Code has shipped rates as both numbers and numeric strings in the past,
// and the existing `num()` helper in parse-docs.mjs already coerces them.
// What matters is the field *exists* on the record.
//
// `deal` and `timeOfDay` are conditional: only records with an active
// deal carry the `deal` field, and only the DeepSeek V4 family carries
// `timeOfDay` today. The required list covers what the parser *always*
// needs to read, not what every record carries.
export const REQUIRED_AVAILABILITY_FIELDS = [
  "id",
  "name",
  "category",
  "contextWindow",
  "caps",
  "tiers",
]

// Slug records are richer (used as the source of truth for the snapshot
// `id` / `name`), so the required set is larger. `deal` and `timeOfDay`
// are conditional here too. `reasoning` is the per-model reasoning flag
// the classification generator derives from (issue #110) — an upstream
// rename or drop must be a loud shape failure, never a silent
// default-to-non-reasoning.
export const REQUIRED_SLUG_RECORD_FIELDS = [
  "slug",
  "id",
  "name",
  "vendor",
  "category",
  "minPlanName",
  "tiers",
  "caps",
  "reasoning",
]

// The compact array has a different shape (no `tiers` or `caps`); its
// required fields are the ones the deals catalog needs from it.
export const REQUIRED_COMPACT_FIELDS = ["id", "name", "planAllowanceUsd"]

// Returns the list of missing required field names for a record against
// a required-field list, or `[]` if the record satisfies the contract.
// Used by the shape-pinning test to assert that a known model still
// carries every field the deals catalog reads.
export function missingFields(record, required) {
  if (!record || typeof record !== "object") return required.slice()
  return required.filter((field) => record[field] === undefined)
}
