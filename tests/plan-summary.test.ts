// tests/plan-summary.test.ts — plan resolution + summary rendering
import { resolvePlan, renderPlanSummary, normalizePlan } from "../src/plugin/plan-summary.js"
import { MODEL_DEALS, PLAN_CATALOG } from "../src/catalog/deals.js"
import { assert, assertEqual, run } from "./harness.js"

const OFFLINE_ENV: NodeJS.ProcessEnv = {} // no key → no network attempt

run([
  [
    "normalizePlan maps plan ids and unknown values to undefined",
    () => {
      assertEqual(normalizePlan("go"), "go")
      assertEqual(normalizePlan("individual-goat"), "goat")
      assertEqual(normalizePlan("individual-pro-v1"), "pro")
      assertEqual(normalizePlan("individual-max"), "max")
      assertEqual(normalizePlan("individual-ultra"), "max20")
      assertEqual(normalizePlan("team-pro"), "teampro")
      assertEqual(normalizePlan("Team Pro"), "teampro")
      assertEqual(normalizePlan("individual-provider"), "provider")
      assertEqual(normalizePlan("teams-pro"), undefined)
      assertEqual(normalizePlan(42), undefined)
      assertEqual(normalizePlan(undefined), undefined)
    },
  ],

  [
    "resolvePlan: arg beats env beats default",
    async () => {
      assertEqual(await resolvePlan("goat", OFFLINE_ENV), "goat")
      assertEqual(await resolvePlan("pro", { COMMANDCODE_PLAN: "goat" }), "pro")
      assertEqual(await resolvePlan(undefined, { COMMANDCODE_PLAN: "max20" }), "max20")
      assertEqual(await resolvePlan(undefined, OFFLINE_ENV), "go")
    },
  ],

  [
    "resolvePlan: unknown env value falls back to default",
    async () => {
      assertEqual(await resolvePlan(undefined, { COMMANDCODE_PLAN: "bogus" }), "go")
    },
  ],

  [
    "resolvePlan falls back to default when whoami is unreachable",
    async () => {
      assertEqual(
        await resolvePlan(undefined, {
          COMMANDCODE_API_KEY: "k",
          COMMANDCODE_API_BASE: "http://127.0.0.1:1",
        }),
        "go",
      )
    },
  ],

  [
    "renderPlanSummary shows plan info and per-model allowances",
    () => {
      const out = renderPlanSummary("goat", MODEL_DEALS, PLAN_CATALOG)
      assert(out.includes("GOAT"), "must name the plan")
      assert(out.includes("$70"), "must show plan credits")
      assert(out.includes("$14"), "must show 5h window")
      assert(out.includes("$35"), "must show weekly window")
      assert(out.includes("Qwen/Qwen3.8-27B"), "must list an allowed model")
      assert(out.includes("23,972"), "must show the Qwen monthly request estimate")
      assert(out.includes("| $70 |"), "must show the Qwen allowance")
      assert(out.includes("50%"), "must show the Gemini discount")
      assert(out.includes("free"), "must mention free models")
      assert(out.includes("pricing-limits"), "must link the pricing page")
    },
  ],

  [
    "renderPlanSummary handles empty deals gracefully",
    () => {
      const out = renderPlanSummary("goat", {}, PLAN_CATALOG)
      assert(out.includes("GOAT"), "must still name the plan")
      assert(out.includes("No deal data"), "must degrade gracefully")
    },
  ],

  [
    "renderPlanSummary handles the provider plan (no windows)",
    () => {
      const out = renderPlanSummary("provider", MODEL_DEALS, PLAN_CATALOG)
      assert(out.includes("Provider"), "must name the plan")
      assert(out.includes("pay-as-you-go"), "must note PAYG")
    },
  ],

  [
    "renderPlanSummary shows deals instead of allowances for Max plans",
    () => {
      const out = renderPlanSummary("max", MODEL_DEALS, PLAN_CATALOG)
      assert(out.includes("Max 10×"), "must name the plan")
      assert(out.includes("no per-model allowances"), "must be honest about max")
      assert(out.includes("Deal"), "must show a deal column")
      assert(out.includes("98% off"), "must list the MiMo deal")
    },
  ],

  [
    "renderPlanSummary names Team Pro from the catalog",
    () => {
      const out = renderPlanSummary("teampro", MODEL_DEALS, PLAN_CATALOG)
      assert(out.includes("Team Pro"), "must name the plan")
      assert(out.includes("$40"), "must show Team Pro price")
      assert(out.includes("no per-model allowances"), "must be honest about Team Pro")
    },
  ],
])
