// tests/tui-usage.test.ts — the panel's usage controller (issues #244/#245):
// the loader seam (v1: resolve → fetch; v2: the RPC bridge, tested in
// tests/usage-rpc.test.ts) fed by `v1UsageLoader`, its once-per-mount
// semantics, the no-credential notice with zero requests, last-snapshot
// retention on a failed refresh, and the cached-scope shortening of a refresh
// (whoami and a fresh subscription record are not re-read). The refresh
// *policy* — throttle, coalescing, countdown, backoff, unmount — lives in
// tests/tui-usage-refresh.test.ts under the fake clock. A recording mock fetch
// — never the network — and no TUI runtime: the controller is host-agnostic
// and each half feeds it one loader through `src/rates-usage/tui-usage.ts`.
import { readFileSync } from "node:fs"
import {
  createUsagePanel,
  v1UsageLoader,
  type UsageLoadOutcome,
  type UsageLoadRequest,
  type UsagePanelState,
} from "../src/rates-usage/tui-usage.js"
import { renderUsageRows, type UsageResult, type UsageSnapshot } from "../src/rates-usage/usage.js"
import { createUsageCache } from "../src/rates-usage/usage-cache.js"
import type { TuiCredentialV1Input } from "../src/rates-usage/tui-credential.js"
import type { V1ProviderListClient } from "../src/rates-usage/host-credential.js"
import { assert, assertEqual, run } from "./harness.js"
import { createFakeClock } from "./helpers/fake-clock.js"

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
  ["5-hour", "", "value"],
  [bar(5, 1), " 17%", "bar", "success"],
  ["$0.50 / $3.00", "", "value"],
  ["", ""],
  ["Weekly", "", "value"],
  [bar(8), " 25%", "bar", "success"],
  ["$1.50 / $6.00 · 4h 32m", "", "value"],
  ["", ""],
  ["Monthly", "", "value"],
  [bar(31, 1), " 99%", "bar", "error"],
  ["$39.50 / $40.00 · 5d", "", "value"],
  ["", ""],
  ["Tokens", "1.14B"],
  ["Request", "7,020"],
  ["Total Spent", "$9.41"],
]

/** A 33-cell meter bar: `full` whole cells, one half cell, dots, then the cap. */
function bar(full: number, half = 0): string {
  return `${"█".repeat(full)}${half === 1 ? "▌" : ""}${"·".repeat(32 - full - half)}▏`
}

/** The meter detail row for `label` in a rendered segment. */
function detail(rows: unknown[], label: string): unknown[] {
  const index = rows.findIndex((row) => Array.isArray(row) && row[0] === label)
  return rows[index + 2] as unknown[]
}

/** The segment rows for a controller state, as the panel renders them. */
function segment(state: UsagePanelState | undefined): unknown[] {
  return renderUsageRows(state?.result, { now: NOW })
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
      // #251: each landing leg publishes its merged view, then the settled
      // outcome — four publishes for this four-leg chain.
      assertEqual(changes.length, 4, "three partials and the settled outcome")
      assertEqual(changes.at(-1), state, "the settled outcome is the last publish")
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
      // outcome publishes as-is, with no network at all.
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
        ["5-hour", "", "value"],
        [bar(5, 1), " 17%", "bar", "success"],
        ["$0.50 / $3.00", "", "value"],
        ["", ""],
        ["Weekly", "", "value"],
        [bar(8), " 25%", "bar", "success"],
        ["$1.50 / $6.00 · 4h 32m", "", "value"],
        ["", ""],
        ["Monthly", "", "value"],
        [bar(31, 1), " 99%", "bar", "error"],
        ["$39.50 / $40.00 · 5d", "", "value"],
        ["", ""],
        ["Tokens", "1.14B"],
        ["Request", "7,020"],
        ["Total Spent", "$9.41"],
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
      // The panel's clock is pinned to NOW so the subscription record the
      // mount caches (period end NOW + 5d) is still fresh at the refresh: the
      // second chain must collapse to credits + summary. On the real clock the
      // fixture's period end expires with the calendar and the refresh re-reads
      // subscriptions, adding a third request (the 2026-10-06 cron failure).
      const panel = createUsagePanel(
        v1UsageLoader(v1Input([{ id: "commandcode", key: "k" }]), {
          credential: NO_CREDENTIAL,
          fetchOptions: { baseURL: BASE, fetch, env: {} },
        }),
        { clock: createFakeClock(NOW), onChange: (state) => changes.push(state) },
      )
      await panel.mount()
      const first = panel.state()
      assert(first?.result.state === "usage")
      assertEqual(base.urls.length, 4)
      const publishesAtMount = changes.length

      failing = true
      await panel.refresh()
      assertEqual(panel.state(), first, "the failed refresh must not drop the snapshot")
      // The mount cached the scope, so the refresh chain is the two live legs
      // (credits + summary) — four mount requests plus two refresh requests.
      assertEqual(attempted.length, 6, "the refresh ran its own credits + summary chain")
      assertEqual(changes.length, publishesAtMount, "a kept snapshot publishes nothing")
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
      assertEqual(
        detail(segment(state), "5-hour"),
        ["$1.00 / $3.00", "", "value"],
        "the refresh's numbers render",
      )
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
    "a cached state seeds the panel before its chain settles and survives a failed mount",
    async () => {
      const store = createUsageCache()
      const seeded: UsageSnapshot = {
        plan: "go",
        limited: true,
        fiveHour: { used: 0.5, cap: 3, exceeded: false },
        totals: { requests: 7 },
      }
      store.write("ses_1", {
        result: { state: "usage", snapshot: seeded },
        provenance: { kind: "host" },
      })
      const changes: UsagePanelState[] = []
      const panel = createUsagePanel(
        async () => {
          throw new Error("bridge down")
        },
        { cache: { key: "ses_1", store }, onChange: (state) => changes.push(state) },
      )
      // The seed renders synchronously — a remount cannot blank the segment.
      assertEqual(panel.state()?.result, { state: "usage", snapshot: seeded })
      assertEqual(changes.length, 1, "the seed is published once")
      await panel.mount()
      assertEqual(panel.state()?.result.state, "usage", "a failed mount keeps the seed")
      assertEqual(changes.at(-1)?.result, { state: "usage", snapshot: seeded })
      panel.unmount()
    },
  ],

  [
    "the panel hands the loader its last-good snapshot and forwards partial states",
    async () => {
      const requests: UsageLoadRequest[] = []
      const load = async (request: UsageLoadRequest): Promise<UsageLoadOutcome> => {
        requests.push(request)
        const partial: UsageSnapshot = {
          limited: true,
          fiveHour: { used: 1, cap: 3, exceeded: false },
        }
        request.onPartial?.({
          result: { state: "usage", snapshot: partial },
          provenance: { kind: "environment" },
        })
        return { result: { state: "unavailable" } }
      }
      const store = createUsageCache()
      const preloaded: UsageSnapshot = {
        limited: true,
        weekly: { used: 2, cap: 6, exceeded: false },
      }
      store.write("ses_2", { result: { state: "usage", snapshot: preloaded } })
      const changes: UsagePanelState[] = []
      const panel = createUsagePanel(load, {
        cache: { key: "ses_2", store },
        onChange: (state) => changes.push(state),
      })
      await panel.mount()
      assertEqual(requests.length, 1)
      assertEqual(requests[0]!.previous, preloaded, "the seed is the merge base")
      assertEqual(
        panel.state()?.result,
        {
          state: "usage",
          snapshot: { limited: true, fiveHour: { used: 1, cap: 3, exceeded: false } },
        },
        "the partial published as-is",
      )
      assertEqual(
        panel.state()?.provenance,
        { kind: "environment" },
        "the partial carries its rung",
      )
      assertEqual(store.read("ses_2")?.result.state, "usage", "the partial is cached for a remount")
      panel.unmount()
    },
  ],

  [
    "the controller module is host-agnostic: no TUI runtime, no host-package imports",
    () => {
      const source = readFileSync(
        new URL("../src/rates-usage/tui-usage.ts", import.meta.url).pathname,
        "utf-8",
      )
      assert(!/from\s+["']solid-js["']/.test(source), "no solid-js import")
      assert(!/from\s+["']@opencode-ai\//.test(source), "no @opencode-ai/* import")
      assert(!/from\s+["']@opencode\//.test(source), "no @opencode/* import")
    },
  ],
])
