// tests/tui-usage-refresh.test.ts — the usage segment's event-driven refresh
// policy (issue #245), driven by the fake-clock harness
// (tests/helpers/fake-clock.ts) against the real fetch orchestrator and a
// recording mock (never the network). The acceptance counts live here: 4
// requests on mount, 2 per cooled-down turn refresh, 0 while idle and 0 for
// turns inside the cooldown (coalesced into one trailing refresh), the local
// countdown clock with one confirmation per window roll, the 5 → 10 → 20 → 30
// minute failure backoff with its success reset, and unmount cleanup.
import { createUsagePanel, type UsagePanel, type UsagePanelState } from "../src/deals/tui-usage.js"
import { renderUsageRows, type UsageResult } from "../src/deals/usage.js"
import { subscribeV1Idle } from "../src/deals/tui.js"
import { createFakeClock, type FakeClock } from "./helpers/fake-clock.js"
import { assert, assertEqual, run } from "./harness.js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

const BASE = "http://mock"
const WHOAMI = "/alpha/whoami"
const SUBSCRIPTIONS = "/alpha/billing/subscriptions"
const CREDITS = "/alpha/billing/credits"
const SUMMARY = "/alpha/usage/summary"
const MINUTE = 60_000
const HOUR = 3_600_000

const NOW = Date.parse("2026-10-01T12:00:00.000Z")
const PERIOD_START = "2026-09-05T00:00:00.000Z"
const PERIOD_END = "2026-10-05T00:00:00.000Z"
/** The far-future reset most fixtures carry: no roll fires during a test. */
const FAR_RESET = NOW + 6 * HOUR

/** The fixture resets: windows default to the far-future (idle-countdown) case. */
interface FixtureResets {
  fiveHourResetAt?: number
  weeklyResetAt?: number
}

/** The four billing answers of a live Go account, with settable window resets. */
function billingBodies(resets: FixtureResets = {}): Record<string, unknown> {
  return {
    [WHOAMI]: { success: true, org: null },
    [SUBSCRIPTIONS]: {
      success: true,
      data: {
        status: "active",
        planId: "individual-go",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
      },
    },
    [CREDITS]: {
      windowLimits: {
        limited: true,
        fiveHour: {
          used: 0.5,
          cap: 3,
          exceeded: false,
          ...(resets.fiveHourResetAt === undefined ? {} : { resetAt: resets.fiveHourResetAt }),
        },
        weekly: {
          used: 1.5,
          cap: 6,
          exceeded: false,
          resetAt: resets.weeklyResetAt ?? FAR_RESET,
        },
      },
      credits: { monthlyCredits: 0.5 },
    },
    [SUMMARY]: { totalMonthlyCredits: 39.5 },
  }
}

interface Harness {
  panel: UsagePanel
  clock: FakeClock
  /** Every request URL the recording fetch saw, in order. */
  urls: string[]
  /** Every countdown-clock tick's instant. */
  ticks: number[]
  /** Mutate the payloads the stub serves (a roll, an upstream change). */
  bodies: Record<string, unknown>
  /** Flip the stub into failing every leg. */
  setFailing(on: boolean): void
}

/**
 * A mounted-path panel over the real fetch orchestrator: the v1 host's
 * provider-record credential, a recording fetch that can be flipped to fail,
 * and the fake clock. Nothing here touches the network.
 */
function harness(options: FixtureResets = {}): Harness {
  const clock = createFakeClock(NOW)
  const bodies = billingBodies(options)
  const urls: string[] = []
  const ticks: number[] = []
  let failing = false
  const fetchImpl = (async (url: string) => {
    urls.push(url)
    if (failing) return new Response("boom", { status: 500 })
    const path = new URL(url).pathname
    return new Response(JSON.stringify(bodies[path]), { status: 200 })
  }) as unknown as typeof fetch
  const panel = createUsagePanel(
    () => ({ host: "v1", providers: [{ id: "commandcode", key: "v1_key" }] }),
    {
      credential: { env: {}, authPaths: [] },
      fetchOptions: { baseURL: BASE, fetch: fetchImpl, env: {} },
      clock,
      onTick: (now) => ticks.push(now),
    },
  )
  return {
    panel,
    clock,
    urls,
    ticks,
    bodies,
    setFailing: (on) => {
      failing = on
    },
  }
}

/** The request paths, for order and count assertions. */
function paths(h: Harness): string[] {
  return h.urls.map((url) => new URL(url).pathname)
}

/** The stub's mutable weekly window, for carrying the next roll's reset. */
function weeklyWindow(h: Harness): { resetAt: number } {
  return (h.bodies[CREDITS] as { windowLimits: { weekly: { resetAt: number } } }).windowLimits
    .weekly
}

/** The rendered `Weekly` meter value at the panel's current clock instant. */
function weeklyValue(h: Harness): string {
  const state = h.panel.state()
  if (state?.result.state !== "usage") throw new Error("the panel holds a usage snapshot")
  const rows = renderUsageRows(state.result, { provenance: state.provenance, now: h.clock.now() })
  const row = rows.find(([label]) => label === "Weekly")
  if (row === undefined) throw new Error("the Weekly meter must render")
  return row[1]
}

run([
  [
    "the mount chain spends four requests and an idle session spends nothing",
    async () => {
      const h = harness()
      await h.panel.mount()
      assertEqual(paths(h), [WHOAMI, SUBSCRIPTIONS, CREDITS, SUMMARY], "4 on mount")
      await h.clock.advance(30 * MINUTE)
      assertEqual(h.urls.length, 4, "an idle session must not touch the network")
      // The countdown clock ran locally the whole time — one tick per 30s.
      assertEqual(h.ticks.length, 60, "the local clock kept ticking")
    },
  ],

  [
    "a cooled-down turn refresh spends exactly credits + summary",
    async () => {
      const h = harness()
      await h.panel.mount()
      await h.clock.advance(5 * MINUTE)
      h.panel.turnCompleted()
      await h.clock.advance(0)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "the two-request refresh")
      // The cached scope still scopes and pins the live legs.
      assertEqual(
        new URL(h.urls[5]!).searchParams.get("since"),
        PERIOD_START,
        "the summary keeps its period pin",
      )
    },
  ],

  [
    "signals inside the cooldown coalesce into one trailing refresh",
    async () => {
      const h = harness()
      await h.panel.mount()
      await h.clock.advance(MINUTE)
      h.panel.turnCompleted()
      await h.clock.advance(MINUTE)
      h.panel.turnCompleted()
      await h.clock.advance(2 * MINUTE)
      assertEqual(h.urls.length, 4, "inside the cooldown nothing fires")
      await h.clock.advance(MINUTE)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "one trailing refresh at +5m")
      await h.clock.advance(10 * MINUTE)
      assertEqual(h.urls.length, 6, "one trailing refresh, not one per signal")
    },
  ],

  [
    "signals during an in-flight chain coalesce into one trailing refresh",
    async () => {
      const h = harness()
      await h.panel.mount()
      await h.clock.advance(5 * MINUTE)
      h.panel.turnCompleted()
      // The second signal lands before the first chain's fetch settles: one
      // chain in flight at a time.
      h.panel.turnCompleted()
      await h.clock.advance(0)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "one chain at a time")
      await h.clock.advance(5 * MINUTE)
      assertEqual(paths(h).slice(6), [CREDITS, SUMMARY], "the coalesced trailing refresh")
      await h.clock.advance(10 * MINUTE)
      assertEqual(h.urls.length, 8, "exactly one trailing refresh")
    },
  ],

  [
    "an idle signal for another session does not refresh",
    async () => {
      const h = harness()
      await h.panel.mount()
      await h.clock.advance(5 * MINUTE)
      const handlers: Array<(event: { properties: { sessionID: string } }) => void> = []
      const api = {
        event: {
          on: (_type: string, handler: (event: { properties: { sessionID: string } }) => void) => {
            handlers.push(handler)
            return () => {}
          },
        },
      } as unknown as TuiPluginApi
      const unsubscribe = subscribeV1Idle(
        api,
        () => "ses_1",
        () => h.panel.turnCompleted(),
      )
      handlers[0]!({ properties: { sessionID: "ses_2" } })
      await h.clock.advance(0)
      assertEqual(h.urls.length, 4, "another session's turn is not this panel's")
      handlers[0]!({ properties: { sessionID: "ses_1" } })
      await h.clock.advance(0)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "the watched session refreshes")
      unsubscribe()
    },
  ],

  [
    "countdown ticks are local, and a roll schedules exactly one confirmation refresh",
    async () => {
      const h = harness({ weeklyResetAt: NOW + 90_000 })
      await h.panel.mount()
      assertEqual(weeklyValue(h), "$1.50 / $6.00 · 25% · resets in 2m")
      await h.clock.advance(MINUTE)
      assertEqual(weeklyValue(h), "$1.50 / $6.00 · 25% · resets in 1m", "the tick re-rendered")
      assertEqual(h.urls.length, 4, "ticks make no request")

      // The reset instant passes inside the throttle window: one confirmation
      // is owed, and it waits for the cooldown rather than firing per tick.
      await h.clock.advance(30_000)
      assertEqual(h.urls.length, 4, "the confirmation waits for the throttle")

      // The confirming refresh sees the new window.
      weeklyWindow(h).resetAt = NOW + 5 * HOUR + 5 * MINUTE
      await h.clock.advance(4 * MINUTE)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "one confirming refresh")
      assertEqual(weeklyValue(h), "$1.50 / $6.00 · 25% · resets in 5h", "the roll confirmed")
      await h.clock.advance(30 * MINUTE)
      assertEqual(h.urls.length, 6, "at most one refresh per window roll")
    },
  ],

  [
    "a 5-hour roll is confirmed once too — each window runs its own branch",
    async () => {
      const h = harness({ fiveHourResetAt: NOW + 90_000 })
      await h.panel.mount()
      await h.clock.advance(90_000)
      await h.clock.advance(4 * MINUTE)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "one confirmation for the 5-hour roll")
      await h.clock.advance(30 * MINUTE)
      assertEqual(h.urls.length, 6, "the same 5-hour reset is never confirmed twice")
    },
  ],

  [
    "a later roll of the same window is confirmed again",
    async () => {
      const h = harness({ weeklyResetAt: NOW + 60_000 })
      await h.panel.mount()
      await h.clock.advance(MINUTE)
      // The first confirmation's payload carries the window's next roll.
      weeklyWindow(h).resetAt = NOW + 6 * MINUTE
      await h.clock.advance(4 * MINUTE)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "the first roll's confirmation")
      await h.clock.advance(MINUTE) // +6m: the next roll passes
      await h.clock.advance(4 * MINUTE) // +10m: the throttle from +5m
      assertEqual(paths(h).slice(6), [CREDITS, SUMMARY], "the second roll confirms again")
      await h.clock.advance(20 * MINUTE)
      assertEqual(h.urls.length, 8, "once per roll, no more")
    },
  ],

  [
    "a roll whose refresh still reports the past reset is never confirmed twice",
    async () => {
      const h = harness({ weeklyResetAt: NOW + 60_000 })
      await h.panel.mount()
      await h.clock.advance(MINUTE)
      await h.clock.advance(4 * MINUTE)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "the one confirmation")
      await h.clock.advance(30 * MINUTE)
      assertEqual(h.urls.length, 6, "the same past resetAt never fires again")
    },
  ],

  [
    "failure backoff doubles 5 → 10 → 20 → 30 minutes and a success resets it",
    async () => {
      const h = harness()
      await h.panel.mount()
      assertEqual(h.urls.length, 4)
      h.setFailing(true)

      // +5m: a cooled-down turn refresh, whose chain fails.
      await h.clock.advance(5 * MINUTE)
      h.panel.turnCompleted()
      await h.clock.advance(0)
      assertEqual(paths(h).slice(4), [CREDITS, SUMMARY], "the first failing refresh")
      assertEqual(h.panel.state()?.result.state, "usage", "the snapshot stayed on screen")

      // Each later signal coalesces into one attempt at the backoff boundary:
      // nothing may run before it, and the attempt must land exactly there —
      // a shorter (undoubled) delay would fire inside the first leg of the
      // advance, which the empty slice would catch.
      const attemptAfter = async (
        wait: number,
        expected: string[],
        label: string,
      ): Promise<void> => {
        const before = h.urls.length
        h.panel.turnCompleted()
        await h.clock.advance(wait - MINUTE)
        assertEqual(h.urls.length, before, `${label}: nothing before the boundary`)
        await h.clock.advance(MINUTE)
        assertEqual(paths(h).slice(before), expected, label)
        assertEqual(h.panel.state()?.result.state, "usage", `${label}: last-good stays`)
      }
      await attemptAfter(5 * MINUTE, [CREDITS, SUMMARY], "5 minutes after failure 1")
      await attemptAfter(10 * MINUTE, [CREDITS, SUMMARY], "10 minutes after failure 2")
      await attemptAfter(20 * MINUTE, [CREDITS, SUMMARY], "20 minutes after failure 3")
      // Failure 4's next attempt at +70m caps the ladder: a double would land
      // at +80m and the assertion above would miss it.
      await attemptAfter(
        30 * MINUTE,
        [SUBSCRIPTIONS, CREDITS, SUMMARY],
        "the capped 30-minute step after failure 4",
      )

      // A success resets the ladder: after this attempt's re-read, the next
      // failing refresh backs off 5 minutes again, not the 30-minute cap.
      h.setFailing(false)
      const beforeSuccess = h.urls.length
      h.panel.turnCompleted()
      await h.clock.advance(30 * MINUTE)
      assertEqual(
        paths(h).slice(beforeSuccess),
        [SUBSCRIPTIONS, CREDITS, SUMMARY],
        "the capped attempt succeeds",
      )
      h.setFailing(true)
      const beforeRelapse = h.urls.length
      h.panel.turnCompleted()
      await h.clock.advance(5 * MINUTE)
      assertEqual(paths(h).slice(beforeRelapse), [CREDITS, SUMMARY], "the ladder restarted at 5m")
    },
  ],

  [
    "unmount stops the clock and the pending refresh",
    async () => {
      const h = harness()
      await h.panel.mount()
      await h.clock.advance(MINUTE)
      h.panel.turnCompleted()
      const ticksSoFar = h.ticks.length
      h.panel.unmount()
      await h.clock.advance(30 * MINUTE)
      assertEqual(h.urls.length, 4, "no request after unmount")
      assertEqual(h.ticks.length, ticksSoFar, "the countdown clock stopped")
      assertEqual(h.clock.pending(), 0, "every timer was cancelled")
    },
  ],

  [
    "unmount aborts an in-flight chain",
    async () => {
      const clock = createFakeClock(NOW)
      const changes: UsagePanelState[] = []
      let signal: AbortSignal | undefined
      const panel = createUsagePanel(
        () => ({ host: "v1", providers: [{ id: "commandcode", key: "k" }] }),
        {
          credential: { env: {}, authPaths: [] },
          clock,
          resolveCredential: async () => ({ key: "k", source: { kind: "host" } }),
          fetchSnapshot: (options) => {
            signal = options.signal
            return new Promise<UsageResult>((_, reject) => {
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")))
            })
          },
          onChange: (state) => changes.push(state),
        },
      )
      void panel.mount()
      await new Promise((resolve) => setImmediate(resolve))
      assert(signal !== undefined, "the chain reached the fetch")
      panel.unmount()
      assertEqual(signal?.aborted, true, "unmount cancels the in-flight fetch")
      await new Promise((resolve) => setImmediate(resolve))
      assertEqual(changes, [], "an aborted chain publishes nothing")
      assertEqual(panel.state(), undefined, "no state was published")
    },
  ],
])
