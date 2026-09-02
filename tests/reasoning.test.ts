// tests/reasoning.test.ts — reasoning-effort metadata tables (PLAN #5 Part A,
// port of pi's test-models.ts reasoning subset)
import {
  MODEL_EFFORTS,
  deriveReasoningWithoutEfforts,
  isReasoningModel,
  mappedReasoningEffort,
  reasoningVariantsForModel,
  resolveProviderReasoning,
  thinkingMetadataForModel,
} from "../src/provider/reasoning.js"
import { assert, assertEqual, run } from "./harness.js"

run([
  [
    "deriveReasoningWithoutEfforts: an efforts model never appears in the derived set (efforts precedence)",
    () => {
      // Synthetic inputs over the public derivation export — the exact-once
      // invariant holds by construction (issue #111), so the derivation
      // check is locked with synthetic records rather than a
      // post-regeneration cron gate.
      const derived = deriveReasoningWithoutEfforts(
        { "a/model": true, "b/model": true, "c/model": false },
        { "b/model": ["high", "max"] },
      )
      assert(derived.has("a/model"), "capability flag without efforts must be derived")
      assert(
        !derived.has("b/model"),
        "an efforts model must never appear in the reasoning-without-efforts set",
      )
      assert(!derived.has("c/model"), "a false capability flag is never reasoning")
    },
  ],

  [
    "deriveReasoningWithoutEfforts: a capability-flag model without efforts yields reasoning without variants",
    () => {
      // The derived-set member has no efforts entry, so through the public
      // exports it must advertise reasoning with NO variants (`reasoning:
      // true` and no `variants` map is the reasoning-without-efforts
      // behavior opencode sees).
      const capability = { "a/model": true }
      const derived = deriveReasoningWithoutEfforts(capability, {})
      assert(derived.has("a/model"))
      assertEqual(reasoningVariantsForModel("a/model"), undefined)
      assertEqual(
        isReasoningModel("a/model"),
        false,
        "synthetic ids are not in the real generated data",
      )
    },
  ],

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
    "reasoningVariantsForModel is empty for non-reasoning models",
    () => {
      assertEqual(reasoningVariantsForModel("brand-new/model"), undefined)
    },
  ],
])
