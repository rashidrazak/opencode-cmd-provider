// tests/retry.test.ts — retry, abort and timeout helpers (PLAN #4, port of pi's
// test-retry math tests + abort/timeout races), plus the causal failure
// classification the transport's ladder replays on (issue #171): a failure is
// retried only when its own kind says so.
import {
  abortError,
  classifyHttpFailure,
  classifyStreamError,
  delay,
  hasTerminalErrorMarker,
  isRetryableStatus,
  parseRetryAfterSeconds,
  raceAbort,
  raceAbortWithTimeout,
  resolveUsageWindow,
  retryAfterGate,
  retryBackoffMs,
  timeoutError,
  UPGRADE_REQUIRED_FAILURE,
  VERSION_GATE_FAILURE,
} from "../src/provider/retry.js"
import { assert, assertEqual, rejects, run } from "./harness.js"

run([
  [
    "408, 429 and 5xx are retryable",
    () => {
      assertEqual(isRetryableStatus(408), true)
      assertEqual(isRetryableStatus(429), true)
      assertEqual(isRetryableStatus(500), true)
      assertEqual(isRetryableStatus(503), true)
      assertEqual(isRetryableStatus(401), false)
      assertEqual(isRetryableStatus(400), false)
    },
  ],

  [
    "Retry-After seconds are parsed",
    () => {
      assertEqual(parseRetryAfterSeconds("2"), 2)
      assertEqual(parseRetryAfterSeconds("abc"), undefined)
      assertEqual(parseRetryAfterSeconds(null), undefined)
    },
  ],

  [
    "the ladder is min(10 s, max(1 s, 500 ms·2^attempt)) with no jitter",
    () => {
      assertEqual(retryBackoffMs(0, 60_000), 1000)
      assertEqual(retryBackoffMs(1, 60_000), 1000)
      assertEqual(retryBackoffMs(2, 60_000), 2000)
      assertEqual(retryBackoffMs(3, 60_000), 4000)
      assertEqual(retryBackoffMs(4, 60_000), 8000)
      assertEqual(retryBackoffMs(5, 60_000), 10_000)
      assertEqual(retryBackoffMs(9, 60_000), 10_000)
    },
  ],

  [
    "maxRetryDelayMs bounds the ladder too, so a lowered cap shortens the wait",
    () => {
      assertEqual(retryBackoffMs(0, 0), 0)
      assertEqual(retryBackoffMs(4, 1500), 1500)
    },
  ],

  [
    "Retry-After is a gate: wait, exceeds-cap, or absent",
    () => {
      assertEqual(retryAfterGate(null, 60_000), { kind: "none" })
      assertEqual(retryAfterGate("abc", 60_000), { kind: "none" })
      assertEqual(retryAfterGate("3", 60_000), { kind: "wait", waitMs: 3000 })
      assertEqual(retryAfterGate("0", 0), { kind: "wait", waitMs: 0 })
      assertEqual(retryAfterGate("9999", 60_000), { kind: "exceeds-cap", waitMs: 9_999_000 })
    },
  ],

  [
    "HTTP classification: fatal 4xx, retryable 408/429/5xx, window limits",
    () => {
      for (const status of [400, 401, 403, 404, 422]) {
        assertEqual(
          classifyHttpFailure({ status, maxDelayMs: 60_000 }),
          { kind: "fatal-status", retryable: false, status },
          `status ${status}`,
        )
      }
      assertEqual(classifyHttpFailure({ status: 408, maxDelayMs: 60_000 }), {
        kind: "retryable-status",
        retryable: true,
        status: 408,
      })
      assertEqual(classifyHttpFailure({ status: 503, maxDelayMs: 60_000 }), {
        kind: "retryable-status",
        retryable: true,
        status: 503,
      })
      // A plain 429 is a burst limit: transient, unlike the window limit below.
      assertEqual(
        classifyHttpFailure({
          status: 429,
          body: { error: { message: "rate limited" } },
          maxDelayMs: 60_000,
        }),
        { kind: "retryable-status", retryable: true, status: 429 },
      )
    },
  ],

  [
    "HTTP classification: a usage-window 429 is fatal, whatever its Retry-After",
    () => {
      // Upstream's parseWindowLimitError: RATE_LIMITED or 429 plus a window
      // label — from rateLimit.window or from the message.
      assertEqual(
        classifyHttpFailure({
          status: 429,
          body: {
            error: {
              message: "You've reached your weekly usage limit for your plan. Resets Monday.",
            },
          },
          retryAfter: "120",
          maxDelayMs: 60_000,
        }),
        { kind: "window-limit", retryable: false, status: 429 },
      )
      assertEqual(
        classifyHttpFailure({
          status: 429,
          body: { error: { code: "RATE_LIMITED", rateLimit: { window: "fiveHour" } } },
          maxDelayMs: 60_000,
        }),
        { kind: "window-limit", retryable: false, status: 429 },
      )
      // RATE_LIMITED without a window label is not a window limit (upstream
      // returns null from parseWindowLimitError), so it stays retryable.
      assertEqual(
        classifyHttpFailure({
          status: 429,
          body: { error: { code: "RATE_LIMITED", message: "slow down" } },
          maxDelayMs: 60_000,
        }),
        { kind: "retryable-status", retryable: true, status: 429 },
      )
    },
  ],

  [
    "HTTP classification: Retry-After above the cap is fatal, never a blind retry",
    () => {
      assertEqual(classifyHttpFailure({ status: 503, retryAfter: "9999", maxDelayMs: 60_000 }), {
        kind: "retry-after-cap",
        retryable: false,
        waitMs: 9_999_000,
        status: 503,
      })
      // A Retry-After the cap admits becomes the retry's wait.
      assertEqual(classifyHttpFailure({ status: 429, retryAfter: "2", maxDelayMs: 60_000 }), {
        kind: "retryable-status",
        retryable: true,
        waitMs: 2000,
        status: 429,
      })
    },
  ],

  [
    "stream classification: the server's own flag enters the ladder",
    () => {
      // The probe shape from issue #171: isRetryable on the error event.
      assertEqual(
        classifyStreamError({
          message: "Invalid error response format: Gateway request failed",
          reportedStatus: 520,
          retryableFlag: true,
        }),
        { kind: "stream-error", retryable: true, status: 520 },
      )
      // A reported transient status is retryable without the flag.
      assertEqual(classifyStreamError({ message: "upstream exploded", reportedStatus: 503 }), {
        kind: "stream-error",
        retryable: true,
        status: 503,
      })
      // A reported fatal status is not.
      assertEqual(classifyStreamError({ message: "bad request", reportedStatus: 400 }), {
        kind: "stream-error",
        retryable: false,
        status: 400,
      })
    },
  ],

  [
    "stream classification: absent signals default-retryable unless terminal",
    () => {
      assertEqual(classifyStreamError({ message: "upstream exploded" }), {
        kind: "stream-error",
        retryable: true,
      })
      assertEqual(classifyStreamError({ message: "boom", retryableFlag: false }), {
        kind: "stream-error",
        retryable: false,
      })
      for (const marker of [
        "premium_credits_exhausted",
        "model_not_in_plan",
        "insufficient credits",
      ]) {
        assertEqual(
          classifyStreamError({ message: `request failed: ${marker.toUpperCase()}` }),
          { kind: "stream-error", retryable: false },
          marker,
        )
      }
    },
  ],

  [
    "stream classification: the window gate outranks the server's retry flag",
    () => {
      // Upstream's composite rule (isModelCallRetryable) is
      // `isRetryable && !parseWindowLimitError`, so a window limit is never
      // replayed even when the event claims it is retryable.
      assertEqual(
        classifyStreamError({
          message: "You've reached your weekly usage limit for your plan",
          reportedStatus: 429,
          retryableFlag: true,
        }),
        { kind: "window-limit", retryable: false, status: 429 },
      )
      assertEqual(
        classifyStreamError({
          message: "usage limit reached",
          code: "RATE_LIMITED",
          window: "weekly",
          retryableFlag: true,
        }),
        { kind: "window-limit", retryable: false },
      )
    },
  ],

  [
    "usage-window vocabulary mirrors upstream resolveWindowLabel",
    () => {
      assertEqual(resolveUsageWindow("fiveHour", ""), "5-hour")
      assertEqual(resolveUsageWindow("weekly", ""), "weekly")
      assertEqual(resolveUsageWindow("daily", ""), "daily")
      assertEqual(resolveUsageWindow(undefined, "usage limit for your plan"), "5-hour")
      assertEqual(resolveUsageWindow(undefined, "Weekly usage limit for your plan"), "weekly")
      assertEqual(resolveUsageWindow(undefined, "rate limited"), undefined)
      assertEqual(resolveUsageWindow("monthly", ""), undefined)
      assertEqual(hasTerminalErrorMarker("Payment required: insufficient credits"), true)
      assertEqual(hasTerminalErrorMarker("transient overload"), false)
    },
  ],

  [
    "the transport-flip failure is classified as such and never replayed",
    () => {
      // The one kind the ladder must not handle: the model flips the session to
      // the legacy transport instead (issue #56), so `retryable` is false.
      assertEqual(UPGRADE_REQUIRED_FAILURE, {
        kind: "upgrade-required",
        retryable: false,
        status: 403,
      })
    },
  ],

  [
    "the version-gate failure is a fatal status, never replayed and never a flip",
    () => {
      // Issue #173: the server refused this client's reported version. Nothing
      // about the plan changed, so it is a plain fatal 403 — not the
      // upgrade-required kind that flips transports.
      assertEqual(VERSION_GATE_FAILURE, {
        kind: "fatal-status",
        retryable: false,
        status: 403,
      })
    },
  ],

  [
    "abortError is a DOMException named AbortError",
    () => {
      const err = abortError()
      assertEqual(err.name, "AbortError")
      assert(err instanceof Error)
    },
  ],

  [
    "timeoutError carries a timed-out message",
    () => {
      assertEqual(timeoutError(5000).message, "Command Code API request timed out after 5000ms")
      assert(timeoutError(undefined).message.includes("timed out"), "default timeout message")
    },
  ],

  [
    "raceAbort resolves on promise and rejects on abort",
    async () => {
      const controller = new AbortController()
      const resolved = await raceAbort(Promise.resolve("ok"), controller.signal)
      assertEqual(resolved, "ok")
      controller.abort()
      await rejects(
        raceAbort(new Promise(() => {}), controller.signal),
        (e) => (e as Error).name === "AbortError",
      )
    },
  ],

  [
    "raceAbort rejects immediately when signal already aborted",
    async () => {
      const controller = new AbortController()
      controller.abort()
      await rejects(
        raceAbort(Promise.resolve("ok"), controller.signal),
        (e) => (e as Error).name === "AbortError",
      )
    },
  ],

  [
    "raceAbortWithTimeout rejects with timeout error after deadline",
    async () => {
      const controller = new AbortController()
      await rejects(raceAbortWithTimeout(new Promise(() => {}), controller, 30), /timed out/)
    },
  ],

  [
    "raceAbortWithTimeout without timeout delegates to raceAbort",
    async () => {
      const controller = new AbortController()
      const resolved = await raceAbortWithTimeout(Promise.resolve("ok"), controller, undefined)
      assertEqual(resolved, "ok")
    },
  ],

  [
    "delay resolves after the requested time",
    async () => {
      const controller = new AbortController()
      const started = Date.now()
      await delay(20, controller.signal)
      assert(Date.now() - started >= 15, "delay returned too early")
    },
  ],

  [
    "delay rejects with AbortError when aborted mid-sleep",
    async () => {
      const controller = new AbortController()
      const sleeping = delay(10_000, controller.signal)
      controller.abort()
      await rejects(sleeping, (e) => (e as Error).name === "AbortError")
    },
  ],

  [
    "delay rejects immediately when signal already aborted",
    async () => {
      const controller = new AbortController()
      controller.abort()
      await rejects(delay(0, controller.signal), (e) => (e as Error).name === "AbortError")
    },
  ],
])
