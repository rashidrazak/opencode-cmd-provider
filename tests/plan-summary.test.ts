// tests/plan-summary.test.ts — plan resolution + summary rendering
import {
  resolvePlan,
  renderPlanSummary,
  normalizePlan,
  type PlanResolutionCache,
} from "../src/deals/plan-summary.js"
import { MODEL_DEALS, PLAN_CATALOG } from "../src/deals/catalog.js"
import { assert, assertEqual, run } from "./harness.js"

const OFFLINE_ENV: NodeJS.ProcessEnv = {} // no key → no network attempt

/** Stubs global fetch for the duration of fn (resolvePlan fetches whoami via the global). */
function withFetchStub(
  stub: (url: string, init: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<void> | void,
): Promise<void> {
  const prev = globalThis.fetch
  globalThis.fetch = stub as typeof fetch
  const p = Promise.resolve().then(() => fn() as unknown as Promise<void>)
  return p.finally(() => {
    globalThis.fetch = prev
  })
}

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
    "normalizePlan covers the transport alias set (issue #54)",
    () => {
      for (const [alias, expected] of [
        ["go", "go"],
        ["individual-go", "go"],
        ["goat", "goat"],
        ["individual-goat", "goat"],
        ["pro", "pro"],
        ["max", "max"],
        ["max10", "max"],
        ["max20", "max20"],
        ["ultra", "max20"],
        ["teampro", "teampro"],
        ["provider", "provider"],
      ] as const) {
        assertEqual(normalizePlan(alias), expected, `alias ${alias}`)
        assertEqual(normalizePlan(alias.toUpperCase()), expected, `alias ${alias} upper`)
      }
    },
  ],

  [
    "resolvePlan: defaultPlan flips the fallback — transport uses provider, Deals keeps go",
    async () => {
      assertEqual(await resolvePlan(undefined, OFFLINE_ENV), "go")
      assertEqual(
        await resolvePlan(undefined, OFFLINE_ENV, { defaultPlan: "provider" }),
        "provider",
      )
      // explicit resolutions are unaffected by the flip
      assertEqual(await resolvePlan("go", OFFLINE_ENV, { defaultPlan: "provider" }), "go")
      assertEqual(
        await resolvePlan(undefined, { COMMANDCODE_PLAN: "goat" }, { defaultPlan: "provider" }),
        "goat",
      )
    },
  ],

  [
    "resolvePlan: arg beats env, env beats whoami (whoami not fetched when env set)",
    async () => {
      assertEqual(await resolvePlan("goat", { COMMANDCODE_PLAN: "go" }), "goat")
      let whoamiFetches = 0
      await withFetchStub(
        async () => {
          whoamiFetches++
          return new Response(JSON.stringify({ planId: "goat" }), { status: 200 })
        },
        async () => {
          const env: NodeJS.ProcessEnv = {
            COMMANDCODE_PLAN: "go",
            COMMANDCODE_API_KEY: "k",
            COMMANDCODE_API_BASE: "http://mock",
          }
          assertEqual(await resolvePlan(undefined, env, { defaultPlan: "provider" }), "go")
          assertEqual(whoamiFetches, 0)
        },
      )
    },
  ],

  [
    "resolvePlan: whoami beats default; GET {base}/alpha/whoami with Bearer key (issue #54)",
    async () => {
      await withFetchStub(
        async (url, init) => {
          assertEqual(url, "http://mock/alpha/whoami")
          assertEqual((init.headers as Record<string, string>).authorization, "Bearer k")
          return new Response(JSON.stringify({ planId: "goat" }), { status: 200 })
        },
        async () => {
          const env: NodeJS.ProcessEnv = {
            COMMANDCODE_API_KEY: "k",
            COMMANDCODE_API_BASE: "http://mock",
          }
          assertEqual(await resolvePlan(undefined, env, { defaultPlan: "provider" }), "goat")
        },
      )
      // plan.id fallback shape; a resolved go stays go
      await withFetchStub(
        async () => new Response(JSON.stringify({ plan: { id: "go" } }), { status: 200 }),
        async () => {
          assertEqual(
            await resolvePlan(undefined, {
              COMMANDCODE_API_KEY: "k",
              COMMANDCODE_API_BASE: "http://mock",
            }),
            "go",
          )
        },
      )
    },
  ],

  [
    "resolvePlan: non-OK / rejected / unknown whoami falls through to the default, not go",
    async () => {
      await withFetchStub(
        async () => new Response("oops", { status: 500 }),
        async () => {
          assertEqual(
            await resolvePlan(
              undefined,
              { COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: "http://mock" },
              { defaultPlan: "provider" },
            ),
            "provider",
          )
        },
      )
      await withFetchStub(
        async () => {
          throw new Error("offline")
        },
        async () => {
          assertEqual(
            await resolvePlan(
              undefined,
              { COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: "http://mock" },
              { defaultPlan: "provider" },
            ),
            "provider",
          )
        },
      )
      await withFetchStub(
        async () => new Response(JSON.stringify({ planId: "bogus-plan" }), { status: 200 }),
        async () => {
          assertEqual(
            await resolvePlan(
              undefined,
              { COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: "http://mock" },
              { defaultPlan: "provider" },
            ),
            "provider",
          )
        },
      )
      // no key → no fetch at all
      let fetches = 0
      await withFetchStub(
        async () => {
          fetches++
          return new Response(JSON.stringify({ planId: "goat" }), { status: 200 })
        },
        async () => {
          assertEqual(
            await resolvePlan(undefined, OFFLINE_ENV, { defaultPlan: "provider" }),
            "provider",
          )
          assertEqual(fetches, 0)
        },
      )
    },
  ],

  [
    "resolvePlan: whoami fetched at most once per cache object (reused across calls)",
    async () => {
      let fetches = 0
      const cache: PlanResolutionCache = {}
      await withFetchStub(
        async () => {
          fetches++
          return new Response(JSON.stringify({ planId: "goat" }), { status: 200 })
        },
        async () => {
          const env: NodeJS.ProcessEnv = {
            COMMANDCODE_API_KEY: "k",
            COMMANDCODE_API_BASE: "http://mock",
          }
          assertEqual(await resolvePlan(undefined, env, { cache }), "goat")
          assertEqual(await resolvePlan(undefined, env, { cache }), "goat")
          assertEqual(await resolvePlan(undefined, env, { cache, defaultPlan: "provider" }), "goat")
          assertEqual(fetches, 1)
        },
      )
    },
  ],

  [
    "resolvePlan: failed whoami is cached too (no refetch; falls through to default)",
    async () => {
      let fetches = 0
      const cache: PlanResolutionCache = {}
      await withFetchStub(
        async () => {
          fetches++
          return new Response("nope", { status: 500 })
        },
        async () => {
          const env: NodeJS.ProcessEnv = {
            COMMANDCODE_API_KEY: "k",
            COMMANDCODE_API_BASE: "http://mock",
          }
          assertEqual(
            await resolvePlan(undefined, env, { cache, defaultPlan: "provider" }),
            "provider",
          )
          assertEqual(
            await resolvePlan(undefined, env, { cache, defaultPlan: "provider" }),
            "provider",
          )
          assertEqual(fetches, 1)
        },
      )
    },
  ],

  [
    "resolvePlan: concurrent first calls share one whoami fetch (in-flight dedup)",
    async () => {
      let fetches = 0
      const cache: PlanResolutionCache = {}
      await withFetchStub(
        async () => {
          fetches++
          await new Promise((resolve) => setTimeout(resolve, 20))
          return new Response(JSON.stringify({ planId: "goat" }), { status: 200 })
        },
        async () => {
          const env: NodeJS.ProcessEnv = {
            COMMANDCODE_API_KEY: "k",
            COMMANDCODE_API_BASE: "http://mock",
          }
          const [a, b] = await Promise.all([
            resolvePlan(undefined, env, { cache }),
            resolvePlan(undefined, env, { cache }),
          ])
          assertEqual(a, "goat")
          assertEqual(b, "goat")
          assertEqual(fetches, 1)
        },
      )
    },
  ],

  [
    "resolvePlan: whoami timeout (signal fired) falls through to the default, not go",
    async () => {
      await withFetchStub(
        async (_url, init) => {
          assert(init.signal instanceof AbortSignal, "whoami carries an abort signal (5s timeout)")
          throw new DOMException("The operation timed out.", "TimeoutError")
        },
        async () => {
          const env: NodeJS.ProcessEnv = {
            COMMANDCODE_API_KEY: "k",
            COMMANDCODE_API_BASE: "http://mock",
          }
          assertEqual(await resolvePlan(undefined, env, { defaultPlan: "provider" }), "provider")
          assertEqual(await resolvePlan(undefined, env), "go") // Deals default unaffected
        },
      )
    },
  ],

  [
    "resolvePlan: apiKey + baseURL options drive whoami (model-seam path)",
    async () => {
      await withFetchStub(
        async (url, init) => {
          assertEqual(url, "http://model-base/alpha/whoami")
          // option key wins over the env key, matching resolveApiKey precedence
          assertEqual((init.headers as Record<string, string>).authorization, "Bearer opt_key")
          return new Response(JSON.stringify({ planId: "teampro" }), { status: 200 })
        },
        async () => {
          assertEqual(
            await resolvePlan(
              undefined,
              { COMMANDCODE_API_KEY: "env_key" },
              { apiKey: "opt_key", baseURL: "http://model-base", defaultPlan: "provider" },
            ),
            "teampro",
          )
        },
      )
      // key-less options never fetch
      let fetches = 0
      await withFetchStub(
        async () => {
          fetches++
          return new Response(JSON.stringify({ planId: "goat" }), { status: 200 })
        },
        async () => {
          assertEqual(
            await resolvePlan(
              undefined,
              {},
              { baseURL: "http://model-base", defaultPlan: "provider" },
            ),
            "provider",
          )
          assertEqual(fetches, 0)
        },
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
