// src/deals/segments.ts — the sidebar panel's segment vocabulary and the
// user's layout over it (issue #253): which of the five segments render, in
// which order, as persisted by the segment-settings dialog.
//
// The layout is a plain JSON-safe record — `order` always carries all five ids
// (hidden ones included, so unhiding restores their position), `hidden` names
// the ones not rendered. Every read normalizes, so a value written by another
// release (unknown or missing ids) can never crash the panel or hide a segment
// by accident: unknown ids drop, duplicates drop, and ids the store lacks are
// appended in default order.
//
// Pure by design: no TUI runtime, no host imports. The host halves read and
// write it through their own durable stores (`api.kv` on v1,
// `ctx.storage.store` on v2); this module only owns the vocabulary, the
// normalization and the dialog's key intents.
//
// The panel composes the visible segments with one blank separator between
// them; `segmentKeyIntent` is the dialog's pure key map so the component
// shell stays free of branching.
export const DEALS_SEGMENT_IDS = ["status", "allowance", "rates", "info", "usage"] as const

export type DealsSegmentId = (typeof DEALS_SEGMENT_IDS)[number]

/** The dialog labels, matching the README's segment names. */
export const DEALS_SEGMENT_LABELS: Readonly<Record<DealsSegmentId, string>> = {
  status: "Tier and status",
  allowance: "Allowance",
  rates: "Rates",
  info: "Other Information",
  usage: "Usage",
}

/**
 * The KV/storage key both hosts persist the layout under. The v1 KV store is
 * shared by every plugin, so the key carries the plugin and the panel; the v2
 * storage namespace adds the plugin id on top.
 */
export const DEALS_LAYOUT_KEY = "commandcode.deals.segments"

/**
 * A normalized layout: the render order over all five ids, and the ids the
 * panel must not render. Both arrays are plain JSON, ready for host
 * persistence.
 */
export interface DealsLayout {
  order: DealsSegmentId[]
  hidden: DealsSegmentId[]
}

/** The out-of-the-box layout: every segment, in the panel's historic order. */
export function defaultLayout(): DealsLayout {
  return { order: [...DEALS_SEGMENT_IDS], hidden: [] }
}

function isSegmentId(value: unknown): value is DealsSegmentId {
  return typeof value === "string" && (DEALS_SEGMENT_IDS as readonly string[]).includes(value)
}

/**
 * The persisted shape, normalized: unknown and duplicate ids drop, ids missing
 * from `order` append in default order (a segment a later release adds must
 * appear, not vanish), and `hidden` keeps only known ids. Anything that is not
 * the expected object shape reads as the default layout.
 */
export function normalizeLayout(value: unknown): DealsLayout {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  const order: DealsSegmentId[] = []
  if (Array.isArray(record?.["order"])) {
    for (const id of record["order"]) {
      if (isSegmentId(id) && !order.includes(id)) order.push(id)
    }
  }
  for (const id of DEALS_SEGMENT_IDS) {
    if (!order.includes(id)) order.push(id)
  }
  const hidden: DealsSegmentId[] = []
  if (Array.isArray(record?.["hidden"])) {
    for (const id of record["hidden"]) {
      if (isSegmentId(id) && !hidden.includes(id)) hidden.push(id)
    }
  }
  return { order, hidden }
}

/** The ids the layout renders, in order. */
export function visibleSegments(layout: DealsLayout): DealsSegmentId[] {
  return layout.order.filter((id) => !layout.hidden.includes(id))
}

/** Flips one segment's visibility, keeping its position. */
export function toggleSegment(layout: DealsLayout, id: DealsSegmentId): DealsLayout {
  const hidden = layout.hidden.includes(id)
    ? layout.hidden.filter((candidate) => candidate !== id)
    : [...layout.hidden, id]
  return { order: [...layout.order], hidden }
}

/** Restores the out-of-the-box layout. */
export function resetLayout(): DealsLayout {
  return defaultLayout()
}

/**
 * Moves one id one slot up (-1) or down (1) in the order, hidden or not — the
 * dialog reorders every segment, so unhiding one later restores the position
 * the user chose. An unknown id or a boundary move is a copy.
 */
export function moveSegment(layout: DealsLayout, id: DealsSegmentId, delta: -1 | 1): DealsLayout {
  const order = [...layout.order]
  const index = order.indexOf(id)
  const target = index + delta
  const other = index === -1 ? undefined : order[target]
  if (index === -1 || target < 0 || other === undefined) {
    return { order, hidden: [...layout.hidden] }
  }
  order[index] = other
  order[target] = id
  return { order, hidden: [...layout.hidden] }
}

/** What one dialog key press means; undefined is "not a handled key". */
export type SegmentsKeyIntent =
  "up" | "down" | "move-up" | "move-down" | "toggle" | "reset" | "close"

/**
 * The dialog's pure key map. Arrow keys move the cursor; with shift they move
 * the segment itself. Space and enter toggle; `r` resets; escape closes.
 * Ctrl/meta combinations are never ours — a host binding like `ctrl+space`
 * stays with the host — and space/enter take no shift.
 */
export function segmentKeyIntent(event: {
  name: string
  shift: boolean
  ctrl: boolean
  meta: boolean
}): SegmentsKeyIntent | undefined {
  if (event.name === "escape") return "close"
  if (event.ctrl || event.meta) return undefined
  if (event.name === "up") return event.shift ? "move-up" : "up"
  if (event.name === "down") return event.shift ? "move-down" : "down"
  if (event.name === "space" || event.name === "return") return event.shift ? undefined : "toggle"
  if (event.name === "r" && !event.shift) return "reset"
  return undefined
}
