// tests/tui-usage.test.ts — the panel's usage controller (issues #244/#245):
// the loader seam (v1: resolve → fetch; v2: the RPC bridge, tested in
// tests/usage-rpc.test.ts) fed by `v1UsageLoader`, its once-per-mount
// semantics, the no-credential notice with zero requests, last-snapshot
// retention on a failed refresh, and the cached-scope shortening of a refresh
// (whoami and a fresh subscription record are not re-read). The refresh
// *policy* — throttle, coalescing, countdown, backoff, unmount — lives in
// tests/tui-usage-refresh.test.ts under the fake clock. A recording mock fetch
// — never the network — and no TUI runtime: the controller is host-agnostic
// and each half feeds it one loader through `src/deals/tui-usage.ts`.
import { readFileSync } from "node:fs"
import { createUsagePanel, v1UsageLoader, type UsagePanelState } from "../src/deals/tui-usage.js"
import { renderUsageRows, type UsageResult, type UsageSnapshot } from "../src/deals/usage.js"
import type { TuiCredentialV1Input } from "../src/deals/tui-credential.js"
import type { V1ProviderListClient } from "../src/deals/host-credential.js"
import { assert, assertEqual, run } from "./harness.js"

const BASE = "http://mock"
const WHOAMI = "/alpha/whoami"
const SUBSCRIPTIONS = "/alpha/billing/subscriptions"
const CREDITS = "/alpha/billing/credits"
const SUMMARY = "/alpha/usage/summary"

const NOW = Date.parse("2026-10-01T12:00:00.000Z")
const PERIOD_START = "2026-09-05T00:00:00.000Z"
/** Five days out, so the monthly meter's renewal suffix is exactly `5d`. */
const PERIOD_END = new Date(NOW + 5 * 86_400_000).toISOString()
/** A live reset 4h32m out, in milliseconds (above the seconds-heuristic floor). */
const RESET_AT = NOW + (4 * 60 + 32) * 60_000

interface Call {
  url: string
  headers: Record<string, string>
}

/**
 * Serves `bodies` by pathname (queries ignored) and records every call;
 * `failures` makes a path throw or answer a non-2xx. A local copy of the
 * billing mock's style so neither suite has to load the other's runner.
 */
function stubFetch(
  bodies: Record<string, unknown>,
  failures: Record<string, () => Response | Promise<Response>> = {},
): { urls: string[]; calls: Call[]; fetch: typeof fetch } {
  const urls: string[] = []
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit = {}) => {
    urls.push(url)
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> })
    const path = url.replace(BASE, "").split("?")[0]!
    const failure = failures[path]
    if (failure) return failure()
    if (!(path in bodies)) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(bodies[path]), { status: 200 })
  }) as unknown as typeof fetch
  return { urls, calls, fetch: impl }
}

/** The four billing answers of a live Go account, overridable leg by leg. */
function billingBodies(
  overrides: {
    whoami?: unknown
    subscriptions?: unknown
    credits?: unknown
    summary?: unknown
  } = {},
): Record<string, unknown> {
  return {
    [WHOAMI]: overrides.whoami ?? { success: true, org: null },
    [SUBSCRIPTIONS]: overrides.subscriptions ?? {
      success: true,
      data: {
        status: "active",
        planId: "individual-go",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
      },
    },
    [CREDITS]: overrides.credits ?? {
      windowLimits: {
        limited: true,
        fiveHour: { used: 0.5, cap: 3, exceeded: false },
        weekly: { used: 1.5, cap: 6, exceeded: false, resetAt: RESET_AT },
      },
      credits: { monthlyCredits: 0.5 },
    },
    [SUMMARY]: overrides.summary ?? {
      totalCount: 7020,
      totalTokens: 1135619637,
      totalCost: 9.41,
      totalMonthlyCredits: 39.5,
      periodBasis: "billing-period",
    },
  }
}

/** The pinned `Usage` segment the Go fixtures must render. */
const SEGMENT = [
  ["", ""],
  ["Usage", "", "heading"],
  ["5-hour", "$0.50 / $3.00 · 17%"],
  ["Weekly", "$1.50 / $6.00 · 25% · resets in 4h 32m"],
  ["Monthly", "$39.50 / $40.00 · 99% · renews in 5d"],
  ["This cycle: 7,020 requests · 1.14B tokens · $9.41 spent", "", "value"],
  ["via Host connection", "", "value"],
]

/** The segment rows for a controller state, as the panel renders them. */
function segment(state: UsagePanelState | undefined): unknown[] {
  return renderUsageRows(state?.result, { provenance: state?.provenance, now: NOW })
}

/**
 * The v1 host's live state thunk: the `commandcode` record plus the TUI's own
 * client — exactly what the panel's `v1UsageInput` hands the loader.
 */
function v1Input(
  providers: readonly unknown[],
  client?: V1ProviderListClient,
): () => TuiCredentialV1Input {
  return () => ({ host: "v1", providers, client })
}

/** No ambient credential: only what a test injects can resolve. */
const NO_CREDENTIAL = { env: {}, authPaths: [] }

run([
  [
    "mount runs the four-request chain exactly once and publishes the snapshot",
    async () => {
      const { urls, calls, fetch } = stubFetch(billingBodies())
      const changes: UsagePanelState[] = []
      const panel = createUsagePanel(
        v1UsageLoader(v1Input([{ id: "commandcode", key: "v1_key" }]), {
          credential: NO_CREDENTIAL,
          fetchOptions: { baseURL: BASE, fetch, env: {} },
        }),
        { onChange: (state) => changes.push(state) },
      )
      await panel.mount()
      // A second mount is a no-op: the chain is once per panel, not per call.
      await panel.mount()
      assertEqual(
        urls.map((url) => new URL(url).pathname),
        [WHOAMI, SUBSCRIPTIONS, CREDITS, SUMMARY],
        "the documented leg order, once",
      )
      assertEqual(calls.length, 4, "exactly the four billing requests")
      assertEqual(calls[0]!.headers.authorization, "Bearer v1_key")
      const state = panel.state()
      assert(state?.result.state === "usage", "the mount must publish a snapshot")
      assertEqual(state.provenance, { kind: "host" })
      assertEqual(segment(state), SEGMENT, "the panel's pinned segment")
      assertEqual(changes.length, 1, "one publish per settled mount")
      // Every mounting test ends with `unmount`: it cancels the countdown
      // clock, whose live timer would otherwise keep the runner alive.
      panel.unmount()
    },
  ],

  [
    "the controller renders whichever outcome the loader answers (host-agnostic)",
    async () => {
      // The v2 half's loader is the RPC bridge (tests/usage-rpc.test.ts); here
      // a stub stands in for it and pins the controller-side contract: the
      // outcome publishes as-is, provenance included, with no network at all.
      const snapshot: UsageSnapshot = {
        plan: "go",
        limited: true,
        fiveHour: { used: 0.5, cap: 3, exceeded: false },
        weekly: { used: 1.5, cap: 6, exceeded: false, resetAt: RESET_AT },
        monthly: { used: 39.5, cap: 40 },
        totals: { requests: 7020, tokens: 1135619637, cost: 9.41 },
        periodEnd: Date.parse(PERIOD_END),
      }
      let loads = 0
      const panel = createUsagePanel(async () => {
        loads += 1
        return {
          result: { state: "usage", snapshot } satisfies UsageResult,
          provenance: { kind: "environment" },
        }
      })
      await panel.mount()
      assertEqual(loads, 1, "one load per mount")
      assertEqual(segment(panel.state()), [
        ["", ""],
        ["Usage", "", "heading"],
        ["5-hour", "$0.50 / $3.00 · 17%"],
        ["Weekly", "$1.50 / $6.00 · 25% · resets in 4h 32m"],
        ["Monthly", "$39.50 / $40.00 · 99% · renews in 5d"],
        ["This cycle: 7,020 requests · 1.14B tokens · $9.41 spent", "", "value"],
        ["via COMMANDCODE_API_KEY", "", "value"],
      ])
      panel.unmount()
    },
  ],

  [
    "no credential resolves: the notice renders and zero requests are made",
    async () => {
      // The v1 cases use the panel's real loader: the provider record *and*
      // the TUI's own client, whose listing is an in-process read, not a
      // billing request — the billing stub must stay untouched either way. The
      // v2 case is the bridge answering no-credential server-side.
      const idleClient: V1ProviderListClient = { provider: { list: async () => ({}) } }
      const cases: Array<[string, () => Promise<UsagePanelState | undefined>]> = [
        [
          "v1 without a record",
          async () => {
            const { urls, fetch } = stubFetch(billingBodies())
            const panel = createUsagePanel(
              v1UsageLoader(v1Input([], idleClient), {
                credential: NO_CREDENTIAL,
                fetchOptions: { baseURL: BASE, fetch, env: {} },
              }),
            )
            await panel.mount()
            const state = panel.state()
            assertEqual(urls.length, 0, "v1 without a record must not touch the network")
            panel.unmount()
            return state
          },
        ],
        [
          "v1 with a record the client cannot top up",
          async () => {
            const { urls, fetch } = stubFetch(billingBodies())
            const panel = createUsagePanel(
              v1UsageLoader(v1Input([{ id: "commandcode", options: {} }], idleClient), {
                credential: NO_CREDENTIAL,
                fetchOptions: { baseURL: BASE, fetch, env: {} },
              }),
            )
            await panel.mount()
            const state = panel.state()
            assertEqual(urls.length, 0, "an empty record must not touch the network")
            panel.unmount()
            return state
          },
        ],
        [
          "the v2 bridge answering no-credential",
          async () => {
            const { urls, fetch } = stubFetch(billingBodies())
            const panel = createUsagePanel(async () => ({ result: { state: "no-credential" } }))
            await panel.mount()
            const state = panel.state()
            assertEqual(urls.length, 0, "a bridged miss must not touch the network")
            panel.unmount()
            return state
          },
        ],
      ]
      for (const [label, mountCase] of cases) {
        const state = await mountCase()
        assertEqual(state?.result.state, "no-credential", label)
        assertEqual(segment(state), [
          ["", ""],
          ["Usage", "", "heading"],
          ["Usage needs COMMANDCODE_API_KEY — set it to see live limits", "", "value"],
        ])
      }
    },
  ],

  [
    "a failed first mount renders unavailable and no exception escapes",
    async () => {
      // Every leg failing is the unavailable state, not a rejection.
      const dead = () => new Response("boom", { status: 500 })
      const { urls, fetch } = stubFetch(billingBodies(), {
        [WHOAMI]: dead,
        [SUBSCRIPTIONS]: dead,
        [CREDITS]: dead,
        [SUMMARY]: dead,
      })
      const panel = createUsagePanel(
        v1UsageLoader(v1Input([{ id: "commandcode", key: "k" }]), {
          credential: NO_CREDENTIAL,
          fetchOptions: { baseURL: BASE, fetch, env: {} },
        }),
      )
      await panel.mount()
      assertEqual(panel.state()?.result.state, "unavailable")
      assertEqual(urls.length, 4, "the chain was attempted")
      assertEqual(segment(panel.state()), [
        ["", ""],
        ["Usage", "", "heading"],
        ["Usage unavailable — could not read the Command Code billing API", "", "value"],
      ])
      // A throwing loader (a broken bridge) is the same degradation.
      const throwing = createUsagePanel(async () => {
        throw new Error("bridge exploded")
      })
      await throwing.mount()
      assertEqual(throwing.state()?.result.state, "unavailable")
      panel.unmount()
      throwing.unmount()
    },
  ],

  [
    "a failed refresh keeps the last successful snapshot on screen",
    async () => {
      let failing = false
      const base = stubFetch(billingBodies())
      const attempted: string[] = []
      const fetch = (async (url: string, init: RequestInit = {}) => {
        attempted.push(url)
        if (failing) return new Response("boom", { status: 500 })
        return base.fetch(url, init)
      }) as unknown as typeof fetch
      const changes: UsagePanelState[] = []
      const panel = createUsagePanel(
        v1UsageLoader(v1Input([{ id: "commandcode", key: "k" }]), {
          credential: NO_CREDENTIAL,
          fetchOptions: { baseURL: BASE, fetch, env: {} },
        }),
        { onChange: (state) => changes.push(state) },
      )
      await panel.mount()
      const first = panel.state()
      assert(first?.result.state === "usage")
      assertEqual(base.urls.length, 4)

      failing = true
      await panel.refresh()
      assertEqual(panel.state(), first, "the failed refresh must not drop the snapshot")
      // The mount cached the scope, so the refresh chain is the two live legs
      // (credits + summary) — four mount requests plus two refresh requests.
      assertEqual(attempted.length, 6, "the refresh ran its own credits + summary chain")
      assertEqual(changes.length, 1, "a kept snapshot publishes nothing")
      assertEqual(segment(panel.state()), SEGMENT, "the numbers stay rendered")
      panel.unmount()
    },
  ],

  [
    "a successful refresh replaces the snapshot",
    async () => {
      const bodies = billingBodies()
      const base = stubFetch(bodies)
      const panel = createUsagePanel(
        v1UsageLoader(v1Input([{ id: "commandcode", key: "k" }]), {
          credential: NO_CREDENTIAL,
          fetchOptions: {
            baseURL: BASE,
            fetch: (async (url, init) => base.fetch(url, init)) as unknown as typeof fetch,
            env: {},
          },
        }),
      )
      await panel.mount()
      // Mutate the record the stub reads: a refresh sees the new window.
      Object.assign(
        bodies,
        billingBodies({
          credits: {
            windowLimits: { limited: true, fiveHour: { used: 1, cap: 3, exceeded: false } },
            credits: { monthlyCredits: 0.5 },
          },
          summary: { totalMonthlyCredits: 39.5 },
        }),
      )
      await panel.refresh()
      const state = panel.state()
      assert(state?.result.state === "usage")
      const fiveHour = segment(state).find(
        (row) => Array.isArray(row) && row[0] === "5-hour",
      ) as unknown[]
      assertEqual(fiveHour, ["5-hour", "$1.00 / $3.00 · 33%"], "the refresh's numbers render")
      panel.unmount()
    },
  ],

  [
    "a credential that no longer resolves publishes the notice, not stale numbers",
    async () => {
      let providers: readonly unknown[] = [{ id: "commandcode", key: "k" }]
      const { urls, fetch } = stubFetch(billingBodies())
      const panel = createUsagePanel(
        v1UsageLoader(() => ({ host: "v1", providers }), {
          credential: NO_CREDENTIAL,
          fetchOptions: { baseURL: BASE, fetch, env: {} },
        }),
      )
      await panel.mount()
      assertEqual(panel.state()?.result.state, "usage")
      providers = []
      await panel.refresh()
      assertEqual(panel.state()?.result.state, "no-credential")
      assertEqual(urls.length, 4, "the second chain resolved nothing and made no request")
      panel.unmount()
    },
  ],

  [
    "every load re-reads the host state — the credential is never cached (ADR-0020 rule 3)",
    async () => {
      let providers: readonly unknown[] = []
      const { urls, fetch } = stubFetch(billingBodies())
      const panel = createUsagePanel(
        v1UsageLoader(() => ({ host: "v1", providers }), {
          credential: NO_CREDENTIAL,
          fetchOptions: { baseURL: BASE, fetch, env: {} },
        }),
      )
      await panel.mount()
      assertEqual(panel.state()?.result.state, "no-credential")
      assertEqual(urls.length, 0)
      // The provider record arrives after mount: the next load sees it.
      providers = [{ id: "commandcode", key: "late_key" }]
      await panel.refresh()
      assertEqual(panel.state()?.result.state, "usage")
      assertEqual(urls.length, 4)
      panel.unmount()
    },
  ],

  [
    "the controller module is host-agnostic: no TUI runtime, no host-package imports",
    () => {
      const source = readFileSync(
        new URL("../src/deals/tui-usage.ts", import.meta.url).pathname,
        "utf-8",
      )
      assert(!/from\s+["']solid-js["']/.test(source), "no solid-js import")
      assert(!/from\s+["']@opencode-ai\//.test(source), "no @opencode-ai/* import")
      assert(!/from\s+["']@opencode\//.test(source), "no @opencode/* import")
    },
  ],
])
