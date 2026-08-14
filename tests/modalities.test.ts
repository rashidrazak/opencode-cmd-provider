// tests/modalities.test.ts — image input modality table (PLAN #5 Part B, port
// of pi's test-models.ts modality subset)
import {
  MODEL_INPUT_MODALITIES,
  inputModalitiesForModel,
  modelSupportsImageInput,
} from "../src/provider/modalities.js"
import { assert, assertEqual, run } from "./harness.js"

run([
  ["known vision models support image input", () => {
    assertEqual(modelSupportsImageInput("claude-sonnet-5"), true)
    assertEqual(modelSupportsImageInput("gpt-5.4"), true)
  }],

  ["unknown models default to text-only", () => {
    assertEqual(modelSupportsImageInput("brand-new/model"), false)
    assertEqual(inputModalitiesForModel("brand-new/model"), ["text"])
  }],

  ["text-only model rejects image gating", () => {
    const unknown = "some/text-only-model"
    assertEqual(modelSupportsImageInput(unknown), false)
  }],

  ["MODEL_INPUT_MODALITIES table is consistent", () => {
    for (const modalities of Object.values(MODEL_INPUT_MODALITIES)) {
      assert(Array.isArray(modalities))
      for (const m of modalities) {
        assert(m === "text" || m === "image")
      }
    }
  }],
])
