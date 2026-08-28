// tests/reasoning.test.ts — reasoning-effort metadata tables (PLAN #5 Part A,
// port of pi's test-models.ts reasoning subset)
import {
  MODEL_EFFORTS,
  isReasoningModel,
  mappedReasoningEffort,
  reasoningVariantsForModel,
  resolveProviderReasoning,
  thinkingMetadataForModel,
} from "../src/provider/reasoning.js"
import { assert, assertEqual, run } from "./harness.js"

run([
  [
    "known reasoning models expose an effort map",
    () => {
      const meta = thinkingMetadataForModel("claude-sonnet-5")
      assert(meta, "expected metadata")
      assertEqual(meta.thinking.mode, "effort")
      assertEqual(meta.thinkingLevelMap.high, "high")
      assertEqual(meta.thinkingLevelMap.minimal, null)
    },
  ],

  [
    "unknown models have no metadata",
    () => {
      assertEqual(thinkingMetadataForModel("brand-new/model"), undefined)
      assertEqual(isReasoningModel("brand-new/model"), false)
      assertEqual(isReasoningModel("claude-sonnet-5"), true)
    },
  ],

  [
    "mappedReasoningEffort maps through the effort map",
    () => {
      const model = {
        reasoning: true,
        thinkingLevelMap: { high: "high", max: "max" } as Record<string, string | null>,
      }
      assertEqual(mappedReasoningEffort(model, { reasoning: "high" }), "high")
      assertEqual(mappedReasoningEffort(model, { reasoning: "minimal" }), undefined)
      assertEqual(mappedReasoningEffort(model, { reasoning: "off" }), undefined)
      assertEqual(mappedReasoningEffort(model, undefined), undefined)
    },
  ],

  [
    "non-reasoning models never map effort",
    () => {
      const model = { reasoning: false, thinkingLevelMap: {} as Record<string, string | null> }
      assertEqual(mappedReasoningEffort(model, { reasoning: "high" }), undefined)
    },
  ],

  [
    "resolveProviderReasoning reads the provider-namespaced AI SDK v3 shape",
    () => {
      assertEqual(
        resolveProviderReasoning({ commandcode: { reasoningEffort: "high" } }, "commandcode"),
        "high",
      )
      assertEqual(
        resolveProviderReasoning({ commandcode: { reasoning: "max" } }, "commandcode"),
        "max",
      )
    },
  ],

  [
    "resolveProviderReasoning falls back to the top-level shape",
    () => {
      assertEqual(resolveProviderReasoning({ reasoningEffort: "high" }, "commandcode"), "high")
      assertEqual(resolveProviderReasoning({ reasoning: "high" }, "commandcode"), "high")
    },
  ],

  [
    "resolveProviderReasoning ignores other provider namespaces",
    () => {
      assertEqual(
        resolveProviderReasoning({ claude: { reasoningEffort: "max" } }, "commandcode"),
        undefined,
      )
      assertEqual(resolveProviderReasoning(undefined, "commandcode"), undefined)
      assertEqual(resolveProviderReasoning(null, "commandcode"), undefined)
    },
  ],

  [
    "MODEL_EFFORTS table is consistent",
    () => {
      for (const [id, efforts] of Object.entries(MODEL_EFFORTS)) {
        assert(id.length > 0, "model id must be non-empty")
        assert(efforts.length > 0, `${id} must list at least one effort`)
        for (const e of efforts) {
          assert(e !== "off", `${id} must not list "off" as an effort`)
        }
      }
    },
  ],

  [
    "reasoningVariantsForModel exposes one variant per supported effort",
    () => {
      const variants = reasoningVariantsForModel("deepseek/deepseek-v4-flash")
      assert(variants, "expected variants")
      assertEqual(Object.keys(variants), ["high", "max"])
      assertEqual(variants.high, { reasoningEffort: "high" })
      assertEqual(variants.max, { reasoningEffort: "max" })
    },
  ],

  [
    "Hy4 exposes the five effort values accepted by the Provider API",
    () => {
      const variants = reasoningVariantsForModel("tencent/hy4-preview")
      assert(variants, "expected Hy4 variants")
      assertEqual(Object.keys(variants), ["low", "medium", "high", "xhigh", "max"])
      assertEqual(variants.low, { reasoningEffort: "low" })
      assertEqual(variants.max, { reasoningEffort: "max" })
    },
  ],

  [
    "reasoningVariantsForModel is empty for non-reasoning models",
    () => {
      assertEqual(reasoningVariantsForModel("brand-new/model"), undefined)
    },
  ],
])
