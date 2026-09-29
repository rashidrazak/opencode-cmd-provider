// tests/usage.test.ts — the live usage snapshot (issue #242): the four-leg
// billing fetch against a recording mock (never the network), its defensive
// parse, and the pinned `Usage` segment rows. Rendering is pure — every
// fixture passes its own `now` — and this file never imports the TUI runtime.
import { readFileSync } from "node:fs"
import {
  fetchUsageSnapshot,
  renderUsageRows,
  type UsageCredentialSource,
  type UsageResult,
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

/** The text of the muted value line starting with `prefix`, if it rendered. */
function valueLine(rows: DealsRow[], prefix: string): string | undefined {
  return rows.find(([name, , kind]) => kind === "value" && name.startsWith(prefix))?.[0]
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
        assert(valueLine(rows, "This cycle:") !== undefined, "the summary totals still render")
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
        assert(valueLine(rows, "This cycle:") !== undefined)
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
        assert(valueLine(rows, "This cycle:") !== undefined, "the totals leg is untouched")
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
        assertEqual(valueLine(rows, "This cycle:"), undefined, "no summary leg, no totals")
      }
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
  // Render: the pinned segment and every degradation variant.
  // ---------------------------------------------------------------------------

  [
    "renders the full pinned segment: heading, three meters, cycle totals, provenance",
    () => {
      const snapshot: UsageSnapshot = {
        plan: "go",
        limited: true,
        fiveHour: { used: 0.5, cap: 3, exceeded: false },
        weekly: { used: 1.53, cap: 6, exceeded: false, resetAt: NOW + (4 * 60 + 32) * 60_000 },
        monthly: { used: 9.41, cap: 40 },
        totals: {
          requests: 7020,
          tokens: 1135619637,
          tokensIn: 1129787188,
          tokensOut: 5832449,
          cost: 9.41,
        },
        periodEnd: NOW + 5 * DAY,
      }
      assertEqual(
        renderUsageRows({ state: "usage", snapshot }, { provenance: { kind: "host" }, now: NOW }),
        [
          ["", ""],
          ["Usage", "", "heading"],
          ["5-hour", "$0.50 / $3.00 · 17%"],
          ["Weekly", "$1.53 / $6.00 · 26% · resets in 4h 32m"],
          ["Monthly", "$9.41 / $40.00 · 24% · renews in 5d"],
          [
            "This cycle: 7,020 requests · 1.14B tokens (1.13B in / 5.83M out) · $9.41 spent",
            "",
            "value",
          ],
          ["via Host connection", "", "value"],
        ],
      )
    },
  ],

  [
    "an idle window renders used/cap with no countdown",
    () => {
      assertEqual(
        renderUsageRows(
          {
            state: "usage",
            snapshot: { limited: true, fiveHour: { used: 0, cap: 3, exceeded: false } },
          },
          { now: NOW },
        ),
        [
          ["", ""],
          ["Usage", "", "heading"],
          ["5-hour", "$0.00 / $3.00 · 0%"],
        ],
      )
    },
  ],

  [
    "limited:false renders the pay-as-you-go line and skips the rolling meters",
    () => {
      assertEqual(
        renderUsageRows(
          {
            state: "usage",
            snapshot: {
              plan: "provider",
              limited: false,
              fiveHour: { used: 5, cap: 3, exceeded: true },
              weekly: { used: 5, cap: 6, exceeded: false },
              totals: { requests: 12, cost: 1.5 },
            },
          },
          { now: NOW },
        ),
        [
          ["", ""],
          ["Usage", "", "heading"],
          ["No rolling windows on this plan — usage is pay-as-you-go", "", "value"],
          ["This cycle: 12 requests · $1.50 spent", "", "value"],
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
      const rows = renderUsageRows(
        {
          state: "usage",
          snapshot: {
            limited: true,
            fiveHour: { used: 10, cap: 4, exceeded: true },
            weekly: { used: 0, cap: 0, exceeded: false },
            monthly: { used: 1.5, cap: 3.5 },
            totals: { requests: 1234567, tokens: 999999, cost: 2.5 },
          },
        },
        { now: NOW },
      )
      assertEqual(label(rows, "5-hour"), ["5-hour", "$10.00 / $4.00 · 100%"])
      assertEqual(label(rows, "Weekly"), ["Weekly", "$0.00 / $0.00 · 0%"])
      assertEqual(label(rows, "Monthly"), ["Monthly", "$1.50 / $3.50 · 43%"])
      assertEqual(
        valueLine(rows, "This cycle:"),
        "This cycle: 1,234,567 requests · 1M tokens · $2.50 spent",
      )
    },
  ],

  [
    "a window with no cap renders used-only, never a fabricated cap",
    () => {
      const rows = renderUsageRows(
        {
          state: "usage",
          snapshot: {
            limited: true,
            fiveHour: { used: 1.5, exceeded: false, resetAt: NOW + 30 * 60_000 },
          },
        },
        { now: NOW },
      )
      assertEqual(label(rows, "5-hour"), ["5-hour", "$1.50 used · resets in 30m"])
    },
  ],

  [
    "countdowns use the CLI's d/h/m format and stop at the reset",
    () => {
      const countdown = (ms: number) =>
        label(
          renderUsageRows(
            {
              state: "usage",
              snapshot: {
                limited: true,
                fiveHour: { used: 0, cap: 1, exceeded: false, resetAt: NOW + ms },
              },
            },
            { now: NOW },
          ),
          "5-hour",
        )?.[1]
      assertEqual(countdown(2 * DAY + 3 * HOUR), "$0.00 / $1.00 · 0% · resets in 2d 3h")
      assertEqual(countdown(HOUR + 5 * 60_000), "$0.00 / $1.00 · 0% · resets in 1h 5m")
      assertEqual(countdown(59_000), "$0.00 / $1.00 · 0% · resets in 1m")
      // A reset that already passed carries no countdown.
      assertEqual(countdown(-HOUR), "$0.00 / $1.00 · 0%")
    },
  ],

  [
    "the renewal reads in whole days, floored at today",
    () => {
      const monthlyAt = (periodEnd: number | undefined) =>
        label(
          renderUsageRows(
            {
              state: "usage",
              snapshot: { limited: true, monthly: { used: 1, cap: 10 }, periodEnd },
            },
            { now: NOW },
          ),
          "Monthly",
        )
      assertEqual(monthlyAt(NOW + 5 * DAY), ["Monthly", "$1.00 / $10.00 · 10% · renews in 5d"])
      // Four hours still rounds to a day (the CLI's ceil), not "renews today".
      assertEqual(monthlyAt(NOW + 2 * HOUR), ["Monthly", "$1.00 / $10.00 · 10% · renews in 1d"])
      assertEqual(monthlyAt(NOW - HOUR), ["Monthly", "$1.00 / $10.00 · 10% · renews today"])
      assertEqual(monthlyAt(undefined), ["Monthly", "$1.00 / $10.00 · 10%"])
    },
  ],

  [
    "the provenance line names the rung, and a file label stays inert",
    () => {
      const rows = (provenance?: UsageCredentialSource) =>
        renderUsageRows(
          {
            state: "usage",
            snapshot: { limited: true, fiveHour: { used: 0, cap: 3, exceeded: false } },
          },
          { now: NOW, provenance },
        )
      assertEqual(valueLine(rows({ kind: "host" }), "via "), "via Host connection")
      assertEqual(valueLine(rows({ kind: "environment" }), "via "), "via COMMANDCODE_API_KEY")
      // A store's path is data: it cannot break the line or its code span.
      assertEqual(
        valueLine(rows({ kind: "file", label: "~/.command\ncode/auth.json" }), "via "),
        "via legacy file `~/.command code/auth.json`",
      )
      assertEqual(
        valueLine(rows({ kind: "file", label: "auth|`file`.json" }), "via "),
        "via legacy file `auth file .json`",
      )
      // An empty store label still names the rung.
      assertEqual(valueLine(rows({ kind: "file", label: "  " }), "via "), "via legacy file")
      assertEqual(valueLine(rows(undefined), "via "), undefined)
    },
  ],

  [
    "the cycle line renders only the totals the summary carries",
    () => {
      const cycle = (totals: UsageTotals) =>
        valueLine(
          renderUsageRows(
            {
              state: "usage",
              snapshot: { limited: true, totals, fiveHour: { used: 0, cap: 1, exceeded: false } },
            },
            { now: NOW },
          ),
          "This cycle:",
        )
      assertEqual(cycle({ requests: 12 }), "This cycle: 12 requests")
      assertEqual(cycle({ cost: 0 }), "This cycle: $0.00 spent")
      assertEqual(cycle({ tokensIn: 1000 }), "This cycle: 1K in tokens")
      assertEqual(cycle({ tokensIn: 1000, tokensOut: 500 }), "This cycle: 1K in / 500 out tokens")
      assertEqual(cycle({}), undefined)
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
