// tests/retry.test.ts — retry, abort and timeout helpers (PLAN #4, port of pi's
// test-retry math tests + abort/timeout races)
import {
  abortError,
  delay,
  isRetryableStatus,
  parseRetryAfterSeconds,
  raceAbort,
  raceAbortWithTimeout,
  retryDelayMs,
  timeoutError,
} from "../src/provider/retry.js"
import { assert, assertEqual, rejects, run } from "./harness.js"

run([
  ["429 and 5xx are retryable", () => {
    assertEqual(isRetryableStatus(429), true)
    assertEqual(isRetryableStatus(500), true)
    assertEqual(isRetryableStatus(503), true)
    assertEqual(isRetryableStatus(401), false)
    assertEqual(isRetryableStatus(400), false)
  }],

  ["Retry-After seconds are parsed", () => {
    assertEqual(parseRetryAfterSeconds("2"), 2)
    assertEqual(parseRetryAfterSeconds("abc"), undefined)
    assertEqual(parseRetryAfterSeconds(null), undefined)
  }],

  ["backoff doubles with jitter capped by max", () => {
    const delays = new Set<number>()
    for (let i = 0; i < 200; i++) {
      delays.add(retryDelayMs(0, null, 1000))
      delays.add(retryDelayMs(1, null, 1000))
    }
    for (const d of delays) {
      assert(d >= 500 && d <= 1000, `delay ${d} out of range`)
    }
  }],

  ["Retry-After above max returns -1", () => {
    assertEqual(retryDelayMs(0, "9999", 60_000), -1)
  }],

  ["Retry-After within max is used directly", () => {
    assertEqual(retryDelayMs(0, "3", 60_000), 3000)
  }],

  ["abortError is a DOMException named AbortError", () => {
    const err = abortError()
    assertEqual(err.name, "AbortError")
    assert(err instanceof Error)
  }],

  ["timeoutError carries a timed-out message", () => {
    assertEqual(timeoutError(5000).message, "Command Code API request timed out after 5000ms")
    assert(timeoutError(undefined).message.includes("timed out"), "default timeout message")
  }],

  ["raceAbort resolves on promise and rejects on abort", async () => {
    const controller = new AbortController()
    const resolved = await raceAbort(Promise.resolve("ok"), controller.signal)
    assertEqual(resolved, "ok")
    controller.abort()
    await rejects(
      raceAbort(new Promise(() => {}), controller.signal),
      (e) => (e as Error).name === "AbortError",
    )
  }],

  ["raceAbort rejects immediately when signal already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await rejects(
      raceAbort(Promise.resolve("ok"), controller.signal),
      (e) => (e as Error).name === "AbortError",
    )
  }],

  ["raceAbortWithTimeout rejects with timeout error after deadline", async () => {
    const controller = new AbortController()
    await rejects(
      raceAbortWithTimeout(new Promise(() => {}), controller, 30),
      /timed out/,
    )
  }],

  ["raceAbortWithTimeout without timeout delegates to raceAbort", async () => {
    const controller = new AbortController()
    const resolved = await raceAbortWithTimeout(Promise.resolve("ok"), controller, undefined)
    assertEqual(resolved, "ok")
  }],

  ["delay resolves after the requested time", async () => {
    const controller = new AbortController()
    const started = Date.now()
    await delay(20, controller.signal)
    assert(Date.now() - started >= 15, "delay returned too early")
  }],

  ["delay rejects with AbortError when aborted mid-sleep", async () => {
    const controller = new AbortController()
    const sleeping = delay(10_000, controller.signal)
    controller.abort()
    await rejects(sleeping, (e) => (e as Error).name === "AbortError")
  }],

  ["delay rejects immediately when signal already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await rejects(delay(0, controller.signal), (e) => (e as Error).name === "AbortError")
  }],
])
