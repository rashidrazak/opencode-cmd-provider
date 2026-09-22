// src/deals/format.ts — shared number formatting for the Deals slice's
// user-visible surfaces (the TUI sidebar panel and the cmd_plan_summary tool).
// Formatting lives here, never in the generated catalog or the refresh
// pipeline: src/deals/catalog.ts stays a verbatim projection of the captured
// RSC (issue #222).
//
// The TUI imports this directly; the server barrel does not re-export it, so
// the two hosts share one formatting rule without the provider process loading
// anything panel-shaped.

/**
 * Upstream computes discounted rates in JS (`6 × 0.6`), so the captured RSC
 * carries binary-float residue (`3.5999999999999996`). Upstream's published
 * per-million rates carry at most a few decimals, so `toFixed(6)` is exact for
 * them and noise-only for residue — a rate below 1e-6 is outside the published
 * envelope and would round to zero.
 */
export function formatRate(value: number): string {
  return String(Number(value.toFixed(6)))
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The plugin's day: an ISO `YYYY-MM-DD` date. Surfaces take the day as an
 * argument instead of reading a clock inside the formatter, so a render stays a
 * function of its inputs and the tests pin "today" rather than race the
 * calendar.
 */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The "Deal" text. `endsAt` stays verbatim in the catalog (issue #90: the
 * captured RSC is the truth, and the Snapshot — not this metadata — is what
 * bills), so the ended/active distinction is made here, once, for both
 * presenters. A past ISO date reads `50% off (ended 2026-06-22)` instead of
 * claiming an "until" that has already passed. A deal ending *today* is still
 * active: upstream expires at 23:59:59Z of the named day. A non-ISO `endsAt`
 * (the vestigial "while capacity lasts") has no date to compare and keeps the
 * historic phrasing.
 */
export function discountLabel(pct: number, endsAt: string | undefined, today: string): string {
  const base = `${pct}% off`
  if (endsAt === undefined) return base
  // Lexicographic order is chronological for ISO dates.
  if (ISO_DATE.test(endsAt) && endsAt < today) return `${base} (ended ${endsAt})`
  return `${base} until ${endsAt}`
}
