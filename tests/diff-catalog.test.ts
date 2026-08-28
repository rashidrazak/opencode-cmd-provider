// tests/diff-catalog.test.ts — seam: pure diff over MODEL_SNAPSHOT /
// MODEL_DEALS. The cron PR body (ticket #85) consumes the output of
// `diffCatalogs`. Tests assert on the Markdown output for known
// before/after pairs (added/removed models, name + contextLength
// changes, deals field changes, no-change short-circuit, and the
// FACTS/DEAL_LAST_REFRESHED date surfacing). No network, no fixtures —
// the test data is inline so the contract is self-contained.
import { diffCatalogs } from "../scripts/diff-catalog.mjs"
import { assert, assertEqual, run } from "./harness.js"

run([
  [
    "snapshot: identical input produces a 'no changes' message with no model lists",
    () => {
      const snapshot = [
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
        { id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 },
      ]
      const md = diffCatalogs({ kind: "snapshot", before: snapshot, after: snapshot })
      assert(md.includes("## Model catalog"), "must include the default label")
      assert(md.includes("No changes."), "must include the no-changes short-circuit")
      assert(
        !md.includes("Added models"),
        "must not emit an Added models section when nothing changed",
      )
      assert(
        !md.includes("Removed models"),
        "must not emit a Removed models section when nothing changed",
      )
      assert(
        !md.includes("Changed models"),
        "must not emit a Changed models section when nothing changed",
      )
    },
  ],
  [
    "snapshot: an added model appears in the Added list with the default label",
    () => {
      const before = [{ id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 }]
      const after = [
        { id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 },
        { id: "gpt-5.6", name: "GPT-5.6", contextLength: 1000000 },
      ]
      const md = diffCatalogs({ kind: "snapshot", before, after })
      assert(md.includes("### Added models (1)"), "must list the added-model count")
      assert(md.includes("- `gpt-5.6`"), "must surface the added model id")
      assert(!md.includes("Removed models"), "must not emit a Removed models section")
    },
  ],
  [
    "snapshot: a removed model appears in the Removed list",
    () => {
      const before = [
        { id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 },
        { id: "gpt-5.6", name: "GPT-5.6", contextLength: 1000000 },
      ]
      const after = [{ id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 }]
      const md = diffCatalogs({ kind: "snapshot", before, after })
      assert(md.includes("### Removed models (1)"), "must list the removed-model count")
      assert(md.includes("- `gpt-5.6`"), "must surface the removed model id")
    },
  ],
  [
    "snapshot: a name change surfaces as a per-field line in Changed models",
    () => {
      const before = [{ id: "gpt-5.5", name: "GPT 5.5", contextLength: 400000 }]
      const after = [{ id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 }]
      const md = diffCatalogs({ kind: "snapshot", before, after })
      assert(md.includes("### Changed models (1 field)"), "must report exactly one field change")
      assert(
        md.includes("- `gpt-5.5`: name `GPT 5.5` → `GPT-5.5`"),
        "must show the name change in the canonical form",
      )
    },
  ],
  [
    "snapshot: a contextLength change surfaces as a per-field line in Changed models",
    () => {
      const before = [{ id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 }]
      const after = [{ id: "gpt-5.5", name: "GPT-5.5", contextLength: 800000 }]
      const md = diffCatalogs({ kind: "snapshot", before, after })
      assert(
        md.includes("- `gpt-5.5`: contextLength `400000` → `800000`"),
        "must show the contextLength change in the canonical form",
      )
    },
  ],
  [
    "snapshot: FACTS_LAST_REFRESHED is surfaced when both dates are provided",
    () => {
      const snapshot = [{ id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 }]
      const md = diffCatalogs({
        kind: "snapshot",
        before: snapshot,
        after: snapshot,
        beforeDate: "2026-08-26",
        afterDate: "2026-08-27",
      })
      assert(
        md.includes("- **FACTS_LAST_REFRESHED**: `2026-08-26` → `2026-08-27`"),
        "must surface FACTS_LAST_REFRESHED as the default date label for snapshot diffs",
      )
    },
  ],
  [
    "deals: identical input produces a 'no changes' message and uses the deals label",
    () => {
      const deals = {
        "gpt-5.5": { tier: "premium" as const, free: false },
      }
      const md = diffCatalogs({ kind: "deals", before: deals, after: deals })
      assert(md.includes("## Deals intelligence"), "must include the deals default label")
      assert(md.includes("No changes."), "must short-circuit identical deals")
    },
  ],
  [
    "deals: a discount.pct change surfaces in the diff with the canonical form",
    () => {
      const before = {
        "MiniMaxAI/MiniMax-M3": {
          tier: "opensource" as const,
          discount: { pct: 30, endsAt: "2026-12-31" },
          was: { input: 0.6, output: 2.4, cacheRead: 0.12 },
          now: { input: 0.42, output: 1.68, cacheRead: 0.084 },
          free: false,
        },
      }
      const after = {
        "MiniMaxAI/MiniMax-M3": {
          tier: "opensource" as const,
          discount: { pct: 50, endsAt: "2026-12-31" },
          was: { input: 0.6, output: 2.4, cacheRead: 0.12 },
          now: { input: 0.3, output: 1.2, cacheRead: 0.06 },
          free: false,
        },
      }
      const md = diffCatalogs({ kind: "deals", before, after })
      assert(
        md.includes("discount 30% off (ends 2026-12-31) → 50% off (ends 2026-12-31)"),
        "must show the discount pct change in the canonical form",
      )
      assert(
        md.includes("now in 0.42 / out 1.68 / cache 0.084 → in 0.3 / out 1.2 / cache 0.06"),
        "must show the now-rate change in the canonical form",
      )
    },
  ],
  [
    "deals: an allowance change surfaces with goat/pro values",
    () => {
      const before = {
        "claude-sonnet-5": { tier: "premium" as const, free: false, allowance: { pro: 20 } },
      }
      const after = {
        "claude-sonnet-5": { tier: "premium" as const, free: false, allowance: { pro: 30 } },
      }
      const md = diffCatalogs({ kind: "deals", before, after })
      assert(
        md.includes("allowance pro: 20 → pro: 30"),
        "must show the allowance change in the canonical form",
      )
    },
  ],
  [
    "deals: a peakOffPeak change surfaces with the peak/off-peak rates",
    () => {
      const before = {
        "deepseek/deepseek-v4-pro": {
          tier: "opensource" as const,
          free: false,
          peakOffPeak: {
            peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
            offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
            windows: "01–04 & 06–10 UTC",
          },
        },
      }
      const after = {
        "deepseek/deepseek-v4-pro": {
          tier: "opensource" as const,
          free: false,
          peakOffPeak: {
            peak: { input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0 },
            offPeak: { input: 0.75, output: 2.25, cacheRead: 0.025, cacheWrite: 0 },
            windows: "01–04 & 06–10 UTC",
          },
        },
      }
      const md = diffCatalogs({ kind: "deals", before, after })
      assert(
        md.includes("peakOffPeak"),
        "must surface a peakOffPeak change in the Changed models section",
      )
      assert(md.includes("peak in 1.5"), "must show the new peak input rate in the canonical form")
      assert(
        md.includes("(01–04 & 06–10 UTC)"),
        "must keep the windows label intact when rates change",
      )
    },
  ],
  [
    "deals: DEAL_LAST_REFRESHED is surfaced when both dates are provided",
    () => {
      const deals = { "gpt-5.5": { tier: "premium" as const, free: false } }
      const md = diffCatalogs({
        kind: "deals",
        before: deals,
        after: deals,
        beforeDate: "2026-08-26",
        afterDate: "2026-08-27",
      })
      assert(
        md.includes("- **DEAL_LAST_REFRESHED**: `2026-08-26` → `2026-08-27`"),
        "must surface DEAL_LAST_REFRESHED as the default date label for deals diffs",
      )
    },
  ],
  [
    "snapshot: output is byte-stable across calls (deterministic ordering)",
    () => {
      const before = [
        { id: "z-1", name: "Z", contextLength: 1 },
        { id: "a-1", name: "A", contextLength: 1 },
      ]
      const after = [
        { id: "a-1", name: "A", contextLength: 1 },
        { id: "z-1", name: "Z", contextLength: 2 },
      ]
      const md1 = diffCatalogs({ kind: "snapshot", before, after })
      const md2 = diffCatalogs({ kind: "snapshot", before, after })
      assertEqual(md1, md2, "diffCatalogs must be deterministic for the same input")
      // The Changed-models line must surface the z-1 contextLength change.
      assert(
        md1.includes("- `z-1`: contextLength `1` → `2`"),
        "must report the z-1 contextLength change",
      )
    },
  ],
  [
    "deals: throws for an unknown kind (defensive — never called from the cron)",
    () => {
      const deals = { "gpt-5.5": { tier: "premium" as const, free: false } }
      let threw = false
      try {
        diffCatalogs({ kind: "unknown" as never, before: deals, after: deals })
      } catch {
        threw = true
      }
      assert(threw, "diffCatalogs must throw for an unknown kind")
    },
  ],
])
