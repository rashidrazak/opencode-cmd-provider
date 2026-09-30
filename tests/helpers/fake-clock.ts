// tests/helpers/fake-clock.ts — the deterministic clock behind the usage
// panel's refresh-policy tests (issue #245). The panel schedules everything
// through its `UsagePanelClock` seam (`now` + `setTimeout`/`clearTimeout`), so
// `advance` can move time and fire due timers in order with no real waiting.
//
// Between fired timers the harness yields one `setImmediate` turn: promise
// continuations (the mocked fetch chains) settle before the next timer, so
// assertions after `advance` see the policy's settled state.

/** The clock/timer seam the panel takes, plus the test-side controls. */
export interface FakeClock {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(handle: number): void
  /** Advances `ms`, firing every timer due in time order and settling after each. */
  advance(ms: number): Promise<void>
  /** Pending timer count. */
  pending(): number
}

/** One macrotask turn: flushes the promise continuations a fired timer started. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export function createFakeClock(start = 0): FakeClock {
  let time = start
  let nextHandle = 1
  const timers = new Map<number, { at: number; fn: () => void }>()

  /** The earliest due timer; ties fire in scheduling order (Map insertion order). */
  const earliest = (): { handle: number; at: number; fn: () => void } | undefined => {
    let best: { handle: number; at: number; fn: () => void } | undefined
    for (const [handle, timer] of timers) {
      if (best === undefined || timer.at < best.at) best = { handle, at: timer.at, fn: timer.fn }
    }
    return best
  }

  return {
    now: () => time,
    setTimeout(fn, ms) {
      const handle = nextHandle++
      timers.set(handle, { at: time + Math.max(0, ms), fn })
      return handle
    },
    clearTimeout(handle) {
      timers.delete(handle)
    },
    pending: () => timers.size,
    async advance(ms) {
      const target = time + ms
      for (;;) {
        const timer = earliest()
        if (timer === undefined || timer.at > target) break
        time = timer.at
        timers.delete(timer.handle)
        timer.fn()
        await settle()
      }
      time = target
      await settle()
    },
  }
}
