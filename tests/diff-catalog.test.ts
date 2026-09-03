// tests/diff-catalog.test.ts — seam: pure diff over MODEL_SNAPSHOT /
// MODEL_DEALS. The cron PR body (ticket #85) consumes the output of
// `diffCatalogs`. Tests assert on the Markdown output for known
// before/after pairs (added/removed models, name + contextLength
// changes, deals field changes, no-change short-circuit, and the
// FACTS/DEAL_LAST_REFRESHED date surfacing). No network, no fixtures —
// the test data is inline so the contract is self-contained.
import { classificationChanged, diffCatalogs } from "../scripts/diff-catalog.mjs"
import { assert, assertEqual, run } from "./harness.js"

/**
 * Padding-agnostic table-row matcher: true when the markdown contains a
 * table row whose cells (split on |, trimmed) start with the given
 * values. Table cells are padded to column width by renderTable, so
 * exact substrings are brittle.
 *
 * @param {string} md
 * @param {...string} cells expected leading cell values
 * @returns {boolean}
 */
function hasRow(md, ...cells) {
  return md.split("\n").some((line) => {
    if (!line.trimStart().startsWith("|")) return false
    const values = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim())
    return cells.every((cell, i) => values[i] === cell)
  })
}

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
      assert(!md.includes("| Model"), "must not emit a change table when nothing changed")
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
      assert(hasRow(md, "`gpt-5.6`", "added"), `must surface the added model row, got: ${md}`)
      assert(!md.includes("removed"), "must not emit a removed row")
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
      assert(hasRow(md, "`gpt-5.6`", "removed"), `must surface the removed model row, got: ${md}`)
    },
  ],
  [
    "snapshot: a name change surfaces as a per-field line in Changed models",
    () => {
      const before = [{ id: "gpt-5.5", name: "GPT 5.5", contextLength: 400000 }]
      const after = [{ id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 }]
      const md = diffCatalogs({ kind: "snapshot", before, after })
      assert(
        hasRow(md, "`gpt-5.5`", "renamed", "GPT 5.5 · 400000 ctx", "GPT-5.5 · 400000 ctx"),
        `must surface the rename row with both names, got: ${md}`,
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
        hasRow(md, "`gpt-5.5`", "context", "GPT-5.5 · 400000 ctx", "GPT-5.5 · 800000 ctx"),
        `must surface the context row, got: ${md}`,
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
        hasRow(
          md,
          "`MiniMaxAI/MiniMax-M3`",
          "discount",
          "30% off (ends 2026-12-31)",
          "50% off (ends 2026-12-31)",
        ),
        `must show the discount change as a table row, got: ${md}`,
      )
      assert(
        hasRow(
          md,
          "`MiniMaxAI/MiniMax-M3`",
          "now rates",
          "in 0.42 / out 1.68 / cache 0.084",
          "in 0.3 / out 1.2 / cache 0.06",
        ),
        `must show the now-rate change as a table row, got: ${md}`,
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
        hasRow(md, "`claude-sonnet-5`", "allowance", "pro: 20", "pro: 30"),
        `must show the allowance change as a table row, got: ${md}`,
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
        hasRow(md, "`deepseek/deepseek-v4-pro`", "peakOffPeak"),
        "must surface a peakOffPeak change as a table row",
      )
      assert(md.includes("peak in 1.5"), "must show the new peak input rate in the canonical form")
      assert(
        md.includes("(01–04 & 06–10 UTC)"),
        "must keep the windows label intact when rates change",
      )
    },
  ],
  [
    "snapshot: a pricing change renders as a pricing row when the facts payload is provided",
    () => {
      const snapshot = [{ id: "a/model", name: "A Model", contextLength: 1000000 }]
      const before = {
        MODEL_SNAPSHOT: snapshot,
        MODEL_COSTS: { "a/model": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
        MODEL_EFFORTS: {},
      }
      const after = {
        MODEL_SNAPSHOT: snapshot,
        MODEL_COSTS: { "a/model": { input: 1.5, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
        MODEL_EFFORTS: {},
      }
      const md = diffCatalogs({
        kind: "snapshot",
        before,
        after,
        beforeFacts: before,
        afterFacts: after,
      })
      assert(
        hasRow(
          md,
          "`a/model`",
          "pricing",
          "input 1 / output 2 / cacheRead 0.1 / cacheWrite 0",
          "input 1.5 / output 2 / cacheRead 0.1 / cacheWrite 0",
        ),
        `must surface the pricing change as a table row, got: ${md}`,
      )
    },
  ],
  [
    "snapshot: an efforts promotion renders as an efforts row when the facts payload is provided",
    () => {
      const snapshot = [{ id: "a/model", name: "A Model", contextLength: 1000000 }]
      const md = diffCatalogs({
        kind: "snapshot",
        before: { MODEL_SNAPSHOT: snapshot, MODEL_EFFORTS: {} },
        after: {
          MODEL_SNAPSHOT: snapshot,
          MODEL_EFFORTS: { "a/model": ["low", "medium", "high", "xhigh"] },
        },
        beforeFacts: { MODEL_EFFORTS: {} },
        afterFacts: { MODEL_EFFORTS: { "a/model": ["low", "medium", "high", "xhigh"] } },
      })
      assert(
        hasRow(md, "`a/model`", "efforts", "—", "low, medium, high, xhigh"),
        `must surface the efforts promotion as a table row, got: ${md}`,
      )
    },
  ],
  [
    "snapshot: the emitted table is Prettier-normal-form (format:check stability)",
    async () => {
      // The release pipeline runs format:check over the emitted CHANGELOG;
      // renderTable must already pad to Prettier's table normal form.
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const exec = promisify(execFile)
      const before = [{ id: "a/very-long-model-id", name: "Long", contextLength: 1000 }]
      const after = [...before, { id: "x", name: "X", contextLength: 2 }]
      const md = diffCatalogs({ kind: "snapshot", before, after })
      const dir = await mkdtemp(join(tmpdir(), "cc-table-prettier-"))
      try {
        const file = join(dir, "table.md")
        await writeFile(file, md)
        await exec("npx", ["prettier", "--parser", "markdown", "--check", file])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
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
        hasRow(md, "`gpt-5.6`", "added"),
        `must unwrap MODEL_SNAPSHOT and report the added model, got: ${md}`,
      )
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
        hasRow(md, "`gpt-5.6`", "added"),
        `must unwrap MODEL_DEALS and report the added model, got: ${md}`,
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
      // The table must surface the z-1 contextLength change.
      assert(
        hasRow(md1, "`z-1`", "context", "Z · 1 ctx", "Z · 2 ctx"),
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
        hasRow(
          md,
          "`moonshotai/Kimi-K3`",
          "classification",
          "reasoning-without-efforts",
          "efforts model (low, high, max)",
        ),
        `must render the flip as a table row, got: ${md}`,
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
        hasRow(
          md,
          "`a/model`",
          "classification",
          "efforts model (low, high)",
          "reasoning-without-efforts",
        ),
        `must render the reverse flip as a table row, got: ${md}`,
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
        hasRow(md, "`a/model`", "classification", "non-reasoning", "reasoning-without-efforts"),
        `must render the promotion as a table row, got: ${md}`,
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
        hasRow(md, "`new/model`", "new", "—", "efforts model (high)"),
        `must render the added reasoning model as a table row, got: ${md}`,
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
        hasRow(md, "`gone/reasoning`", "retired", "reasoning-without-efforts", "—"),
        `must render the retired reasoning model as a table row, got: ${md}`,
      )
      assert(
        hasRow(md, "`gone/efforts`", "retired", "efforts model (low)", "—"),
        `must render the retired efforts model as a table row, got: ${md}`,
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
        hasRow(md, "`a/model`", "classification", "reasoning-without-efforts", "non-reasoning"),
        `must render the demotion as a table row, got: ${md}`,
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
          stdout.split("\n").some((line) => {
            if (!line.trimStart().startsWith("|")) return false
            const cells = line
              .split("|")
              .slice(1, -1)
              .map((c) => c.trim())
            return (
              cells[0] === "`moonshotai/Kimi-K3`" &&
              cells[1] === "classification" &&
              cells[2] === "reasoning-without-efforts" &&
              cells[3] === "efforts model (low, high, max)"
            )
          }),
          `CLI must render the flip as a table row, got: ${stdout}`,
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
