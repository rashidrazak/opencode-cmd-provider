// tests/diff-catalog.test.ts — seam: pure diff over MODEL_SNAPSHOT /
// MODEL_DEALS. The cron PR body (ticket #85) consumes the output of
// `diffCatalogs`. Tests assert on the Markdown output for known
// before/after pairs (added/removed models, name + contextLength
// changes, deals field changes, no-change short-circuit, and the
// FACTS/DEAL_LAST_REFRESHED date surfacing). No network, no fixtures —
// the test data is inline so the contract is self-contained.
import { classificationChanged, diffCatalogs } from "../scripts/diff-catalog.mjs"
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
    "snapshot: accepts the module-export wrapper shape { MODEL_SNAPSHOT: [...] } (cron input)",
    () => {
      // The catalog-refresh workflow (ticket #85) extracts the
      // generated .ts files via `tsx` and writes
      // `{ MODEL_SNAPSHOT: [...] }` to disk. The diff function
      // must unwrap that envelope; this test guards against a
      // future refactor that drops the unwrap and silently
      // produces "No changes." for every cron run.
      const before = {
        MODEL_SNAPSHOT: [{ id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 }],
      }
      const after = {
        MODEL_SNAPSHOT: [
          { id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 },
          { id: "gpt-5.6", name: "GPT-5.6", contextLength: 1000000 },
        ],
      }
      const md = diffCatalogs({ kind: "snapshot", before, after })
      assert(
        md.includes("### Added models (1)"),
        "must unwrap MODEL_SNAPSHOT and report the added model",
      )
      assert(md.includes("- `gpt-5.6`"), "must surface the unwrapped added model id")
    },
  ],
  [
    "deals: accepts the module-export wrapper shape { MODEL_DEALS: {...} } (cron input)",
    () => {
      const before = {
        MODEL_DEALS: { "gpt-5.5": { tier: "premium" as const, free: false } },
      }
      const after = {
        MODEL_DEALS: {
          "gpt-5.5": { tier: "premium" as const, free: false },
          "gpt-5.6": { tier: "opensource" as const, free: true },
        },
      }
      const md = diffCatalogs({ kind: "deals", before, after })
      assert(
        md.includes("### Added models (1)"),
        "must unwrap MODEL_DEALS and report the added model",
      )
      assert(md.includes("- `gpt-5.6`"), "must surface the unwrapped added model id")
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

  // ------------------------------------------------------------------
  // Classification sections (issue #112): semantic plain-language diff
  // over before/after classification payloads. Synthetic data only.
  // ------------------------------------------------------------------

  [
    "classification: a reasoning-without-efforts → efforts flip renders with the effort levels",
    () => {
      const before = {
        capability: { "moonshotai/Kimi-K3": true },
        efforts: {},
      }
      const after = {
        capability: { "moonshotai/Kimi-K3": true },
        efforts: { "moonshotai/Kimi-K3": ["low", "high", "max"] },
      }
      const md = diffCatalogs({ kind: "classification", before, after })
      assert(md.includes("## Reasoning classification"), "must use the classification label")
      assert(
        md.includes(
          "- `moonshotai/Kimi-K3`: reasoning-without-efforts → efforts model (`low, high, max`)",
        ),
        `must render the flip in plain language, got: ${md}`,
      )
    },
  ],
  [
    "classification: an efforts → reasoning-without-efforts flip renders both categories",
    () => {
      const before = {
        capability: { "a/model": true },
        efforts: { "a/model": ["low", "high"] },
      }
      const after = { capability: { "a/model": true }, efforts: {} }
      const md = diffCatalogs({ kind: "classification", before, after })
      assert(
        md.includes("- `a/model`: efforts model (`low, high`) → reasoning-without-efforts"),
        `must render the reverse flip, got: ${md}`,
      )
    },
  ],
  [
    "classification: a capability-flag promotion renders as a new reasoning model",
    () => {
      const before = { capability: { "a/model": false }, efforts: {} }
      const after = { capability: { "a/model": true }, efforts: {} }
      const md = diffCatalogs({ kind: "classification", before, after })
      assert(
        md.includes("- `a/model`: new reasoning model (reasoning-without-efforts)"),
        `must render the promotion, got: ${md}`,
      )
    },
  ],
  [
    "classification: a model added upstream with efforts renders as a new reasoning model with levels",
    () => {
      const before = { capability: {}, efforts: {} }
      const after = { capability: { "new/model": true }, efforts: { "new/model": ["high"] } }
      const md = diffCatalogs({ kind: "classification", before, after })
      assert(
        md.includes("- new reasoning model: `new/model` (efforts model (`high`))"),
        `must render the added reasoning model, got: ${md}`,
      )
    },
  ],
  [
    "classification: a removed reasoning model renders as retired; a removed non-reasoning model renders nothing",
    () => {
      const before = {
        capability: { "gone/reasoning": true, "gone/plain": false },
        efforts: { "gone/efforts": ["low"] },
      }
      const after = { capability: {}, efforts: {} }
      const md = diffCatalogs({ kind: "classification", before, after })
      assert(
        md.includes("- retired: `gone/reasoning` (was reasoning-without-efforts)"),
        `must render the retired reasoning model, got: ${md}`,
      )
      assert(
        md.includes("- retired: `gone/efforts` (was efforts model (`low`))"),
        `must render the retired efforts model, got: ${md}`,
      )
      assert(
        !md.includes("gone/plain"),
        "a removed non-reasoning model is not a classification change",
      )
    },
  ],
  [
    "classification: losing the capability flag renders as no-longer-reasoning",
    () => {
      const before = { capability: { "a/model": true }, efforts: {} }
      const after = { capability: { "a/model": false }, efforts: {} }
      const md = diffCatalogs({ kind: "classification", before, after })
      assert(
        md.includes("- `a/model`: no longer reasoning (was reasoning-without-efforts)"),
        `must render the demotion, got: ${md}`,
      )
    },
  ],
  [
    "classification: identical before/after renders no changes and no override section",
    () => {
      const payload = {
        capability: { "a/model": true, "b/model": false },
        efforts: { "c/model": ["low"] },
      }
      const md = diffCatalogs({ kind: "classification", before: payload, after: payload })
      assert(md.includes("No changes."), "must short-circuit identical classification")
      assert(!md.includes("overrides"), "an empty override map renders nothing")
    },
  ],
  [
    "classification: active overrides are listed with their justification notes",
    () => {
      const payload = {
        capability: { "a/model": true },
        efforts: {},
        overrides: {
          "a/model": {
            capability: false,
            justification: "upstream RSC flag says true but models.md omits reasoning",
          },
        },
      }
      const md = diffCatalogs({ kind: "classification", before: payload, after: payload })
      assert(
        md.includes("### Active classification overrides (1)"),
        `must render the overrides section, got: ${md}`,
      )
      assert(
        md.includes(
          "- `a/model`: capability false — upstream RSC flag says true but models.md omits reasoning",
        ),
        `must render the override entry with its justification, got: ${md}`,
      )
    },
  ],
  [
    "classification: accepts the cron's module-export wrapper shape and degrades gracefully when the before side is missing",
    () => {
      // The cron extracts { MODEL_REASONING_CAPABILITY, MODEL_EFFORTS,
      // CLASSIFICATION_OVERRIDES, CLASSIFICATION_LAST_REFRESHED } per side.
      const after = {
        MODEL_REASONING_CAPABILITY: { "a/model": true },
        MODEL_EFFORTS: {},
        CLASSIFICATION_OVERRIDES: {},
        CLASSIFICATION_LAST_REFRESHED: "2026-09-03",
      }
      const md = diffCatalogs({
        kind: "classification",
        before: { missing: true },
        after,
        beforeDate: "",
        afterDate: "2026-09-03",
      })
      assert(
        md.includes("first refresh"),
        `missing before module must degrade gracefully, got: ${md}`,
      )
      assert(!md.includes("`a/model`"), "a missing before side must not render change lines")
    },
  ],
  [
    "classification: output is byte-stable across calls (deterministic ordering)",
    () => {
      const before = {
        capability: { "z/model": true, "a/model": true },
        efforts: {},
      }
      const after = {
        capability: { "z/model": true, "a/model": true },
        efforts: { "a/model": ["low"], "z/model": ["high"] },
      }
      const md1 = diffCatalogs({ kind: "classification", before, after })
      const md2 = diffCatalogs({ kind: "classification", before, after })
      assertEqual(md1, md2, "classification diff must be deterministic")
      const aIdx = md1.indexOf("`a/model`")
      const zIdx = md1.indexOf("`z/model`")
      assert(aIdx >= 0 && zIdx > aIdx, "change lines must be sorted by model id")
    },
  ],
  [
    "classificationChanged: flips/promotions/retirements are true; identical and date-only churn are false",
    () => {
      // True: a semantic flip.
      assertEqual(
        classificationChanged({
          before: { capability: { "a/model": true }, efforts: {} },
          after: { capability: { "a/model": true }, efforts: { "a/model": ["high"] } },
        }),
        true,
        "a category flip must be reported as changed",
      )
      // True: a new reasoning model.
      assertEqual(
        classificationChanged({
          before: { capability: {}, efforts: {} },
          after: { capability: { "new/model": true }, efforts: {} },
        }),
        true,
        "a new reasoning model must be reported as changed",
      )
      // True: a retirement.
      assertEqual(
        classificationChanged({
          before: { capability: { "gone/model": true }, efforts: {} },
          after: { capability: {}, efforts: {} },
        }),
        true,
        "a retired reasoning model must be reported as changed",
      )
      // False: identical payloads.
      const payload = { capability: { "a/model": true }, efforts: { "b/model": ["low"] } }
      assertEqual(classificationChanged({ before: payload, after: payload }), false)
      // False: date-only churn (the refreshed date moves, the data does not).
      assertEqual(
        classificationChanged({
          before: { ...payload, lastRefreshed: "2026-09-02" },
          after: { ...payload, lastRefreshed: "2026-09-03" },
        }),
        false,
        "date-only churn must not count as a classification change",
      )
      // False: override-justification-only churn is not a data change.
      assertEqual(
        classificationChanged({
          before: {
            capability: { "a/model": true },
            efforts: {},
            overrides: { "a/model": { capability: true, justification: "note one" } },
          },
          after: {
            capability: { "a/model": true },
            efforts: {},
            overrides: { "a/model": { capability: true, justification: "note two" } },
          },
        }),
        false,
        "justification-only churn must not count as a classification change",
      )
    },
  ],
  [
    "classification CLI: merges the generated facts via --before-facts/--after-facts and renders the flip",
    async () => {
      // The cron invokes the CLI with the extracted classification
      // payloads plus the facts JSONs (which carry MODEL_EFFORTS). This
      // locks the CLI arg surface end-to-end.
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const exec = promisify(execFile)
      const dir = await mkdtemp(join(tmpdir(), "cc-diff-cli-"))
      try {
        await writeFile(
          join(dir, "before.json"),
          JSON.stringify({
            MODEL_REASONING_CAPABILITY: { "moonshotai/Kimi-K3": true },
            CLASSIFICATION_OVERRIDES: {},
            CLASSIFICATION_LAST_REFRESHED: "2026-09-02",
          }),
        )
        await writeFile(
          join(dir, "after.json"),
          JSON.stringify({
            MODEL_REASONING_CAPABILITY: { "moonshotai/Kimi-K3": true },
            CLASSIFICATION_OVERRIDES: {},
            CLASSIFICATION_LAST_REFRESHED: "2026-09-03",
          }),
        )
        await writeFile(
          join(dir, "facts-before.json"),
          JSON.stringify({ MODEL_EFFORTS: {}, FACTS_LAST_REFRESHED: "2026-09-02" }),
        )
        await writeFile(
          join(dir, "facts-after.json"),
          JSON.stringify({ MODEL_EFFORTS: { "moonshotai/Kimi-K3": ["low", "high", "max"] } }),
        )
        const { stdout } = await exec("node", [
          "scripts/diff-catalog.mjs",
          "classification",
          join(dir, "before.json"),
          join(dir, "after.json"),
          "--before-facts",
          join(dir, "facts-before.json"),
          "--after-facts",
          join(dir, "facts-after.json"),
          "--before-date",
          "2026-09-02",
          "--after-date",
          "2026-09-03",
        ])
        assert(
          stdout.includes(
            "- `moonshotai/Kimi-K3`: reasoning-without-efforts → efforts model (`low, high, max`)",
          ),
          `CLI must render the flip, got: ${stdout}`,
        )
        assert(
          stdout.includes("- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-02` → `2026-09-03`"),
          "CLI must surface the classification date line",
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
])
