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
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { MODEL_INPUT_MODALITIES, inputModalitiesForModel } from "../src/provider/modalities.js"
import { MODEL_EFFORTS, REASONING_MODELS, isReasoningModel } from "../src/provider/reasoning.js"
import { MODEL_COSTS } from "../src/provider/pricing.js"
import { assert, assertEqual, run } from "./harness.js"

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
// levels and no reasoning flag on the model page).
const NON_REASONING_MODELS = new Set([
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "zai-org/GLM-5.2-Fast",
  "zai-org/GLM-5.1",
  "zai-org/GLM-5",
  "MiniMaxAI/MiniMax-M2.7",
  "minimax/minimax-m2.7-free",
  "MiniMaxAI/MiniMax-M2.5",
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5",
  "stepfun/Step-3.5-Flash",
  "claude-haiku-4-5-20251001",
])

// Models Command Code advertises with explicit reasoning efforts.
const EFFORTS_MODELS = new Set([
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "z-ai/glm-5.3-flash",
  "zai-org/GLM-5.3",
  "zai-org/GLM-5.2",
  "Qwen/Qwen3.8-Max",
  "Qwen/Qwen3.8-27B",
  "Qwen/Qwen3.8-Flash",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "google/gemini-3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "sakana/fugu-ultra",
  "xai/grok-4.5",
  "xai/grok-4.6",
])

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
    "reasoning classification matches the published catalog",
    () => {
      for (const model of MODEL_SNAPSHOT) {
        const hasEfforts = EFFORTS_MODELS.has(model.id)
        const reasoningWithoutEfforts = REASONING_MODELS.has(model.id)
        const nonReasoning = NON_REASONING_MODELS.has(model.id)
        assert(
          [hasEfforts, reasoningWithoutEfforts, nonReasoning].filter(Boolean).length === 1,
          `${model.id}: must be classified exactly once`,
        )
        assertEqual(isReasoningModel(model.id), hasEfforts || reasoningWithoutEfforts, model.id)
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
    "tencent/hy4-preview is reasoning-capable without variants",
    () => {
      // New upstream model (added 2026-08-28): live RSC caps.reasoning is
      // true and models.md lists no Efforts entry, so it belongs in
      // REASONING_MODELS with no MODEL_EFFORTS — mirrors the muse-spark
      // classification above.
      assertEqual(isReasoningModel("tencent/hy4-preview"), true)
      assertEqual(MODEL_EFFORTS["tencent/hy4-preview"], undefined)
    },
  ],

  [
    "no reasoning entry references a model outside the snapshot",
    () => {
      const snapshotIds = new Set(MODEL_SNAPSHOT.map((model) => model.id))
      for (const id of Object.keys(MODEL_EFFORTS)) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot`)
      }
      for (const id of REASONING_MODELS) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot`)
      }
      for (const id of NON_REASONING_MODELS) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot`)
      }
      for (const id of EFFORTS_MODELS) {
        assert(snapshotIds.has(id), `${id} is not in the snapshot`)
      }
    },
  ],
])
