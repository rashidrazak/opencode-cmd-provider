// src/provider/retry.ts — retry, abort and timeout helpers (PLAN #4, port of
// pi's core.ts retry math + abort races + signal-aware delay)
//
// Retry classification (issue #171) ports upstream `command-code@1.54.0`'s
// causal rule — `isModelCallRetryable` / `isStreamErrorRetryable` /
// `parseWindowLimitError` — onto this transport: a failure is replayed only
// when its own kind says it is transient, never because of where it was
// caught. The vocabulary is the one the issue names: network, 408/429/5xx,
// 4xx-fatal, window-limit (fatal), `upgrade_required` (a transport flip the
// model owns), truncation (retryable while nothing is visible), and the
// server's own mid-stream error event.

/**
 * Statuses upstream's `isRetryableStatus` treats as transient: 408, 429 and
 * 5xx. Deliberately not "any status we can reach" — 400/401/403/404/422 are
 * permanent for the request that produced them.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600)
}

export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000)
  return undefined
}

/** What a response's own `Retry-After` says about the wait. */
export type RetryAfterGate =
  { kind: "none" } | { kind: "wait"; waitMs: number } | { kind: "exceeds-cap"; waitMs: number }

/**
 * `Retry-After` as a wait gate, never as a retry decision of its own: the
 * server's delay is honoured while it fits `maxDelayMs`, and a delay beyond
 * the cap fails the request instead of being thrown into a generic retry
 * (issue #171). A wait of 0 is a real instruction — retry immediately.
 */
export function retryAfterGate(value: string | null, maxDelayMs: number): RetryAfterGate {
  const seconds = parseRetryAfterSeconds(value)
  if (seconds === undefined) return { kind: "none" }
  const waitMs = seconds * 1000
  return waitMs > maxDelayMs ? { kind: "exceeds-cap", waitMs } : { kind: "wait", waitMs }
}

// Upstream's ladder shape (`backoffMs`): min(10 s, max(1 s, base·2^attempt)),
// no jitter. This transport's base is 500 ms, so the first two attempts wait
// 1 s each — the plugin is one ladder inside the host's slower one, and it
// should fail fast rather than out-wait it. `maxRetryDelayMs` bounds the
// ladder as well as an honoured `Retry-After`.
const RETRY_BASE_DELAY_MS = 500
const RETRY_MIN_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 10_000

export function retryBackoffMs(attempt: number, maxDelayMs: number): number {
  const ladder = Math.min(
    RETRY_MAX_DELAY_MS,
    Math.max(RETRY_MIN_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt),
  )
  return Math.min(ladder, maxDelayMs)
}

/**
 * Why a request failed. The transport replays a failure only when its kind is
 * transient; every other kind ends the turn with the error the provider sent.
 */
export type FailureKind =
  | "network" // fetch rejected, the body's read failed, or the attempt timed out
  | "retryable-status" // 408/429/5xx without a usage window
  | "fatal-status" // every other HTTP status, the 4xx-fatal set included
  | "window-limit" // a 429/RATE_LIMITED naming a usage window: a plan limit, never transient
  | "retry-after-cap" // a retryable status whose Retry-After exceeds the cap
  | "upgrade-required" // the documented 403 that flips the transport
  | "truncation" // the body ended without a complete turn
  | "stream-error" // the server's own error event mid-stream
  | "pause-turn-limit" // the provider kept pausing the turn past the continuation bound

export interface Failure {
  kind: FailureKind
  /**
   * Whether the ladder may replay this failure: a decision, not a restatement
   * of `kind`. Every kind decides it here, and `stream-error` carries the
   * server's own rule's answer rather than a constant.
   */
  retryable: boolean
  /** The wait the failure itself named, in ms (an honoured `Retry-After`). */
  waitMs?: number
  /** The HTTP status the failure reported, when it named one. */
  status?: number
}

/** One construction surface, so an absent optional field is absent. */
function failure(
  kind: FailureKind,
  retryable: boolean,
  extra: { status?: number; waitMs?: number } = {},
): Failure {
  return {
    kind,
    retryable,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.waitMs !== undefined ? { waitMs: extra.waitMs } : {}),
  }
}

/** A network failure: no response at all, or a response that died mid-body. */
export const NETWORK_FAILURE: Failure = failure("network", true)

/** The documented `403 upgrade_required`: a transport flip the ladder never
 * replays (the model owns the flip and re-runs the call on the legacy
 * transport instead — issue #56). */
export const UPGRADE_REQUIRED_FAILURE: Failure = failure("upgrade-required", false, { status: 403 })

/**
 * A `403` the server raised against the version this client reports (the
 * legacy version gate, issue #173). It is permanent for the running build —
 * only an updated plugin clears it — so the ladder never replays it, and it is
 * deliberately not `upgrade-required`: nothing about the plan changes here,
 * and the session must not be flipped to another transport.
 */
export const VERSION_GATE_FAILURE: Failure = failure("fatal-status", false, { status: 403 })

/** The body ended without a complete turn — replayable while nothing is visible. */
export const TRUNCATION_FAILURE: Failure = failure("truncation", true, { status: 502 })

/**
 * The provider paused the turn more times than the continuation bound allows
 * (issue #172). The bound exists to stop the loop, so re-sending the same
 * request is exactly what must not happen: the failure is permanent for the
 * turn and the ladder never replays it.
 */
export const PAUSE_TURN_LIMIT_FAILURE: Failure = failure("pause-turn-limit", false)

/**
 * Upstream's terminal error markers (`hasTerminalMarker`): an error event
 * carrying one describes a state no retry can change — exhausted credits, a
 * model outside the plan.
 */
const TERMINAL_ERROR_MARKERS = [
  "premium_credits_exhausted",
  "model_not_in_plan",
  "insufficient credits",
]

export function hasTerminalErrorMarker(message: string): boolean {
  const lower = message.toLowerCase()
  return TERMINAL_ERROR_MARKERS.some((marker) => lower.includes(marker))
}

/** Upstream's `rateLimit.window` labels (`resolveWindowLabel`). */
const RATE_LIMIT_WINDOWS: Record<string, string> = {
  fiveHour: "5-hour",
  weekly: "weekly",
  daily: "daily",
}

/**
 * The usage window a failure names, or undefined when it names none: from the
 * structured `rateLimit.window`, then from the message's "usage limit for your
 * plan" phrasing. Only a named window makes a 429 a plan limit — a bare 429
 * stays a transient burst limit (upstream's `parseWindowLimitError`).
 */
export function resolveUsageWindow(window: unknown, message: string): string | undefined {
  const label = typeof window === "string" ? RATE_LIMIT_WINDOWS[window] : undefined
  if (label !== undefined) return label
  if (!/usage limit for your plan/i.test(message)) return undefined
  return /weekly/i.test(message) ? "weekly" : "5-hour"
}

/** The facts that can turn a rate limit into a plan usage limit. */
interface WindowLimitFacts {
  code?: string
  message?: string
  window?: unknown
}

/**
 * True when a failure is a usage-window limit rather than a transient burst:
 * a rate-limit status (429) or code (`RATE_LIMITED`) *and* a named window. The
 * one gate both classifiers share — upstream's `parseWindowLimitError`.
 */
function isWindowLimit(status: number | undefined, facts: WindowLimitFacts): boolean {
  if (resolveUsageWindow(facts.window, facts.message ?? "") === undefined) return false
  return facts.code === "RATE_LIMITED" || status === 429
}

interface ErrorBodyFacts {
  code?: string
  message?: string
  window?: unknown
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function rateLimitWindow(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>).window
}

/**
 * The error envelope of a wire body: upstream reads the transport error's own
 * fields first and the resolved body's (`body.error`) second, so a top-level
 * `code`/`message`/`rateLimit` still counts when the envelope nests them.
 */
function errorBodyFacts(body: unknown): ErrorBodyFacts {
  const outer =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined
  const inner =
    outer !== undefined && typeof outer.error === "object" && outer.error !== null
      ? (outer.error as Record<string, unknown>)
      : undefined
  return {
    code: stringField(outer?.code) ?? stringField(inner?.code),
    message: stringField(outer?.message) ?? stringField(inner?.message),
    window: rateLimitWindow(outer?.rateLimit) ?? rateLimitWindow(inner?.rateLimit),
  }
}

export interface HttpFailureInput {
  status: number
  /** The parsed error body, when the response carried JSON. */
  body?: unknown
  /** The response's `Retry-After` header, verbatim. */
  retryAfter?: string | null
  /** Cap on a wait the ladder will honour (`maxRetryDelayMs`). */
  maxDelayMs: number
}

/**
 * Classifies an HTTP failure. The window check runs first because it is a
 * statement about the account, not about the moment: a 429 naming a usage
 * window is fatal even when it also carries a retryable `Retry-After`.
 */
export function classifyHttpFailure(input: HttpFailureInput): Failure {
  const body = errorBodyFacts(input.body)
  if (isWindowLimit(input.status, body)) {
    return failure("window-limit", false, { status: input.status })
  }
  if (!isRetryableStatus(input.status)) {
    return failure("fatal-status", false, { status: input.status })
  }
  const gate = retryAfterGate(input.retryAfter ?? null, input.maxDelayMs)
  if (gate.kind === "exceeds-cap") {
    return failure("retry-after-cap", false, { status: input.status, waitMs: gate.waitMs })
  }
  return failure("retryable-status", true, {
    status: input.status,
    ...(gate.kind === "wait" ? { waitMs: gate.waitMs } : {}),
  })
}

export interface StreamErrorFacts {
  /** The error event's message, unredacted (classification needs its wording). */
  message: string
  /** `statusCode`/`status` the event reported, when it named one. */
  reportedStatus?: number
  /** The event's own `isRetryable` flag, when it carried one. */
  retryableFlag?: boolean
  /** The event's `code` — `RATE_LIMITED` names a usage window. */
  code?: string
  /** The event's `rateLimit.window`, when present. */
  window?: unknown
}

/**
 * Upstream's stream-error rule (`isStreamErrorRetryable`), plus its window
 * gate: the server's own flag decides when it is present, a reported status
 * decides next, and an event that says nothing is retryable unless it says
 * `isRetryable: false` or names a terminal marker. A window limit is fatal
 * even when the event claims to be retryable — upstream's composite
 * (`isRetryable && !parseWindowLimitError`) is the rule the ladder replays on.
 */
export function classifyStreamError(facts: StreamErrorFacts): Failure {
  const status = facts.reportedStatus
  if (isWindowLimit(status, facts)) return failure("window-limit", false, { status })
  if (facts.retryableFlag === true) return failure("stream-error", true, { status })
  if (status !== undefined) return failure("stream-error", isRetryableStatus(status), { status })
  return failure(
    "stream-error",
    facts.retryableFlag !== false && !hasTerminalErrorMarker(facts.message),
  )
}

export function abortError(message = "The operation was aborted"): DOMException {
  return new DOMException(message, "AbortError")
}

export function timeoutError(timeoutMs: number | undefined): Error {
  return new Error(
    timeoutMs === undefined
      ? "Command Code API request timed out"
      : `Command Code API request timed out after ${timeoutMs}ms`,
  )
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export function raceAbortWithTimeout<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return raceAbort(promise, controller.signal)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(timeoutError(timeoutMs))
    }, timeoutMs)
    raceAbort(promise, controller.signal).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id)
      reject(abortError())
    }
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
