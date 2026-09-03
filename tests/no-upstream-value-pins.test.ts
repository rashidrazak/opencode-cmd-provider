// tests/no-upstream-value-pins.test.ts — the upstream-value-pin lint gate.
//
// The 2026-09-03 catalog-refresh cron (gh run 33779520318) went red because
// tests in `tests/plugin-models.test.ts` re-typed upstream-owned values
// (`muse.variants === undefined`, literal variant lists). The #108 design
// says value changes must surface as a refresh-PR diff, never as a red
// suite — but that rule was enforced only by convention. This gate makes it
// mechanical.
//
// The forbidden pattern: indexing a generated catalog (or calling a
// catalog-backed lookup) with a **literal model id that exists in the
// generated data**. Such a pin breaks the moment upstream changes that
// model's row. The check resolves ids against the live generated catalogs,
// so:
//   - synthetic ids (`a/model`, `vendor/not-in-any-catalog`) pass — they can
//     never collide with upstream reality;
//   - derivation-style access (`MODEL_COSTS[id]` over a loop) passes — no
//     literal;
//   - a literal id upstream actually ships fails, with the file and line.
//
// Genuine cross-checks between the test's own fixtures and the catalogs (a
// parser fixture row that must keep joining against the generated facts)
// are allowed via the ALLOWLIST below — every entry carries a written
// justification, mirroring the classification-overrides seam (ADR-0006).

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { MODEL_REASONING_CAPABILITY } from "../src/catalog/classification.js"
import { MODEL_DEALS } from "../src/deals/catalog.js"
import { MODEL_EFFORTS } from "../src/provider/reasoning.js"
import { MODEL_COSTS } from "../src/provider/pricing.js"
import { MODEL_INPUT_MODALITIES } from "../src/provider/modalities.js"
import { assert, assertEqual, run } from "./harness.js"

// Every generated catalog key set — a literal id is "real" when any of these
// contains it. Checked live, so this gate tracks upstream churn for free.
const GENERATED_ID_SETS: ReadonlyArray<readonly string[]> = [
  Object.keys(MODEL_EFFORTS),
  Object.keys(MODEL_COSTS),
  Object.keys(MODEL_INPUT_MODALITIES),
  Object.keys(MODEL_REASONING_CAPABILITY),
  Object.keys(MODEL_DEALS),
  MODEL_SNAPSHOT.map((model) => model.id),
]

const GENERATED_IDS: ReadonlySet<string> = new Set(GENERATED_ID_SETS.flat())

// The literal-id access patterns that re-type upstream values when combined
// with a real id. Kept narrow and quote-shape-agnostic; template literals
// with interpolation are NOT matched (they are the derivation style).
const ACCESS_PATTERNS: readonly RegExp[] = [
  /\b(?:MODEL_COSTS|MODEL_EFFORTS|MODEL_INPUT_MODALITIES|MODEL_REASONING_CAPABILITY|MODEL_DEALS)\s*\[\s*["'`]([^"'`\\]+)["'`]\s*\]/g,
  /\b(?:reasoningVariantsForModel|thinkingMetadataForModel|isReasoningModel|inputModalitiesForModel)\s*\(\s*["'`]([^"'`\\]+)["'`]\s*\)/g,
]

// Justified exceptions. The bar: the test asserts a *join* between its own
// fixture and the generated data — breaking it means a real contract broke,
// not that upstream moved a value. Every entry names its reason; a reviewer
// of this file should be able to judge each one without archaeology.
const ALLOWLIST: ReadonlyArray<{ file: string; id: string; justification: string }> = []

function lintTests(): ReadonlyArray<string> {
  const findings: string[] = []
  const testsDir = "tests"
  for (const entry of readdirSync(testsDir)) {
    if (!entry.endsWith(".test.ts")) continue
    const path = join(testsDir, entry)
    const text = readFileSync(path, "utf-8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of ACCESS_PATTERNS) {
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(lines[i])) !== null) {
          const id = match[1]
          if (!GENERATED_IDS.has(id)) continue
          const allowed = ALLOWLIST.some(
            (entry) => entry.file === entry_name(path) && entry.id === id,
          )
          if (allowed) continue
          findings.push(`${path}:${i + 1}: literal pin of generated model id "${id}"`)
        }
      }
    }
  }
  return findings
}

// Helper so the allowlist comparison uses repo-relative paths consistently.
function entry_name(path: string): string {
  return path.replaceAll("\\", "/")
}

run([
  [
    "no test pins a literal generated model id against the upstream-owned catalogs",
    () => {
      const findings = lintTests()
      assertEqual(
        findings,
        [],
        [
          "upstream-value pins found (spec #108: value changes surface as",
          "refresh-PR diffs, never as red tests). Derive the id from the",
          "generated catalogs instead, use a synthetic id, or — only for a",
          "genuine fixture-vs-catalog join contract — add a justified",
          "ALLOWLIST entry in tests/no-upstream-value-pins.test.ts.",
        ].join(" "),
      )
    },
  ],
  [
    "the lint gate itself can smell the pattern it forbids",
    () => {
      // Sensitivity check: the detector must fire on the exact pattern that
      // broke the 2026-09-03 cron, so a future detector regression cannot
      // silently re-open the failure class.
      const probe = `const c = MODEL_COSTS["${[...GENERATED_IDS][0]}"]`
      const pattern = ACCESS_PATTERNS[0]
      pattern.lastIndex = 0
      assert(pattern.test(probe), "the access pattern must match a generated-catalog lookup")
    },
  ],
])
