// tests/extract-catalog.test.ts — unit tests for the command-code bundle
// catalog parser used by refresh-snapshot.mjs --tables
import { extractCatalog } from "../scripts/lib/extract-catalog.mjs"
import { assert, assertEqual, run } from "./harness.js"

function bundleOf(entries) {
  // Emulates the minified shape: KEY:{id:"...",inputModalities:[...],...}
  return entries.join(",")
}

run([
  [
    "extracts id, modalities, and efforts from a single entry",
    () => {
      const models = extractCatalog(
        bundleOf([
          'GLM_5_3:{id:"zai-org/GLM-5.3",inputModalities:["text"],provider:KA,spec:JA,reasoning:!0,reasoningEfforts:["low","high","max"],contextWindow:1e6}',
        ]),
      )
      assertEqual(models.length, 1)
      assertEqual(models[0].id, "zai-org/GLM-5.3")
      assertEqual(models[0].inputModalities, ["text"])
      assertEqual(models[0].reasoningEfforts, ["low", "high", "max"])
    },
  ],

  [
    "never attributes the next entry's reasoningEfforts to the previous model",
    () => {
      // Regression: Kimi K2.5 has no reasoningEfforts and GLM-5.3 follows it.
      // An unbounded lookahead read GLM-5.3's efforts into Kimi K2.5.
      const models = extractCatalog(
        bundleOf([
          'KIMI_K2_5:{id:"moonshotai/Kimi-K2.5",inputModalities:["text","image"],provider:KA,spec:JA,label:"Kimi K2.5",contextWindow:256e3}',
          'GLM_5_3:{id:"zai-org/GLM-5.3",inputModalities:["text"],provider:KA,spec:JA,reasoning:!0,reasoningEfforts:["low","high","max"],contextWindow:1e6}',
        ]),
      )
      assertEqual(models.length, 2)
      const kimi = models.find((model) => model.id === "moonshotai/Kimi-K2.5")
      assert(kimi, "expected Kimi K2.5")
      assertEqual(kimi.reasoningEfforts, [])
      const glm = models.find((model) => model.id === "zai-org/GLM-5.3")
      assert(glm, "expected GLM-5.3")
      assertEqual(glm.reasoningEfforts, ["low", "high", "max"])
    },
  ],

  [
    "duplicate ids keep the entry that carries reasoningEfforts",
    () => {
      const models = extractCatalog(
        bundleOf([
          'HAIKU_4_5:{id:"claude-haiku-4-5-20251001",inputModalities:["text","image"],provider:"anthropic",spec:"chatComplete",contextWindow:2e5}',
          'HAIKU_4_5_ALT:{id:"claude-haiku-4-5-20251001",inputModalities:["text","image"],provider:FA,spec:JA,reasoning:!0,reasoningEfforts:["low","high"],contextWindow:2e5}',
        ]),
      )
      assertEqual(models.length, 1)
      assertEqual(models[0].reasoningEfforts, ["low", "high"])
    },
  ],

  [
    "returns models sorted by id",
    () => {
      const models = extractCatalog(
        bundleOf([
          'B:{id:"zai-org/GLM-5.2",inputModalities:["text"],reasoningEfforts:["high","max"]}',
          'A:{id:"Qwen/Qwen3.8-27B",inputModalities:["text","image"],reasoningEfforts:["low","medium","xhigh"]}',
        ]),
      )
      assertEqual(
        models.map((model) => model.id),
        ["Qwen/Qwen3.8-27B", "zai-org/GLM-5.2"],
      )
    },
  ],

  [
    "empty modality arrays parse to empty lists",
    () => {
      const models = extractCatalog(
        bundleOf(['A:{id:"some/model",inputModalities:[],note:"degenerate but tolerated"}']),
      )
      assertEqual(models[0].inputModalities, [])
      assertEqual(models[0].reasoningEfforts, [])
    },
  ],

  [
    "rejects unknown modality values loudly",
    () => {
      let threw = undefined
      try {
        extractCatalog(bundleOf(['A:{id:"some/model",inputModalities:["text","audio"]}']))
      } catch (error) {
        threw = error
      }
      assert(threw instanceof Error, "expected a thrown Error")
      assert(
        threw.message.includes("audio"),
        `expected the message to name the bad value, got: ${threw.message}`,
      )
    },
  ],

  [
    "rejects unknown effort values loudly",
    () => {
      let threw = undefined
      try {
        extractCatalog(
          bundleOf(['A:{id:"some/model",inputModalities:["text"],reasoningEfforts:["ultra"]}']),
        )
      } catch (error) {
        threw = error
      }
      assert(threw instanceof Error, "expected a thrown Error")
      assert(
        threw.message.includes("ultra"),
        `expected the message to name the bad value, got: ${threw.message}`,
      )
    },
  ],

  [
    "fails when no catalog entries are found",
    () => {
      let threw = undefined
      try {
        extractCatalog("const x = 1; no models here")
      } catch (error) {
        threw = error
      }
      assert(threw instanceof Error, "expected a thrown Error")
    },
  ],
])
