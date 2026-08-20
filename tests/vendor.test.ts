// tests/vendor.test.ts — model id → vendor family mapping (deals enrichment)
import { vendorFamilyForModel } from "../src/plugin/vendor.js"
import { assertEqual, run } from "./harness.js"

run([
  [
    "maps known id namespaces to families",
    () => {
      assertEqual(vendorFamilyForModel("claude-sonnet-5"), "claude")
      assertEqual(vendorFamilyForModel("gpt-5.6-sol"), "gpt")
      assertEqual(vendorFamilyForModel("google/gemini-3.7-flash"), "gemini")
      assertEqual(vendorFamilyForModel("deepseek/deepseek-v4-flash"), "deepseek")
      assertEqual(vendorFamilyForModel("Qwen/Qwen3.8-27B"), "qwen")
      assertEqual(vendorFamilyForModel("moonshotai/Kimi-K3"), "kimi")
      assertEqual(vendorFamilyForModel("zai-org/GLM-5.3"), "glm")
      assertEqual(vendorFamilyForModel("MiniMaxAI/MiniMax-M3"), "minimax")
      assertEqual(vendorFamilyForModel("xiaomi/mimo-v2.5"), "mimo")
      assertEqual(vendorFamilyForModel("stepfun/Step-3.7-Flash"), "step")
      assertEqual(vendorFamilyForModel("tencent/hy3-paid"), "tencent")
      assertEqual(vendorFamilyForModel("nvidia/nemotron-3-ultra-550b-a55b"), "nemotron")
      assertEqual(vendorFamilyForModel("thinkingmachines/inkling"), "inkling")
      assertEqual(vendorFamilyForModel("poolside/laguna-s-2.1-free"), "laguna")
      assertEqual(vendorFamilyForModel("meta/muse-spark-1.2"), "muse")
      assertEqual(vendorFamilyForModel("xai/grok-4.6"), "grok")
      assertEqual(vendorFamilyForModel("sakana/fugu-ultra"), "sakana")
    },
  ],

  [
    "returns undefined for unknown ids",
    () => {
      assertEqual(vendorFamilyForModel("unknown/foo"), undefined)
      assertEqual(vendorFamilyForModel("gemini-flash"), undefined)
    },
  ],
])