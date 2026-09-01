// tests/catalog-metadata.test.ts — catalog-wide metadata coverage (issue #22).
//
// Capability facts (reasoning efforts + per-1M-token rates) come from
// `src/catalog/facts.ts`, generated from the command-code npm package's
// bundled models.md (see FACTS_SOURCE_URL / FACTS_PACKAGE_VERSION in that
// file). These tests guarantee every snapshot model resolves capability + cost
// metadata instead of silently falling back to text-only / no-reasoning /
// zero-cost. Reasoning classification remains a hand-maintained set because
// Command Code can advertise reasoning without explicit effort levels;
// modalities are generated from the CLI bundle's inputModalities fields.
// The remaining classification fixtures are ports of Command Code's published pages
// (https://commandcode.ai/docs/resources/pricing-limits and
// https://commandcode.ai/docs/reference/cli/models).
//
// **Self-sustainability note (catalog-refresh cron, issue #89).** The
// `EFFORTS_MODELS` test set is **auto-derived from `MODEL_EFFORTS`**
// (the generated catalog facts) — the npm package's models.md is the
// source of truth for which models expose effort levels, and the
// facts are regenerated on every cron run. When Command Code adds a
// new model with explicit efforts (e.g. deepseek/deepseek-v4-flash-fast
// on 2026-08-31), it lands in `MODEL_EFFORTS` on the next refresh and
// the reasoning-classification test follows automatically; no human
// pin update required.
//
// The two hand-maintained sets remain:
//   - `REASONING_MODELS` (src): reasoning-capable models with no
//     explicit effort levels. This is a real classification decision
//     — Command Code picks the depth and we don't expose variants.
//   - `NON_REASONING_MODELS` (test): a documentation set of models
//     the docs page explicitly lists as non-reasoning. It's
//     advisory; a model NOT in this set is treated as
//     "default non-reasoning" for the purposes of the "exactly
//     once" check below.
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { MODEL_INPUT_MODALITIES, inputModalitiesForModel } from "../src/provider/modalities.js"
import { MODEL_EFFORTS, REASONING_MODELS, isReasoningModel } from "../src/provider/reasoning.js"
import { MODEL_COSTS } from "../src/provider/pricing.js"
import { assert, assertEqual, run } from "./harness.js"

// The free variant list is checked at "every snapshot model has a
// cost entry" — it tells the test that a model missing from MODEL_COSTS
// is genuinely free, not just a cost-entry miss. Stale entries
// (models removed from the snapshot between two releases) are
// harmless because the test iterates over MODEL_SNAPSHOT, not over
// the set, and a stale entry simply isn't visited.
const FREE_MODELS = new Set([
  "minimax/minimax-m2.7-free",
  "minimax/minimax-m3-free",
  "poolside/laguna-s-2.1-free",
])

// Models Command Code advertises as reasoning-capable but with no explicit
// effort levels (Command Code picks the depth). These must advertise
// reasoning without generating variants; the production REASONING_MODELS set
// doubles as the test fixture.

// Models Command Code does not advertise as reasoning-capable (no effort
// levels and no reasoning flag on the model page). This is an
// *advisory* list — the test below treats any model absent from
// `MODEL_EFFORTS` and `REASONING_MODELS` as non-reasoning by
// default, so a new non-reasoning model added to the snapshot does
// not break the suite.
const NON_REASONING_MODELS = new Set([
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "zai-org/GLM-5.2-Fast",
  "zai-org/GLM-5.1",
  "zai-org/GLM-5",
  "MiniMaxAI/MiniMax-M2.7",
  "MiniMaxAI/MiniMax-M2.5",
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5",
  "stepfun/Step-3.5-Flash",
  "claude-haiku-4-5-20251001",
])

// EFFORTS_MODELS is auto-derived from the generated `MODEL_EFFORTS` so
// the test tracks upstream package changes without a manual pin
// update. The npm package's models.md is the source of truth for
// which models expose effort levels; the catalog-refresh cron
// regenerates the facts on every run.
const EFFORTS_MODELS = new Set(Object.keys(MODEL_EFFORTS))

run([
  [
    "every snapshot model has a cost entry (or is free)",
    () => {
      for (const model of MODEL_SNAPSHOT) {
        const costs = MODEL_COSTS[model.id]
        if (FREE_MODELS.has(model.id)) {
          assert(costs && costs.input === 0 && costs.output === 0, model.id)
          continue
        }
        assert(costs, `missing cost for ${model.id}`)
        assert(costs.input > 0 || costs.output > 0, `zero-cost entry for ${model.id}`)
      }
    },
  ],

  [
    "muse-spark-1.2-contributor pricing matches the published rates",
    () => {
      // Live page (2026-08-19): In $0.100 / Out $0.200 / Cache $0.0020, and no
      // cache-write rate is published (shown as "—"), so cacheWrite stays 0.
      assertEqual(MODEL_COSTS["meta/muse-spark-1.2-contributor"], {
        input: 0.1,
        output: 0.2,
        cacheRead: 0.002,
        cacheWrite: 0,
      })
    },
  ],

  [
    "muse-spark-1.1/1.2 pricing matches the published rates",
    () => {
      assertEqual(MODEL_COSTS["meta/muse-spark-1.1"], {
        input: 1.25,
        output: 4.25,
        cacheRead: 0.15,
        cacheWrite: 0,
      })
      assertEqual(MODEL_COSTS["meta/muse-spark-1.2"], {
        input: 1.25,
        output: 4.25,
        cacheRead: 0.15,
        cacheWrite: 0,
      })
    },
  ],

  [
    "generated modality facts advertise image input and keep text fallback",
    () => {
      for (const model of MODEL_SNAPSHOT) {
        const modalities = inputModalitiesForModel(model.id)
        assertEqual(
          modalities.includes("text"),
          true,
          `${model.id}: expected text input, got ${JSON.stringify(modalities)}`,
        )
        assert(modalities.every((modality) => modality === "text" || modality === "image"))
      }
      assertEqual(inputModalitiesForModel("Qwen/Qwen3.8-27B"), ["text", "image"])
      assertEqual(inputModalitiesForModel("google/gemini-3.7-flash"), ["text", "image"])
      assertEqual(inputModalitiesForModel("xai/grok-4.6"), ["text"])
    },
  ],

  [
    "MODEL_INPUT_MODALITIES has no stale entries outside the snapshot",
    () => {
      const snapshotIds = new Set(MODEL_SNAPSHOT.map((model) => model.id))
      for (const id of Object.keys(MODEL_INPUT_MODALITIES)) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot`)
      }
    },
  ],

  [
    "MODEL_COSTS has no stale entries outside the snapshot",
    () => {
      const snapshotIds = new Set(MODEL_SNAPSHOT.map((model) => model.id))
      for (const id of Object.keys(MODEL_COSTS)) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot`)
      }
    },
  ],

  [
    "reasoning classification matches the published catalog (auto-efforts, default non-reasoning)",
    () => {
      // The classification contract:
      //   - in MODEL_EFFORTS (auto, the npm package's models.md is
      //     the source of truth) → "efforts" model
      //   - in REASONING_MODELS (hand-maintained in
      //     src/provider/reasoning.ts) → "reasoning without
      //     efforts" model
      //   - otherwise → "non-reasoning" by default (a model can also
      //     appear in NON_REASONING_MODELS for documentation; the set
      //     is advisory)
      //   - a model MUST NOT be in both MODEL_EFFORTS and
      //     REASONING_MODELS (misclassification, see
      //     `tencent/hy4-preview` below)
      for (const model of MODEL_SNAPSHOT) {
        const hasEfforts = EFFORTS_MODELS.has(model.id)
        const reasoningWithoutEfforts = REASONING_MODELS.has(model.id)
        const inNonReasoning = NON_REASONING_MODELS.has(model.id)
        assert(
          !(hasEfforts && reasoningWithoutEfforts),
          `${model.id}: in MODEL_EFFORTS and REASONING_MODELS — move to one set`,
        )
        // isReasoningModel must agree with the union of
        // MODEL_EFFORTS + REASONING_MODELS (the same union the
        // src-side isReasoningModel computes).
        assertEqual(isReasoningModel(model.id), hasEfforts || reasoningWithoutEfforts, model.id)
        // isReasoningModel must NOT classify a model the docs say is
        // explicitly non-reasoning. NON_REASONING_MODELS is
        // advisory, so the check is "if it's in the set, it must
        // not be a reasoning model" — the reverse is fine.
        if (inNonReasoning) {
          assertEqual(
            isReasoningModel(model.id),
            false,
            `${model.id}: listed as non-reasoning but isReasoningModel returns true`,
          )
        }
      }
    },
  ],

  [
    "muse-spark models are reasoning-capable without variants",
    () => {
      assertEqual(isReasoningModel("meta/muse-spark-1.2-contributor"), true)
      assertEqual(MODEL_EFFORTS["meta/muse-spark-1.2-contributor"], undefined)
      assertEqual(isReasoningModel("meta/muse-spark-1.2"), true)
      assertEqual(MODEL_EFFORTS["meta/muse-spark-1.2"], undefined)
      assertEqual(isReasoningModel("meta/muse-spark-1.1"), true)
      assertEqual(MODEL_EFFORTS["meta/muse-spark-1.1"], undefined)
    },
  ],

  [
    "tencent/hy4-preview is an efforts model (locks the spec example from the classifier history)",
    () => {
      // Added 2026-08-28 (command-code@1.37.0): live RSC caps.reasoning=true
      // with no explicit Efforts entry, classified as REASONING_MODELS.
      // command-code@1.38.0 (same day) added `low, medium, high` to the
      // Efforts column, so the model now belongs in MODEL_EFFORTS and must
      // be removed from REASONING_MODELS. The "classified exactly once"
      // invariant above fails if a model is in both — keeping this
      // dedicated pin so the test's intent is obvious from the
      // assertion alone.
      assertEqual(isReasoningModel("tencent/hy4-preview"), true)
      assertEqual(MODEL_EFFORTS["tencent/hy4-preview"], ["low", "medium", "high"])
    },
  ],

  [
    "no reasoning entry references a model outside the snapshot",
    () => {
      // The auto-derived EFFORTS_MODELS and the src-side
      // REASONING_MODELS / MODEL_EFFORTS are the only places a
      // snapshot model is "named as reasoning-capable" — they
      // must all stay in sync with the snapshot. The
      // NON_REASONING_MODELS advisory set is also checked, since
      // stale entries would mask a future isReasoningModel flip.
      const snapshotIds = new Set(MODEL_SNAPSHOT.map((model) => model.id))
      for (const id of Object.keys(MODEL_EFFORTS)) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot (MODEL_EFFORTS stale)`)
      }
      for (const id of REASONING_MODELS) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot (REASONING_MODELS stale)`)
      }
      for (const id of NON_REASONING_MODELS) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot (NON_REASONING_MODELS stale)`)
      }
    },
  ],
])
