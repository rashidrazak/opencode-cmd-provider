// tests/reasoning.test.ts — reasoning-effort metadata tables (PLAN #5 Part A,
// port of pi's test-models.ts reasoning subset)
import {
  MODEL_EFFORTS,
  isReasoningModel,
  mappedReasoningEffort,
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
])
