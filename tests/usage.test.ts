// tests/usage.test.ts — the live usage snapshot (issue #242): the four-leg
// billing fetch against a recording mock (never the network), its defensive
// parse, and the pinned `Usage` segment rows. Rendering is pure — every
// fixture passes its own `now` — and this file never imports the TUI runtime.
import { readFileSync } from "node:fs"
import {
  fetchUsageSnapshot,
  renderUsageRows,
  type UsageResult,
  type UsageScope,
  type UsageSnapshot,
  type UsageTotals,
} from "../src/deals/usage.js"
import { PLAN_CATALOG } from "../src/deals/catalog.js"
import type { DealsRow } from "../src/deals/tui.js"
import { assert, assertEqual, run } from "./harness.js"

const BASE = "http://mock"
const WHOAMI = "/alpha/whoami"
const SUBSCRIPTIONS = "/alpha/billing/subscriptions"
const CREDITS = "/alpha/billing/credits"
const SUMMARY = "/alpha/usage/summary"

const PERIOD_START = "2026-09-05T00:00:00.000Z"
const PERIOD_END = "2026-10-05T00:00:00.000Z"
/** A real millisecond reset, so the seconds heuristic must leave it alone. */
const MS_RESET = 1_800_000_000_000
const NOW = Date.parse("2026-10-01T12:00:00.000Z")
const HOUR = 3_600_000
const DAY = 86_400_000

interface Call {
  url: string
  headers: Record<string, string>
  signal: unknown
}

/**
 * Serves `bodies` by pathname (queries ignored) and records every call.
 * `failures` overrides a path — a throwing stub, a non-2xx response, an
 * unparseable body — so each leg's failure mode stays explicit.
 */
function stubFetch(
  bodies: Record<string, unknown>,
  failures: Record<string, () => Response | Promise<Response>> = {},
): { urls: string[]; calls: Call[]; fetch: typeof fetch } {
  const urls: string[] = []
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit = {}) => {
    urls.push(url)
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      signal: init.signal,
    })
    const path = url.replace(BASE, "").split("?")[0]!
    const failure = failures[path]
    if (failure) return failure()
    if (!(path in bodies)) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(bodies[path]), { status: 200 })
  }) as unknown as typeof fetch
  return { urls, calls, fetch: impl }
}

/** The decoded query of a recorded call. */
function query(url: string): URLSearchParams {
  return new URL(url).searchParams
}

function whoami(org: string | null = null): Record<string, unknown> {
  return { success: true, user: { id: "u_1" }, org: org === null ? null : { id: org } }
}

function subscription(planId: string): Record<string, unknown> {
  return {
    success: true,
    data: {
      status: "active",
      planId,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    },
  }
}

/** The live Go windows: caps never in the bundled row ($3/$6 vs $2/$5). */
const PROBE_WINDOWS = {
  limited: true,
  fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0 },
  weekly: { used: 1.5, cap: 6, exceeded: false, resetAt: MS_RESET },
}

const PROBE_SUMMARY = {
  totalCount: 7020,
  totalTokens: 1135619637,
  totalTokensIn: 1129787188,
  totalTokensOut: 5832449,
  totalCost: 9.4106877059,
  totalMonthlyCredits: 39.5,
  periodBasis: "billing-period",
}

/** The four billing answers (a Go account), overridable leg by leg. */
function fullBodies(
  overrides: {
    whoami?: unknown
    subscriptions?: unknown
    credits?: unknown
    summary?: unknown
  } = {},
): Record<string, unknown> {
  return {
    [WHOAMI]: overrides.whoami ?? whoami(),
    [SUBSCRIPTIONS]: overrides.subscriptions ?? subscription("individual-go"),
    [CREDITS]: overrides.credits ?? {
      windowLimits: PROBE_WINDOWS,
      credits: { planId: "individual-go", monthlyCredits: 0.5 },
    },
    [SUMMARY]: overrides.summary ?? PROBE_SUMMARY,
  }
}

/** The snapshot of a lookup that must resolve; the degradation states fail. */
async function fetchSnapshot(
  overrides: Parameters<typeof fullBodies>[0] = {},
): Promise<UsageSnapshot> {
  const { fetch } = stubFetch(fullBodies(overrides))
  const result = await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
  assert(result.state === "usage", `expected usage data, got ${JSON.stringify(result)}`)
  return (result as { state: "usage"; snapshot: UsageSnapshot }).snapshot
}

/** A row by label. */
function label(rows: DealsRow[], key: string): DealsRow | undefined {
  return rows.find(([name]) => name === key)
}

/** The rendered segment for a snapshot at the pinned clock instant. */
function usageRows(snapshot: UsageSnapshot): DealsRow[] {
  return renderUsageRows({ state: "usage", snapshot }, { now: NOW })
}

/** The meter sub-section rows for `label`: its label, bar and detail rows. */
function meter(rows: DealsRow[], key: string): DealsRow[] {
  const index = rows.findIndex(([name]) => name === key)
  return index === -1 ? [] : rows.slice(index, index + 3)
}

/** The meter bar row for `label`, if the meter rendered one. */
function barRow(rows: DealsRow[], key: string): DealsRow | undefined {
  return meter(rows, key)[1]
}

/** A 33-cell meter bar: `full` whole cells, one half cell, dots, then the cap. */
function bar(full: number, half = 0): string {
  return `${"█".repeat(full)}${half === 1 ? "▌" : ""}${"·".repeat(32 - full - half)}▏`
}

/**
 * A subscription cache whose period end has passed: the re-read trigger. The
 * `since` differs per case, so the refreshed slice is distinguishable.
 */
function staleScope(since: string): UsageScope {
  return {
    orgId: "org_42",
    subscription: { plan: "go", since, periodEnd: NOW - 1, readAt: NOW - 60_000 },
  }
}

run([
  // ---------------------------------------------------------------------------
  // Fetch: request shapes and per-leg independence.
  // ---------------------------------------------------------------------------

  [
    "the chain is whoami → subscriptions → credits → summary, org-scoped and Bearer-only",
    async () => {
      const { calls, fetch } = stubFetch(fullBodies({ whoami: whoami("org_42") }))
      const result = await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
      assertEqual(result, {
        state: "usage",
        snapshot: {
          plan: "go",
          limited: true,
          fiveHour: { used: 0, cap: 3, exceeded: false },
          weekly: { used: 1.5, cap: 6, exceeded: false, resetAt: MS_RESET },
          monthly: { used: 39.5, cap: 40 },
          totals: {
            requests: 7020,
            tokens: 1135619637,
            tokensIn: 1129787188,
            tokensOut: 5832449,
            cost: 9.4106877059,
          },
          periodEnd: Date.parse(PERIOD_END),
          periodBasis: "billing-period",
        },
      })
      assertEqual(
        calls.map((call) => new URL(call.url).pathname),
        [WHOAMI, SUBSCRIPTIONS, CREDITS, SUMMARY],
        "documented leg order",
      )
      assertEqual(query(calls[0]!.url).get("limits"), "1", "whoami asks for the limits view")
      assertEqual(query(calls[1]!.url).get("orgId"), "org_42", "team requests scope to the org")
      assertEqual(query(calls[2]!.url).get("orgId"), "org_42")
      assertEqual(query(calls[3]!.url).get("orgId"), "org_42")
      assertEqual(query(calls[3]!.url).get("since"), PERIOD_START, "the summary pins the period")
      for (const call of calls) {
        assertEqual(call.headers, { authorization: "Bearer k" }, "Bearer auth only")
        assert(call.signal instanceof AbortSignal, "each leg carries the abort budget")
      }
    },
  ],

  [
    "without a credential there is no request and no guessed usage",
    async () => {
      const { calls, fetch } = stubFetch(fullBodies())
      assertEqual(await fetchUsageSnapshot({ baseURL: BASE, fetch, env: {} }), {
        state: "no-credential",
      })
      assertEqual(calls.length, 0, "a missing credential must not touch the network")
      // COMMANDCODE_API_KEY is the fallback rung; an explicit option wins over it
      const envCase = await fetchUsageSnapshot({
        baseURL: BASE,
        fetch,
        env: { COMMANDCODE_API_KEY: "env_key" },
      })
      assertEqual(envCase.state, "usage")
      assertEqual(calls[0]!.headers.authorization, "Bearer env_key")
      await fetchUsageSnapshot({
        apiKey: "opt_key",
        baseURL: BASE,
        fetch,
        env: { COMMANDCODE_API_KEY: "env_key" },
      })
      assertEqual(calls[4]!.headers.authorization, "Bearer opt_key")
    },
  ],

  [
    "each leg fails on its own — only the rows that leg feeds drop",
    async () => {
      // whoami 500: no org scope, everything else still parses
      {
        const { urls, fetch } = stubFetch(fullBodies(), {
          [WHOAMI]: () => new Response("boom", { status: 500 }),
        })
        const result = await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
        assertEqual(query(urls[1]!).get("orgId"), null, "no org id, no scoping")
        const snapshot = (result as { state: "usage"; snapshot: UsageSnapshot }).snapshot
        assertEqual(snapshot.plan, "go", "the subscription still names the plan")
        const rows = renderUsageRows(result, { now: NOW })
        assert(label(rows, "5-hour") !== undefined, "the credits meter still renders")
        assert(label(rows, "Monthly") !== undefined, "the monthly meter still renders")
        assert(label(rows, "Request") !== undefined, "the summary totals still render")
      }

      // subscriptions offline: no since pin, no plan, but every live row stays
      {
        const { urls, fetch } = stubFetch(fullBodies(), {
          [SUBSCRIPTIONS]: () => {
            throw new Error("offline")
          },
        })
        const result = await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
        assertEqual(query(urls[3]!).get("since"), null, "no period start, no since pin")
        const snapshot = (result as { state: "usage"; snapshot: UsageSnapshot }).snapshot
        assertEqual(snapshot.plan, undefined, "never a default plan")
        assertEqual(snapshot.periodEnd, undefined)
        assertEqual(snapshot.fiveHour, { used: 0, cap: 3, exceeded: false })
        assertEqual(snapshot.monthly, { used: 39.5, cap: 40 }, "the live sum needs no plan row")
        const rows = renderUsageRows(result, { now: NOW })
        assert(label(rows, "5-hour") !== undefined)
        assert(label(rows, "Monthly") !== undefined)
        assert(label(rows, "Request") !== undefined)
      }

      // credits timeout: no meters, the summary totals still render
      {
        const { fetch } = stubFetch(
          fullBodies({ summary: { ...PROBE_SUMMARY, totalMonthlyCredits: 2 } }),
          {
            [CREDITS]: () => {
              throw new DOMException("The operation timed out.", "TimeoutError")
            },
          },
        )
        const result = await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
        const snapshot = (result as { state: "usage"; snapshot: UsageSnapshot }).snapshot
        assertEqual(snapshot.fiveHour, undefined)
        assertEqual(snapshot.weekly, undefined)
        assertEqual(snapshot.monthly, { used: 2, cap: PLAN_CATALOG.go.credits })
        const rows = renderUsageRows(result, { now: NOW })
        assertEqual(label(rows, "5-hour"), undefined, "no credits leg, no rolling meter")
        assertEqual(label(rows, "Weekly"), undefined)
        assert(label(rows, "Monthly") !== undefined, "spend + the bundled row still meter")
        assert(label(rows, "Request") !== undefined, "the totals leg is untouched")
      }

      // summary unparseable: no totals, the windows still render
      {
        const { fetch } = stubFetch(fullBodies(), {
          [SUMMARY]: () => new Response("not json", { status: 200 }),
        })
        const result = await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
        const snapshot = (result as { state: "usage"; snapshot: UsageSnapshot }).snapshot
        assertEqual(snapshot.totals, undefined)
        assertEqual(snapshot.periodBasis, undefined)
        assertEqual(snapshot.monthly, {
          used: PLAN_CATALOG.go.credits - 0.5,
          cap: PLAN_CATALOG.go.credits,
        })
        const rows = renderUsageRows(result, { now: NOW })
        assert(label(rows, "5-hour") !== undefined)
        assert(label(rows, "Weekly") !== undefined)
        assertEqual(label(rows, "Request"), undefined, "no summary leg, no totals")
      }
    },
  ],

  [
    "the purchased extra-credit balance parses from the credits leg, floored at zero",
    async () => {
      const positive = await fetchSnapshot({
        credits: { credits: { monthlyCredits: 0.5, purchasedCredits: 4.81934405 } },
      })
      assertEqual(positive.purchasedCredits, 4.81934405, "the CLI's Extra Credits figure")
      const zero = await fetchSnapshot({
        credits: { credits: { monthlyCredits: 0.5, purchasedCredits: 0 } },
      })
      assertEqual(zero.purchasedCredits, 0, "a zero balance is data, not absence")
      const negative = await fetchSnapshot({
        credits: { credits: { monthlyCredits: 0.5, purchasedCredits: -3 } },
      })
      assertEqual(negative.purchasedCredits, 0, "an unreadable negative floors at zero")
      const missing = await fetchSnapshot()
      assertEqual(missing.purchasedCredits, undefined, "a payload without it stays absent")
    },
  ],

  [
    "a lookup that reads nothing is unavailable, not an empty segment",
    async () => {
      const dead = () => new Response("boom", { status: 500 })
      const { fetch } = stubFetch(fullBodies(), {
        [WHOAMI]: dead,
        [SUBSCRIPTIONS]: dead,
        [CREDITS]: dead,
        [SUMMARY]: dead,
      })
      assertEqual(await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} }), {
        state: "unavailable",
      })
      // Bodies that parse but carry nothing are the same state.
      const empty = stubFetch({ [WHOAMI]: {}, [SUBSCRIPTIONS]: {}, [CREDITS]: {}, [SUMMARY]: {} })
      assertEqual(
        await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch: empty.fetch, env: {} }),
        { state: "unavailable" },
      )
    },
  ],

  [
    "every leg × every failure mode degrades without throwing",
    async () => {
      // The shared getJson catch makes the modes one class; this matrix pins
      // the whole leg × mode grid the acceptance names (non-2xx, timeout,
      // unparseable body) rather than one mode per leg.
      const modes: Record<string, () => Response> = {
        "non-2xx": () => new Response("boom", { status: 500 }),
        timeout: () => {
          throw new DOMException("The operation timed out.", "TimeoutError")
        },
        "unparseable body": () => new Response("not json", { status: 200 }),
      }
      for (const path of [WHOAMI, SUBSCRIPTIONS, CREDITS, SUMMARY]) {
        for (const [mode, respond] of Object.entries(modes)) {
          const { fetch } = stubFetch(fullBodies(), { [path]: respond })
          const result = await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
          assert(
            result.state === "usage" || result.state === "unavailable",
            `${path} ${mode}: expected a degraded result, got ${JSON.stringify(result)}`,
          )
        }
      }
    },
  ],

  [
    "each billing request arms the 5-second abort budget",
    async () => {
      // `AbortSignal.timeout` carries no readable duration, so the budget is
      // observed at the seam: every leg arms exactly one 5000 ms signal.
      const original = AbortSignal.timeout
      const budgets: number[] = []
      AbortSignal.timeout = ((ms: number) => {
        budgets.push(ms)
        return original.call(AbortSignal, ms)
      }) as typeof AbortSignal.timeout
      try {
        const { fetch } = stubFetch(fullBodies())
        await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
      } finally {
        AbortSignal.timeout = original
      }
      assertEqual(budgets, [5000, 5000, 5000, 5000], "one budget per leg")
    },
  ],

  // ---------------------------------------------------------------------------
  // Parse: the defensive, row-oriented rules.
  // ---------------------------------------------------------------------------

  [
    "the subscription status gates plan identity (ADR-0011) — never a default",
    async () => {
      for (const status of ["active", "trialing", "past_due", "canceled", "unpaid", "paused"]) {
        const snapshot = await fetchSnapshot({
          subscriptions: {
            data: { status, planId: "individual-go", currentPeriodStart: PERIOD_START },
          },
        })
        const expected = ["active", "trialing", "past_due"].includes(status) ? "go" : undefined
        assertEqual(snapshot.plan, expected, `status ${status}`)
      }
      // A missing status is not a plan-bearing one either.
      const missing = await fetchSnapshot({
        subscriptions: { data: { planId: "individual-go" } },
      })
      assertEqual(missing.plan, undefined)
      // The gate has teeth: a canceled subscription's bundled row must not
      // cap a live window, while the live value itself still renders.
      const canceled = await fetchSnapshot({
        subscriptions: { data: { status: "canceled", planId: "individual-go" } },
        credits: { windowLimits: { limited: true, fiveHour: { used: 1 } }, credits: {} },
        summary: {},
      })
      assertEqual(canceled.fiveHour, { used: 1, exceeded: false })
    },
  ],

  [
    "a numeric period start pins `since` verbatim and a seconds period end converts",
    async () => {
      const { calls, fetch } = stubFetch(
        fullBodies({
          subscriptions: {
            data: {
              status: "active",
              planId: "individual-go",
              currentPeriodStart: 1_700_000_000,
              currentPeriodEnd: 1_700_000_600,
            },
          },
        }),
      )
      const result = await fetchUsageSnapshot({ apiKey: "k", baseURL: BASE, fetch, env: {} })
      assertEqual(query(calls[3]!.url).get("since"), "1700000000")
      const snapshot = (result as { state: "usage"; snapshot: UsageSnapshot }).snapshot
      assertEqual(snapshot.periodEnd, 1_700_000_600_000)
    },
  ],

  [
    "resetAt: milliseconds pass through, a sub-1e12 value is seconds, 0 is idle",
    async () => {
      const snapshot = await fetchSnapshot({
        credits: {
          windowLimits: {
            limited: true,
            fiveHour: { used: 2, cap: 3, exceeded: true, resetAt: 0 },
            weekly: { used: 1, cap: 6, exceeded: false, resetAt: 1_700_000_000 },
          },
          credits: { monthlyCredits: 0.5 },
        },
        summary: {},
      })
      // 0 is not a timestamp: the window is idle and carries no reset.
      assertEqual(snapshot.fiveHour, { used: 2, cap: 3, exceeded: true })
      // The rate-limit envelope unit: seconds are re-read as milliseconds.
      assertEqual(snapshot.weekly, { used: 1, cap: 6, exceeded: false, resetAt: 1_700_000_000_000 })
    },
  ],

  [
    "live window caps win over the bundled plan row; the row fills a missing cap",
    async () => {
      const live = await fetchSnapshot({
        credits: {
          windowLimits: {
            limited: true,
            fiveHour: { used: 1, cap: PLAN_CATALOG.go.window5h + 1 },
            weekly: { used: 2, cap: PLAN_CATALOG.go.windowWeek + 1 },
          },
          credits: {},
        },
        summary: {},
      })
      assertEqual(live.fiveHour?.cap, PLAN_CATALOG.go.window5h + 1)
      assertEqual(live.weekly?.cap, PLAN_CATALOG.go.windowWeek + 1)

      const fallback = await fetchSnapshot({
        credits: {
          windowLimits: {
            limited: true,
            fiveHour: { used: 0, resetAt: 0 },
            weekly: { used: 0 },
          },
          credits: {},
        },
        summary: {},
      })
      assertEqual(fallback.fiveHour, {
        used: 0,
        cap: PLAN_CATALOG.go.window5h,
        exceeded: false,
      })
      assertEqual(fallback.weekly, {
        used: 0,
        cap: PLAN_CATALOG.go.windowWeek,
        exceeded: false,
      })
    },
  ],

  [
    "monthly cap: remaining + spent from the summary, bundled plan row as the fallback",
    async () => {
      // remaining 0.5 + spent 39.5 at one instant = the 40 pool
      const both = await fetchSnapshot()
      assertEqual(both.monthly, { used: 39.5, cap: 40 })

      // only remaining: the bundled credits cap it, used = cap - remaining
      const remaining = await fetchSnapshot({
        credits: { windowLimits: PROBE_WINDOWS, credits: { monthlyCredits: 1 } },
        summary: {},
      })
      assertEqual(remaining.monthly, {
        used: PLAN_CATALOG.go.credits - 1,
        cap: PLAN_CATALOG.go.credits,
      })

      // only spent: the bundled credits cap it, used is the live spend
      const spent = await fetchSnapshot({
        credits: { windowLimits: PROBE_WINDOWS, credits: {} },
        summary: { totalMonthlyCredits: 2 },
      })
      assertEqual(spent.monthly, { used: 2, cap: PLAN_CATALOG.go.credits })

      // neither: no monthly meter — never invented
      const neither = await fetchSnapshot({
        credits: { windowLimits: PROBE_WINDOWS },
        summary: {},
      })
      assertEqual(neither.monthly, undefined)

      // unknown plan: no bundled row, so only the live sum can meter
      const unknown = await fetchSnapshot({ subscriptions: subscription("bogus-plan") })
      assertEqual(unknown.plan, undefined, "unknown ids are never a default")
      assertEqual(unknown.monthly, { used: 39.5, cap: 40 })
    },
  ],

  [
    "missing windowLimits and limited:false parse without throwing",
    async () => {
      const noWindows = await fetchSnapshot({
        credits: { credits: { monthlyCredits: 1 } },
        summary: {},
      })
      assertEqual(noWindows.limited, undefined)
      assertEqual(noWindows.fiveHour, undefined)
      assertEqual(noWindows.weekly, undefined)
      assertEqual(noWindows.monthly, {
        used: PLAN_CATALOG.go.credits - 1,
        cap: PLAN_CATALOG.go.credits,
      })

      const payg = await fetchSnapshot({
        credits: { windowLimits: { limited: false } },
        summary: {},
      })
      assertEqual(payg.limited, false)
      assertEqual(payg.fiveHour, undefined)
    },
  ],

  [
    "a partial summary renders only the totals it carries (tokens derive from in + out)",
    async () => {
      const requests = await fetchSnapshot({
        summary: { totalCount: 7, periodBasis: "billing-period" },
      })
      assertEqual(requests.totals, { requests: 7 })
      assertEqual(requests.periodBasis, "billing-period")

      const cost = await fetchSnapshot({ summary: { totalCost: 3 } })
      assertEqual(cost.totals, { cost: 3 })

      const derived = await fetchSnapshot({ summary: { totalTokensIn: 10, totalTokensOut: 5 } })
      assertEqual(derived.totals, { tokensIn: 10, tokensOut: 5, tokens: 15 })
    },
  ],

  // ---------------------------------------------------------------------------
  // The cached scope (issue #245): the full chain publishes the whoami org and
  // the subscription record, and a refresh carrying that scope skips whoami
  // for good and subscriptions while the record is fresh.
  // ---------------------------------------------------------------------------

  [
    "a fresh scope collapses the refresh to the two live legs and reuses the cache",
    async () => {
      const { calls, fetch } = stubFetch(fullBodies({ whoami: whoami("org_42") }))
      let capturedScope: UsageScope | undefined
      const first = await fetchUsageSnapshot({
        apiKey: "k",
        baseURL: BASE,
        fetch,
        env: {},
        now: NOW,
        onScope: (scope) => {
          capturedScope = scope
        },
      })
      assert(first.state === "usage")
      assertEqual(capturedScope, {
        orgId: "org_42",
        subscription: {
          plan: "go",
          since: PERIOD_START,
          periodEnd: Date.parse(PERIOD_END),
          readAt: NOW,
        },
      })

      calls.length = 0
      let refreshedScope: UsageScope | undefined
      const second = await fetchUsageSnapshot({
        apiKey: "k",
        baseURL: BASE,
        fetch,
        env: {},
        now: NOW + 5 * 60_000,
        scope: capturedScope,
        onScope: (scope) => {
          refreshedScope = scope
        },
      })
      assertEqual(
        calls.map((call) => new URL(call.url).pathname),
        [CREDITS, SUMMARY],
        "the two live legs only — never whoami, never subscriptions",
      )
      assertEqual(query(calls[0]!.url).get("orgId"), "org_42", "the refresh stays org-scoped")
      assertEqual(query(calls[1]!.url).get("since"), PERIOD_START, "the summary keeps its pin")
      assertEqual(refreshedScope, undefined, "a fresh reuse reads nothing new to publish")
      assert(second.state === "usage")
      assertEqual(second.snapshot.plan, "go", "plan identity rides the cache")
      assertEqual(second.snapshot.periodEnd, Date.parse(PERIOD_END), "the period end rides too")
    },
  ],

  [
    "a scope past its period end re-reads subscriptions and keeps whoami cached",
    async () => {
      const stale = staleScope("2026-08-05T00:00:00.000Z")
      const { calls, fetch } = stubFetch(fullBodies({ whoami: whoami("org_42") }))
      let capturedScope: UsageScope | undefined
      const result = await fetchUsageSnapshot({
        apiKey: "k",
        baseURL: BASE,
        fetch,
        env: {},
        now: NOW,
        scope: stale,
        onScope: (scope) => {
          capturedScope = scope
        },
      })
      assertEqual(
        calls.map((call) => new URL(call.url).pathname),
        [SUBSCRIPTIONS, CREDITS, SUMMARY],
        "the re-read legs, and never whoami",
      )
      assertEqual(capturedScope, {
        orgId: "org_42",
        subscription: {
          plan: "go",
          since: PERIOD_START,
          periodEnd: Date.parse(PERIOD_END),
          readAt: NOW,
        },
      })
      assert(result.state === "usage")
      assertEqual(result.snapshot.plan, "go")
    },
  ],

  [
    "a subscription record over an hour old re-reads; exactly an hour does not",
    async () => {
      const scopeAt = (readAt: number): UsageScope => ({
        orgId: "org_42",
        subscription: {
          plan: "go",
          since: PERIOD_START,
          periodEnd: Date.parse(PERIOD_END),
          readAt,
        },
      })
      const { calls, fetch } = stubFetch(fullBodies({ whoami: whoami("org_42") }))
      await fetchUsageSnapshot({
        apiKey: "k",
        baseURL: BASE,
        fetch,
        env: {},
        now: NOW,
        scope: scopeAt(NOW - HOUR),
      })
      assertEqual(
        calls.map((call) => new URL(call.url).pathname),
        [CREDITS, SUMMARY],
        "exactly an hour is still fresh",
      )
      calls.length = 0
      await fetchUsageSnapshot({
        apiKey: "k",
        baseURL: BASE,
        fetch,
        env: {},
        now: NOW,
        scope: scopeAt(NOW - HOUR - 1),
      })
      assertEqual(
        calls.map((call) => new URL(call.url).pathname),
        [SUBSCRIPTIONS, CREDITS, SUMMARY],
        "a millisecond over the hour re-reads",
      )
    },
  ],

  [
    "a failed subscription re-read keeps the cached slice for the next chain",
    async () => {
      const stale = staleScope(PERIOD_START)
      const { calls, fetch } = stubFetch(fullBodies(), {
        [SUBSCRIPTIONS]: () => new Response("boom", { status: 500 }),
      })
      let capturedScope: UsageScope | undefined
      const result = await fetchUsageSnapshot({
        apiKey: "k",
        baseURL: BASE,
        fetch,
        env: {},
        now: NOW,
        scope: stale,
        onScope: (scope) => {
          capturedScope = scope
        },
      })
      assertEqual(
        calls.map((call) => new URL(call.url).pathname),
        [SUBSCRIPTIONS, CREDITS, SUMMARY],
      )
      assert(result.state === "usage")
      assertEqual(result.snapshot.plan, "go", "plan survives the failed re-read")
      assertEqual(
        capturedScope,
        stale,
        "the stale slice publishes unchanged, so the next chain retries",
      )
    },
  ],

  [
    "the caller's abort signal joins every leg's five-second budget",
    async () => {
      const controller = new AbortController()
      controller.abort()
      const { calls, fetch } = stubFetch(fullBodies())
      const result = await fetchUsageSnapshot({
        apiKey: "k",
        baseURL: BASE,
        fetch,
        env: {},
        signal: controller.signal,
      })
      assertEqual(calls.length, 4, "the chain still runs its legs")
      for (const call of calls) {
        assert((call.signal as AbortSignal).aborted, "each leg carries the caller's abort")
      }
      assert(result.state === "usage", "the stub ignores signals; the plumbing is what is pinned")
    },
  ],

  // ---------------------------------------------------------------------------
  // Render: the pinned segment and every degradation variant.
  // ---------------------------------------------------------------------------

  [
    "renders the full pinned segment: heading, three meter sub-sections, the summary",
    () => {
      const snapshot: UsageSnapshot = {
        plan: "go",
        limited: true,
        fiveHour: { used: 0.5, cap: 3, exceeded: false },
        weekly: { used: 1.53, cap: 6, exceeded: false, resetAt: NOW + (4 * 60 + 32) * 60_000 },
        monthly: { used: 9.41, cap: 40 },
        purchasedCredits: 4.82,
        totals: {
          requests: 7020,
          tokens: 1135619637,
          tokensIn: 1129787188,
          tokensOut: 5832449,
          cost: 9.41,
        },
        periodEnd: NOW + 5 * DAY,
      }
      assertEqual(usageRows(snapshot), [
        ["", ""],
        ["Usage", "", "heading"],
        ["5-hour", "", "value"],
        [bar(5, 1), " 17%", "bar", "success"],
        ["$0.50 / $3.00", "", "value"],
        ["", ""],
        ["Weekly", "", "value"],
        [bar(8, 1), " 26%", "bar", "success"],
        ["$1.53 / $6.00 · 4h 32m", "", "value"],
        ["", ""],
        ["Monthly", "", "value"],
        [bar(7, 1), " 24%", "bar", "success"],
        ["$9.41 / $40.00 · 5d", "", "value"],
        ["", ""],
        ["Token In", "1.13B"],
        ["Token Out", "5.83M"],
        ["Request", "7,020"],
        ["Total Spent", "$9.41"],
        ["Extra Credit", "$4.82"],
      ])
    },
  ],

  [
    "an idle window renders its bar and used/cap with no countdown",
    () => {
      assertEqual(usageRows({ limited: true, fiveHour: { used: 0, cap: 3, exceeded: false } }), [
        ["", ""],
        ["Usage", "", "heading"],
        ["5-hour", "", "value"],
        [bar(0), "  0%", "bar", "success"],
        ["$0.00 / $3.00", "", "value"],
      ])
    },
  ],

  [
    "limited:false renders the pay-as-you-go line and skips the rolling meters",
    () => {
      assertEqual(
        usageRows({
          plan: "provider",
          limited: false,
          fiveHour: { used: 5, cap: 3, exceeded: true },
          weekly: { used: 5, cap: 6, exceeded: false },
          totals: { requests: 12, cost: 1.5 },
        }),
        [
          ["", ""],
          ["Usage", "", "heading"],
          ["No rolling windows on this plan — usage is pay-as-you-go", "", "value"],
          ["", ""],
          ["Request", "12"],
          ["Total Spent", "$1.50"],
        ],
      )
    },
  ],

  [
    "no credential renders the one-line notice (undefined is the resolver's miss)",
    () => {
      const expected: DealsRow[] = [
        ["", ""],
        ["Usage", "", "heading"],
        ["Usage needs COMMANDCODE_API_KEY — set it to see live limits", "", "value"],
      ]
      assertEqual(renderUsageRows(undefined, { now: NOW }), expected)
      assertEqual(renderUsageRows({ state: "no-credential" }, { now: NOW }), expected)
    },
  ],

  [
    "unavailable renders its line for a failed fetch and a data-less snapshot",
    () => {
      const expected: DealsRow[] = [
        ["", ""],
        ["Usage", "", "heading"],
        ["Usage unavailable — could not read the Command Code billing API", "", "value"],
      ]
      assertEqual(renderUsageRows({ state: "unavailable" }, { now: NOW }), expected)
      assertEqual(renderUsageRows({ state: "usage", snapshot: {} }, { now: NOW }), expected)
      assertEqual(
        renderUsageRows({ state: "usage", snapshot: { plan: "go" } }, { now: NOW }),
        expected,
      )
    },
  ],

  [
    "numbers format as decided: percent clamped, money 2dp, tokens compact",
    () => {
      const rows = usageRows({
        limited: true,
        fiveHour: { used: 10, cap: 4, exceeded: true },
        weekly: { used: 0, cap: 0, exceeded: false },
        monthly: { used: 1.5, cap: 3.5 },
        totals: { requests: 1234567, tokens: 999999, cost: 2.5 },
      })
      // Over-cap is clamped to 100; a zero cap reads 0; the rest round.
      assertEqual(meter(rows, "5-hour"), [
        ["5-hour", "", "value"],
        [bar(32), "100%", "bar", "error"],
        ["$10.00 / $4.00", "", "value"],
      ])
      assertEqual(meter(rows, "Weekly"), [
        ["Weekly", "", "value"],
        [bar(0), "  0%", "bar", "success"],
        ["$0.00 / $0.00", "", "value"],
      ])
      assertEqual(meter(rows, "Monthly"), [
        ["Monthly", "", "value"],
        [bar(14), " 43%", "bar", "warning"],
        ["$1.50 / $3.50", "", "value"],
      ])
      assertEqual(label(rows, "Tokens"), ["Tokens", "1M"])
      assertEqual(label(rows, "Request"), ["Request", "1,234,567"])
      assertEqual(label(rows, "Total Spent"), ["Total Spent", "$2.50"])
    },
  ],

  [
    "a window with no cap renders used-only and omits the bar",
    () => {
      assertEqual(
        usageRows({
          limited: true,
          fiveHour: { used: 1.5, exceeded: false, resetAt: NOW + 30 * 60_000 },
        }),
        [
          ["", ""],
          ["Usage", "", "heading"],
          ["5-hour", "", "value"],
          ["$1.50 used · 30m", "", "value"],
        ],
      )
    },
  ],

  [
    "countdowns use the CLI's d/h/m format and stop at the reset",
    () => {
      const countdown = (ms: number) =>
        meter(
          usageRows({
            limited: true,
            fiveHour: { used: 0, cap: 1, exceeded: false, resetAt: NOW + ms },
          }),
          "5-hour",
        )[2]?.[0]
      assertEqual(countdown(2 * DAY + 3 * HOUR), "$0.00 / $1.00 · 2d 3h")
      assertEqual(countdown(HOUR + 5 * 60_000), "$0.00 / $1.00 · 1h 5m")
      assertEqual(countdown(59_000), "$0.00 / $1.00 · 1m")
      // A reset that already passed carries no countdown.
      assertEqual(countdown(-HOUR), "$0.00 / $1.00")
    },
  ],

  [
    "the renewal reads in whole days, floored at zero",
    () => {
      const monthlyAt = (periodEnd: number | undefined) =>
        meter(usageRows({ limited: true, monthly: { used: 1, cap: 10 }, periodEnd }), "Monthly")
      assertEqual(monthlyAt(NOW + 5 * DAY)[2], ["$1.00 / $10.00 · 5d", "", "value"])
      // Four hours still rounds to a day (the CLI's ceil).
      assertEqual(monthlyAt(NOW + 2 * HOUR)[2], ["$1.00 / $10.00 · 1d", "", "value"])
      // A period already past floors at zero, never a negative count.
      assertEqual(monthlyAt(NOW - HOUR)[2], ["$1.00 / $10.00 · 0d", "", "value"])
      assertEqual(monthlyAt(undefined)[2], ["$1.00 / $10.00", "", "value"])
      assertEqual(monthlyAt(NOW + 5 * DAY)[1], [bar(3), " 10%", "bar", "success"])
    },
  ],

  [
    "the percentage field reserves three digits plus the sign",
    () => {
      const percentAt = (used: number, cap: number) =>
        barRow(
          usageRows({ limited: true, fiveHour: { used, cap, exceeded: false } }),
          "5-hour",
        )?.[1]
      assertEqual(percentAt(0.06, 1), "  6%")
      assertEqual(percentAt(0.36, 1), " 36%")
      assertEqual(percentAt(1, 1), "100%")
    },
  ],

  [
    "the bar tone follows the progress: green ≤ 40, yellow ≤ 80, red above",
    () => {
      const toneAt = (used: number, cap: number) =>
        barRow(
          usageRows({ limited: true, fiveHour: { used, cap, exceeded: false } }),
          "5-hour",
        )?.[3]
      assertEqual(toneAt(0.4, 1), "success", "40% stays green")
      assertEqual(toneAt(0.41, 1), "warning", "41% is yellow")
      assertEqual(toneAt(0.8, 1), "warning", "80% stays yellow")
      assertEqual(toneAt(0.81, 1), "error", "81% is red")
      assertEqual(toneAt(1, 1), "error")
    },
  ],

  [
    "the bar fills to the nearest half cell, dots the rest, and keeps its cap",
    () => {
      const barAt = (used: number, cap: number) =>
        barRow(
          usageRows({ limited: true, fiveHour: { used, cap, exceeded: false } }),
          "5-hour",
        )?.[0]
      // The pinned glyph set: full cell, half cell, empty dot, end cap.
      assertEqual(barAt(0, 1), `${"·".repeat(32)}▏`)
      assertEqual(barAt(0.06, 1), `${"█".repeat(2)}${"·".repeat(30)}▏`)
      assertEqual(barAt(0.36, 1), `${"█".repeat(11)}▌${"·".repeat(20)}▏`)
      assertEqual(barAt(0.5, 1), `${"█".repeat(16)}${"·".repeat(16)}▏`)
      assertEqual(barAt(1, 1), `${"█".repeat(32)}▏`)
    },
  ],

  [
    "the summary sub-section renders only the totals the summary carries",
    () => {
      const rows = (totals: UsageTotals) =>
        usageRows({ limited: true, totals, fiveHour: { used: 0, cap: 1, exceeded: false } })
      assertEqual(label(rows({ tokensIn: 1000 }), "Token In"), ["Token In", "1K"])
      assertEqual(label(rows({ tokensOut: 500 }), "Token Out"), ["Token Out", "500"])
      // A total without the in/out split falls back to the one `Tokens` line.
      assertEqual(label(rows({ tokens: 2000 }), "Tokens"), ["Tokens", "2K"])
      assertEqual(label(rows({ tokensIn: 1000, tokensOut: 500 }), "Tokens"), undefined)
      assertEqual(label(rows({ requests: 12 }), "Request"), ["Request", "12"])
      assertEqual(label(rows({ cost: 0 }), "Total Spent"), ["Total Spent", "$0.00"])
      for (const name of ["Token In", "Token Out", "Tokens", "Request", "Total Spent"]) {
        assertEqual(label(rows({}), name), undefined, `${name} must not render without data`)
      }
    },
  ],

  [
    "the Extra Credit row renders the purchased balance, whatever its value",
    () => {
      const extra = (purchasedCredits?: number) =>
        label(
          usageRows({
            limited: true,
            fiveHour: { used: 0, cap: 1, exceeded: false },
            ...(purchasedCredits === undefined ? {} : { purchasedCredits }),
          }),
          "Extra Credit",
        )
      assertEqual(extra(4.81934405), ["Extra Credit", "$4.82"])
      assertEqual(extra(0), ["Extra Credit", "$0.00"], "a zero balance is shown, not hidden")
      assertEqual(extra(undefined), undefined, "no parsed balance, no row")
      // The balance alone keeps the segment renderable — no meters needed.
      assertEqual(label(usageRows({ purchasedCredits: 5 }), "Extra Credit"), [
        "Extra Credit",
        "$5.00",
      ])
    },
  ],

  [
    "the module carries no TUI runtime and no host-package runtime imports",
    () => {
      // #242's purity seams: the renderer runs in the panel but the module is
      // host-agnostic — solid-js and @opencode-ai/* may not appear at all.
      const source = readFileSync(
        new URL("../src/deals/usage.ts", import.meta.url).pathname,
        "utf-8",
      )
      assert(!/from\s+["']solid-js["']/.test(source), "no solid-js import")
      assert(!/from\s+["']@opencode-ai\//.test(source), "no @opencode-ai/* import")
      assert(!/from\s+["']@opencode\//.test(source), "no @opencode/* import")
    },
  ],
])
