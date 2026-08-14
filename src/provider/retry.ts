// src/provider/retry.ts — retry, abort and timeout helpers (PLAN #4, port of
// pi's core.ts retry math + abort races + signal-aware delay)

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000)
  return undefined
}

const BASE_RETRY_DELAY_MS = 500

export function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  maxDelayMs: number,
): number {
  const retryAfterMs = parseRetryAfterSeconds(retryAfterHeader)
  if (retryAfterMs !== undefined) {
    if (retryAfterMs * 1000 > maxDelayMs) return -1
    return retryAfterMs * 1000
  }
  const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt
  const jitter = exponential * 0.2 * Math.random()
  return Math.min(exponential + jitter, maxDelayMs)
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
