// tests/plan-summary.test.ts — plan resolution (billing subscription, issue
// #159) + summary rendering. Plan identity lives in Core
// (src/catalog/plans.ts); the lookup and rendering live in the Deals slice.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resolvePlan,
  renderPlanSummary,
  planSummaryTool,
  planSummaryV2Tool,
  PLAN_SUMMARY_DESCRIPTION,
  type PlanSummaryOptions,
} from "../src/deals/plan-summary.js"
import { normalizePlan } from "../src/catalog/plans.js"
import { MODEL_DEALS, PLAN_CATALOG } from "../src/deals/catalog.js"
import { assert, assertEqual, run } from "./harness.js"

const OFFLINE_ENV: NodeJS.ProcessEnv = {} // no key → no network attempt
const MOCK_ENV: NodeJS.ProcessEnv = {
  COMMANDCODE_API_KEY: "k",
  COMMANDCODE_API_BASE: "http://mock",
}

interface Call {
  url: string
  headers: Record<string, string>
  signal: unknown
}

/** Records every lookup request and answers from a path → body map (404 for
 * anything unlisted, so the stubbed "API" has to be explicit per endpoint). */
function recordingFetch(
  bodies: Record<string, unknown>,
  calls: Call[] = [],
): { calls: Call[]; fetch: typeof fetch } {
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      signal: init.signal,
    })
    const path = url.replace("http://mock", "")
    if (!(path in bodies)) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(bodies[path]), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetch: impl }
}

const SUBSCRIPTION_ACTIVE = (planId: string) => ({
  success: true,
  data: { status: "active", planId },
})

/** Stubs global fetch for the duration of fn (resolvePlan defaults to it). */
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
      // the id the API actually returns for a Team Pro subscription (#159)
      assertEqual(normalizePlan("teams-pro"), "teampro")
      assertEqual(normalizePlan("individual-provider"), "provider")
      assertEqual(normalizePlan(42), undefined)
      assertEqual(normalizePlan(undefined), undefined)
    },
  ],

  [
    "normalizePlan covers the transport pin alias set (issue #54)",
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
    "resolvePlan: arg beats env beats the billing lookup",
    async () => {
      let calls = 0
      const fetchSpy = (async () => {
        calls++
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch
      assertEqual(await resolvePlan("goat", OFFLINE_ENV, { fetch: fetchSpy }), "goat")
      assertEqual(
        await resolvePlan("pro", { COMMANDCODE_PLAN: "goat" }, { fetch: fetchSpy }),
        "pro",
      )
      assertEqual(
        await resolvePlan(undefined, { COMMANDCODE_PLAN: "max20" }, { fetch: fetchSpy }),
        "max20",
      )
      assertEqual(calls, 0, "an override must not touch the network")
    },
  ],

  [
    "resolvePlan: no plan resolves to undefined — never a default (issue #159)",
    async () => {
      assertEqual(await resolvePlan(undefined, OFFLINE_ENV), undefined)
      // unknown env value is not a plan either
      assertEqual(await resolvePlan(undefined, { COMMANDCODE_PLAN: "bogus" }), undefined)
      // unreachable API: no guessed plan
      assertEqual(
        await resolvePlan(undefined, {
          COMMANDCODE_API_KEY: "k",
          COMMANDCODE_API_BASE: "http://127.0.0.1:1",
        }),
        undefined,
      )
    },
  ],

  [
    "resolvePlan: reads planId from /alpha/billing/subscriptions (issue #159)",
    async () => {
      const { calls, fetch } = recordingFetch({
        "/alpha/whoami": { success: true, user: { id: "u" }, org: null },
        "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
      })
      assertEqual(await resolvePlan(undefined, MOCK_ENV, { fetch }), "goat")
      assertEqual(
        calls.map((c) => c.url).join(","),
        "http://mock/alpha/whoami,http://mock/alpha/billing/subscriptions",
        "whoami first (org scope), then the subscription",
      )
      assertEqual(calls[0]!.headers.authorization, "Bearer k")
      assert(calls[0]!.signal instanceof AbortSignal, "lookup carries an abort signal (5s timeout)")
    },
  ],

  [
    "resolvePlan: an org subscription is looked up with the whoami orgId",
    async () => {
      const { calls, fetch } = recordingFetch({
        "/alpha/whoami": { success: true, user: { id: "u" }, org: { id: "org_42" } },
        "/alpha/billing/subscriptions?orgId=org_42": SUBSCRIPTION_ACTIVE("teams-pro"),
      })
      assertEqual(await resolvePlan(undefined, MOCK_ENV, { fetch }), "teampro")
      assertEqual(calls[1]!.url, "http://mock/alpha/billing/subscriptions?orgId=org_42")
    },
  ],

  [
    "resolvePlan: only plan-bearing subscription statuses identify a plan",
    async () => {
      for (const status of ["active", "trialing", "past_due"]) {
        const { fetch } = recordingFetch({
          "/alpha/whoami": { org: null },
          "/alpha/billing/subscriptions": { data: { status, planId: "individual-pro" } },
        })
        assertEqual(await resolvePlan(undefined, MOCK_ENV, { fetch }), "pro", `status ${status}`)
      }
      // canceled / unknown status must not resurrect the plan it used to hold
      for (const status of ["canceled", "unpaid", "paused", undefined]) {
        const { fetch } = recordingFetch({
          "/alpha/whoami": { org: null },
          "/alpha/billing/subscriptions": { data: { status, planId: "individual-pro" } },
        })
        assertEqual(
          await resolvePlan(undefined, MOCK_ENV, { fetch }),
          undefined,
          `status ${status}`,
        )
      }
    },
  ],

  [
    "resolvePlan: credits.planId is the fallback when no subscription resolves",
    async () => {
      const { calls, fetch } = recordingFetch({
        "/alpha/whoami": { org: null },
        "/alpha/billing/subscriptions": { data: { status: "canceled", planId: "individual-pro" } },
        "/alpha/billing/credits": { credits: { planId: "individual-max" } },
      })
      assertEqual(await resolvePlan(undefined, MOCK_ENV, { fetch }), "max")
      assertEqual(calls.length, 3, "credits is consulted only after the subscription misses")
    },
  ],

  [
    "resolvePlan: a failed leg blocks only itself — whoami 500 still reads the subscription",
    async () => {
      const urls: string[] = []
      const fetch = (async (url: string) => {
        urls.push(url)
        if (url.includes("/alpha/whoami")) return new Response("boom", { status: 500 })
        if (url.includes("subscriptions")) {
          return new Response(JSON.stringify(SUBSCRIPTION_ACTIVE("individual-max")), {
            status: 200,
          })
        }
        return new Response("not found", { status: 404 })
      }) as unknown as typeof fetch
      assertEqual(await resolvePlan(undefined, MOCK_ENV, { fetch }), "max")
      assertEqual(
        urls[1],
        "http://mock/alpha/billing/subscriptions",
        "no orgId when whoami yielded no org",
      )
    },
  ],

  [
    "resolvePlan: credits is still tried when the subscription leg errors",
    async () => {
      const urls: string[] = []
      const fetch = (async (url: string) => {
        urls.push(url)
        if (url.includes("/alpha/whoami")) {
          return new Response(JSON.stringify({ org: null }), { status: 200 })
        }
        if (url.includes("subscriptions")) return new Response("boom", { status: 500 })
        return new Response(JSON.stringify({ credits: { planId: "individual-goat" } }), {
          status: 200,
        })
      }) as unknown as typeof fetch
      assertEqual(await resolvePlan(undefined, MOCK_ENV, { fetch }), "goat")
      assert(
        urls.some((u) => u.includes("/alpha/billing/credits")),
        "credits leg ran",
      )
    },
  ],

  [
    "resolvePlan: non-OK / rejected / unknown / malformed responses resolve to undefined",
    async () => {
      const cases: Array<[string, (url: string) => Promise<Response>]> = [
        ["500", async () => new Response("oops", { status: 500 })],
        [
          "rejected",
          async () => {
            throw new Error("offline")
          },
        ],
        [
          "unknown plan id",
          async (url) =>
            url.includes("subscriptions")
              ? new Response(JSON.stringify(SUBSCRIPTION_ACTIVE("bogus-plan")), { status: 200 })
              : new Response(JSON.stringify({ org: null }), { status: 200 }),
        ],
        [
          "malformed body",
          async (url) =>
            url.includes("subscriptions")
              ? new Response("not json", { status: 200 })
              : new Response(JSON.stringify({ org: null }), { status: 200 }),
        ],
        [
          "timeout (signal fired)",
          async () => {
            throw new DOMException("The operation timed out.", "TimeoutError")
          },
        ],
      ]
      for (const [label, stub] of cases) {
        await withFetchStub(stub as typeof fetch, async () => {
          assertEqual(await resolvePlan(undefined, MOCK_ENV), undefined, label)
        })
      }
    },
  ],

  [
    "resolvePlan: without a credential no request is made and no plan is guessed",
    async () => {
      let fetches = 0
      await withFetchStub(
        async () => {
          fetches++
          return new Response(JSON.stringify(SUBSCRIPTION_ACTIVE("individual-goat")), {
            status: 200,
          })
        },
        async () => {
          assertEqual(await resolvePlan(undefined, OFFLINE_ENV), undefined)
          assertEqual(fetches, 0)
        },
      )
    },
  ],

  [
    "resolvePlan: apiKey + baseURL options drive the lookup (model-seam path)",
    async () => {
      const calls: Call[] = []
      const fetch = (async (url: string, init: RequestInit) => {
        calls.push({
          url,
          headers: (init.headers ?? {}) as Record<string, string>,
          signal: init.signal,
        })
        return url.includes("subscriptions")
          ? new Response(JSON.stringify(SUBSCRIPTION_ACTIVE("individual-pro")), { status: 200 })
          : new Response(JSON.stringify({ org: null }), { status: 200 })
      }) as unknown as typeof fetch
      assertEqual(
        await resolvePlan(
          undefined,
          { COMMANDCODE_API_KEY: "env_key" },
          {
            apiKey: "opt_key",
            baseURL: "http://model-base",
            fetch,
          },
        ),
        "pro",
      )
      assertEqual(calls[0]!.url, "http://model-base/alpha/whoami")
      // option key wins over the env key, matching resolveApiKey precedence
      assertEqual(calls[0]!.headers.authorization, "Bearer opt_key")
    },
  ],

  [
    "cmd_plan_summary resolves its credential through resolveApiKey (issue #159)",
    async () => {
      // A credential that exists only in an auth file — no exported env var,
      // which is the opencode /connect case the bug hid.
      const dir = mkdtempSync(join(tmpdir(), "cmd-plan-auth-"))
      const authFile = join(dir, "auth.json")
      writeFileSync(authFile, JSON.stringify({ "command-code": { type: "api", key: "file_key" } }))
      try {
        const { calls, fetch } = recordingFetch({
          "/alpha/whoami": { org: null },
          "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
        })
        const tool = planSummaryTool({
          authPaths: [authFile],
          baseURL: "http://mock",
          fetch,
          env: {},
        })
        const rendered = await tool.execute({})
        assert(rendered.includes("GOAT"), `file credential must drive the lookup, got: ${rendered}`)
        assertEqual(calls[0]!.headers.authorization, "Bearer file_key")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "cmd_plan_summary: the Host credential outranks env and the legacy files (issue #201)",
    async () => {
      // The bug: the Host resolved this session's credential itself (v2 keeps
      // it in its store, v1 exposes it through its SDK client) while the tool
      // fell through to a legacy file of another account.
      const dir = mkdtempSync(join(tmpdir(), "cmd-plan-host-"))
      const authFile = join(dir, "auth.json")
      writeFileSync(authFile, JSON.stringify({ apiKey: "file_key" }))
      try {
        const { calls, fetch } = recordingFetch({
          "/alpha/whoami": { org: null },
          "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
        })
        const options = {
          hostCredential: async () => ({ key: "host_key", source: "host" }) as const,
          authPaths: [authFile],
          baseURL: "http://mock",
          fetch,
          env: { COMMANDCODE_API_KEY: "env_key" },
        }
        const rendered = await planSummaryTool(options).execute({})
        assert(
          rendered.includes("GOAT"),
          `the Host credential must drive the lookup, got: ${rendered}`,
        )
        assertEqual(calls[0]!.headers.authorization, "Bearer host_key")

        // The v2 builder takes the same seam (ADR-0010: one tool, both hosts).
        const v2 = await planSummaryV2Tool(options).execute({})
        assertEqual(v2.content, rendered)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "cmd_plan_summary: an explicit apiKey still outranks the Host credential",
    async () => {
      const { calls, fetch } = recordingFetch({
        "/alpha/whoami": { org: null },
        "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-pro"),
      })
      const tool = planSummaryTool({
        apiKey: "opt_key",
        hostCredential: async () => ({ key: "host_key", source: "host" }),
        baseURL: "http://mock",
        fetch,
        env: {},
      })
      await tool.execute({})
      assertEqual(calls[0]!.headers.authorization, "Bearer opt_key")
    },
  ],

  [
    "cmd_plan_summary: a Host that cannot answer falls through to env, then to a file",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cmd-plan-fallthrough-"))
      const authFile = join(dir, "auth.json")
      writeFileSync(authFile, JSON.stringify({ apiKey: "file_key" }))
      const bodies = {
        "/alpha/whoami": { org: null },
        "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-max"),
      }
      try {
        const envCase = recordingFetch(bodies)
        await planSummaryTool({
          hostCredential: async () => undefined,
          baseURL: "http://mock",
          fetch: envCase.fetch,
          env: { COMMANDCODE_API_KEY: "env_key" },
        }).execute({})
        assertEqual(envCase.calls[0]!.headers.authorization, "Bearer env_key")

        // A Host that throws is the same rung as one that declines: the lookup
        // the tool already had stays, and no error reaches the caller.
        const throwCase = recordingFetch(bodies)
        const rendered = await planSummaryTool({
          hostCredential: async () => {
            throw new Error("credential store unavailable")
          },
          baseURL: "http://mock",
          fetch: throwCase.fetch,
          env: { COMMANDCODE_API_KEY: "env_key" },
        }).execute({})
        assert(rendered.includes("Max 10×"), `the fallback must still resolve, got: ${rendered}`)
        assertEqual(throwCase.calls[0]!.headers.authorization, "Bearer env_key")

        const fileCase = recordingFetch(bodies)
        await planSummaryTool({
          hostCredential: async () => undefined,
          authPaths: [authFile],
          baseURL: "http://mock",
          fetch: fileCase.fetch,
          env: {},
        }).execute({})
        assertEqual(fileCase.calls[0]!.headers.authorization, "Bearer file_key")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "cmd_plan_summary: a pinned plan never asks the Host for a credential (ADR-0011 §2)",
    async () => {
      let asked = 0
      const neverFetch = (async () => {
        throw new Error("a pinned summary must not touch the network")
      }) as unknown as typeof fetch
      const options = {
        hostCredential: async () => {
          asked++
          return { key: "host_key", source: "host" as const }
        },
        fetch: neverFetch,
        env: {},
      }
      const byArg = await planSummaryTool(options).execute({ plan: "max" })
      assert(byArg.includes("Max 10×"))
      const v2 = await planSummaryV2Tool(options).execute({ plan: "goat" })
      assert(
        typeof v2.content === "string" && v2.content.includes("GOAT"),
        "the v2 builder takes the same pin path",
      )
      // The pin is the provenance a pinned summary renders, and no identity is
      // claimed: renderPlanSummary with a pin source is the whole output (#205).
      assertEqual(
        byArg,
        renderPlanSummary("max", MODEL_DEALS, PLAN_CATALOG, {
          source: { kind: "pin", via: "argument" },
        }),
      )
      assertEqual(
        await planSummaryTool({ ...options, env: { COMMANDCODE_PLAN: "goat" } }).execute({}),
        renderPlanSummary("goat", MODEL_DEALS, PLAN_CATALOG, {
          source: { kind: "pin", via: "environment" },
        }),
      )
      assertEqual(asked, 0, "no pin path may consult the Host credential")
    },
  ],

  [
    "cmd_plan_summary names the credential rung that resolved (issue #205)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cmd-plan-rungs-"))
      const authFile = join(dir, "auth.json")
      writeFileSync(authFile, JSON.stringify({ apiKey: "file_key" }))
      const whoami = {
        success: true,
        user: { id: "u_42", userName: "rashid", email: "rashid@example.com" },
        org: null,
      }
      const bodies = {
        "/alpha/whoami": whoami,
        "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
      }
      const cases: Array<[string, PlanSummaryOptions, string]> = [
        [
          "host store",
          { hostCredential: async () => ({ key: "host_key", source: "host" }) },
          "Account: `rashid` — credential: Host connection",
        ],
        [
          "host env",
          { hostCredential: async () => ({ key: "host_key", source: "environment" }) },
          "Account: `rashid` — credential: Host connection (COMMANDCODE_API_KEY)",
        ],
        [
          "host config",
          { hostCredential: async () => ({ key: "host_key", source: "config" }) },
          "Account: `rashid` — credential: Host configuration",
        ],
        [
          "explicit option",
          { apiKey: "opt_key" },
          "Account: `rashid` — credential: the explicit `apiKey` option",
        ],
        [
          "environment",
          { env: { COMMANDCODE_API_KEY: "env_key" } },
          "Account: `rashid` — credential: COMMANDCODE_API_KEY",
        ],
        [
          "legacy file",
          { authPaths: [authFile] },
          `Account: \`rashid\` — credential: legacy file \`${authFile}\``,
        ],
      ]
      try {
        for (const [label, options, expected] of cases) {
          const { fetch } = recordingFetch(bodies)
          const out = await planSummaryTool({
            env: {},
            ...options,
            baseURL: "http://mock",
            fetch,
          }).execute({})
          const head = out.split("\n").slice(0, 2).join(" | ")
          assert(out.includes(expected), `${label}: expected ${expected}, got ${head}`)
          for (const secret of ["host_key", "env_key", "file_key", "opt_key"]) {
            assert(!out.includes(secret), `${label} must not render a key, got ${head}`)
          }
          assert(
            !out.includes("rashid@example.com"),
            `${label} must never render the account email, got ${head}`,
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "the account label is absent when whoami names no account (issue #205)",
    async () => {
      const hostCredential = async () => ({ key: "host_key", source: "host" as const })
      // whoami fails on its own: the subscription leg still resolves the plan
      // (each leg is independent), but the summary claims no identity.
      const failing = (async (url: string) =>
        url.includes("whoami")
          ? new Response("boom", { status: 500 })
          : new Response(JSON.stringify(SUBSCRIPTION_ACTIVE("individual-goat")), {
              status: 200,
            })) as unknown as typeof fetch
      const failed = await planSummaryTool({
        hostCredential,
        baseURL: "http://mock",
        fetch: failing,
        env: {},
      }).execute({})
      assert(failed.includes("GOAT"), `the plan must still resolve, got: ${failed.split("\n")[0]}`)
      assert(!failed.includes("Account:"), "a failed whoami must not yield an account claim")
      assert(
        failed.includes("Credential: Host connection"),
        "the credential rung is still reported",
      )

      // A whoami that answers without naming a user is the same case: nothing to
      // label the account with, so no account claim is rendered.
      for (const [label, user] of [
        ["no user", undefined],
        ["empty user", {}],
      ] as const) {
        const { fetch } = recordingFetch({
          "/alpha/whoami": { success: true, org: null, ...(user ? { user } : {}) },
          "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
        })
        const out = await planSummaryTool({
          hostCredential,
          baseURL: "http://mock",
          fetch,
          env: {},
        }).execute({})
        assert(!out.includes("Account:"), `${label}: no account label may be rendered`)
      }

      // No userName: an elided user id is the label ("short form", #205).
      const id = `u_${"abcdefghij".repeat(4)}`
      const { fetch } = recordingFetch({
        "/alpha/whoami": { success: true, user: { id }, org: null },
        "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
      })
      const elided = await planSummaryTool({
        hostCredential,
        baseURL: "http://mock",
        fetch,
        env: {},
      }).execute({})
      assert(
        elided.includes("Account: `u_abcdefghijabcdefghijabcdefghi…`"),
        `a long user id must be elided, got: ${elided.split("\n")[1]}`,
      )
      assert(!elided.includes(id), "the raw user id must not be rendered whole")
    },
  ],

  [
    "the account label is short, inert, and never an email (issue #205)",
    async () => {
      const hostCredential = async () => ({ key: "host_key", source: "host" as const })
      const labelFor = async (user: Record<string, unknown>): Promise<string | undefined> => {
        const { fetch } = recordingFetch({
          "/alpha/whoami": { success: true, user, org: null },
          "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
        })
        const out = await planSummaryTool({
          hostCredential,
          baseURL: "http://mock",
          fetch,
          env: {},
        }).execute({})
        return out.split("\n")[1]
      }

      // An empty userName still falls back to the id — `??` alone would not.
      assertEqual(
        await labelFor({ id: "u_42", userName: "" }),
        "Account: `u_42` — credential: Host connection",
      )
      // A userName that is an email is never the label; the id takes over.
      assertEqual(
        await labelFor({ id: "u_42", userName: "rashid@example.com" }),
        "Account: `u_42` — credential: Host connection",
      )
      // Neither: no label at all rather than an email.
      assertEqual(
        await labelFor({ userName: "rashid@example.com", email: "other@example.com" }),
        "Credential: Host connection",
      )
      // A userName is API data, not markdown: it cannot forge a line or a row.
      assertEqual(
        await labelFor({ userName: "rashid\n| fake | row |" }),
        "Account: `rashid fake row` — credential: Host connection",
      )
    },
  ],

  [
    "a legacy-file label is inert too (issue #205)",
    async () => {
      // Paths are external data as much as account fields are: a store whose
      // name carries markdown or a line break must not break the line it is
      // rendered into.
      const dir = mkdtempSync(join(tmpdir(), "cmd-plan-label-"))
      const authFile = join(dir, "auth|`file`.json")
      writeFileSync(authFile, JSON.stringify({ apiKey: "file_key" }))
      try {
        const { fetch } = recordingFetch({
          "/alpha/whoami": { success: true, user: { userName: "rashid" }, org: null },
          "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
        })
        const out = await planSummaryTool({
          env: {},
          authPaths: [authFile],
          baseURL: "http://mock",
          fetch,
        }).execute({})
        const line = out.split("\n")[1]!
        assert(line.includes("credential: legacy file `"), `must name the store, got: ${line}`)
        assert(line.includes("auth file .json"), `the store name survives flattened, got: ${line}`)
        assert(!line.includes("|"), `the label cannot forge a table row, got: ${line}`)
        assertEqual(line.match(/`/g)?.length, 4, `the label stays inside its code span: ${line}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "cmd_plan_summary (v1 + v2) renders unknown instead of Go when nothing resolves",
    async () => {
      const notFound = (async () => new Response("not found", { status: 404 })) as typeof fetch
      // `authPaths: []` keeps the ladder off this machine's real auth files, so
      // "nothing resolved" is a fact of the test rather than of the developer's
      // home directory.
      const v1 = await planSummaryTool({ fetch: notFound, env: {}, authPaths: [] }).execute({})
      const v2def = planSummaryV2Tool({ fetch: notFound, env: {}, authPaths: [] })
      const v2 = await v2def.execute({})
      for (const [label, out] of [
        ["v1", v1],
        ["v2", v2.content],
      ] as const) {
        assert(out.includes("plan: unknown"), `${label} must name the unknown state`)
        assert(out.includes("COMMANDCODE_PLAN"), `${label} must name the pin override`)
        assert(!out.includes("buys $"), `${label} must not render a guessed plan's credits`)
        assert(!out.includes("5-hour window $3"), `${label} must not render Go's windows`)
        // An unknown plan with no credential at all says so, and claims no
        // account it did not look up (issue #205).
        assert(
          out.includes("Credential: none resolved"),
          `${label} must report that nothing resolved`,
        )
        assert(!out.includes("Account:"), `${label} must not claim an account`)
        assertEqual(
          PLAN_SUMMARY_DESCRIPTION.includes(
            "plan is detected from the account's billing subscription",
          ),
          true,
          "the shared description documents the detection source",
        )
      }
      assertEqual(v2def.name, "cmd_plan_summary")
    },
  ],

  [
    "cmd_plan_summary renders the account and the credential source (issue #205)",
    async () => {
      const { fetch } = recordingFetch({
        "/alpha/whoami": { success: true, user: { id: "u_42", userName: "rashid" }, org: null },
        "/alpha/billing/subscriptions": SUBSCRIPTION_ACTIVE("individual-goat"),
      })
      const out = await planSummaryTool({
        hostCredential: async () => ({ key: "host_key", source: "host" }),
        baseURL: "http://mock",
        fetch,
        env: {},
      }).execute({})
      assert(
        out.includes("Account: `rashid` — credential: Host connection"),
        `the summary must name the account and the rung, got: ${out}`,
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
    "renderPlanSummary handles the unknown plan (issue #159)",
    () => {
      const out = renderPlanSummary(undefined, MODEL_DEALS, PLAN_CATALOG)
      assert(out.includes("plan: unknown"), "must name the unknown state")
      assert(out.includes("could not be detected"), "must explain detection failed")
      assert(out.includes("pass `plan`") || out.includes("Pass `plan`"), "must offer the override")
      assert(out.includes("go|goat|pro|max|max20|teampro|provider"), "must list valid plans")
      assert(out.includes("pricing-limits"), "must link the live table")
      assert(!out.includes("buys $"), "must not show any plan's credits")
      assert(!out.includes("| Model |"), "must not show a plan's model table")
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
