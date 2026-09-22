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
