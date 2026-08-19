// tests/catalog-metadata.test.ts — catalog-wide metadata coverage (issue #22).
//
// The modality, reasoning, and pricing tables are hand-maintained ports of
// Command Code's published catalog. These tests guarantee every snapshot model
// resolves capability + cost metadata instead of silently falling back to
// text-only / no-reasoning / zero-cost.
//
// Source: https://commandcode.ai/docs/resources/pricing-limits and
// https://commandcode.ai/docs/reference/cli/models — pricing rows added by #22
// verified against those pages on 2026-08-19 (see PRICING_LAST_VERIFIED).
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { MODEL_INPUT_MODALITIES, inputModalitiesForModel } from "../src/provider/modalities.js"
import { MODEL_EFFORTS, REASONING_MODELS, isReasoningModel } from "../src/provider/reasoning.js"
import { MODEL_COSTS } from "../src/provider/pricing.js"
import { assert, assertEqual, run } from "./harness.js"

const FREE_MODELS = new Set(["poolside/laguna-s-2.1-free"])

const VISION_MODELS = new Set([
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "moonshotai/Kimi-K3",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "MiniMaxAI/MiniMax-M3",
  "Qwen/Qwen3.8-Max",
  "Qwen/Qwen3.8-27B",
  "Qwen/Qwen3.7-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.6-Plus",
  "stepfun/Step-3.7-Flash",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
  "google/gemini-3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "sakana/fugu-ultra",
  "meta/muse-spark-1.1",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
  "xai/grok-4.5",
  "xiaomi/mimo-v2.5",
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
  "zai-org/GLM-5.3",
  "zai-org/GLM-5.2",
  "Qwen/Qwen3.8-Max",
  "Qwen/Qwen3.8-27B",
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
    "vision models advertise image input; others stay text-only",
    () => {
      for (const model of MODEL_SNAPSHOT) {
        const expectsImage = VISION_MODELS.has(model.id)
        assertEqual(
          inputModalitiesForModel(model.id).includes("image"),
          expectsImage,
          `${model.id}: expected image=${expectsImage}, got ${JSON.stringify(inputModalitiesForModel(model.id))}`,
        )
      }
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
