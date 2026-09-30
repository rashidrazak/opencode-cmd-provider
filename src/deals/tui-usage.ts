// src/deals/tui-usage.ts — the sidebar panel's usage controller (issues #244,
// #245): the mount chain that turns the TUI host's live state into the `Usage`
// segment — one host *loader* per half (v1: resolve the credential locally,
// then fetch; v2: ask the plugin's own server half over the RPC bridge,
// src/deals/usage-rpc.ts) — plus the event-driven refresh policy that keeps it
// live without polling.
//
// No polling: after mount, the only network triggers are a completed turn in
// the watched session and a window roll. `turnCompleted()` is what the host
// halves call from their own idle signal (v1 event bus / v2 data store,
// filtered to the session by `tui.tsx`), and the policy is:
//
//   - at most one network chain per five minutes; signals arriving inside the
//     cooldown — or while a chain is in flight — coalesce into one trailing
//     refresh. One chain in flight at a time.
//   - a 30-second local clock recomputes countdowns with zero network; a
//     `resetAt` reaching zero schedules one confirming refresh, at most one
//     per window roll.
//   - a failed chain backs off 5 → 10 → 20 → 30 minutes per consecutive
//     failure; a success resets the ladder, and the last-good numbers stay on
//     screen meanwhile.
//   - `unmount()` cancels the clock, the pending refresh and the in-flight
//     chain through the fetch's abort signal.
//
// The chain itself shortens with use: the load's scope cache (the `UsageScope`
// in src/deals/usage.ts) survives between loads — round-tripped for v2 — so a
// routine refresh is credits + summary only.
//
// Host-agnostic by design: no TUI runtime (solid-js), no runtime
// `@opencode-ai/*` import. The host loaders are built per panel, never per
// module, so a `/connect` or a provider re-registration between calls is
// observed (ADR-0020 rule 3).
//
// Degradations match the renderer's vocabulary: a loader answering
// `no-credential` is the notice and makes zero requests (ADR-0011); a
// throwing/failing loader is `unavailable`; an `unavailable` after a
// successful load keeps the snapshot on screen, while a chain that resolves
// nothing again publishes the notice (there is no fresh-or-stale choice
// without a credential).
import {
  fetchUsageSnapshot,
  type FetchUsageOptions,
  type UsageCredentialSource,
  type UsageResult,
  type UsageScope,
  type UsageSnapshot,
} from "./usage.js"
import {
  resolveTuiCredential,
  type TuiCredentialOptions,
  type TuiCredentialV1Input,
} from "./tui-credential.js"

/**
 * What a load is asked for: the scope cached from earlier loads (absent on a
 * mount), the panel's abort signal, and the render clock's instant. The
 * loader may consult the host's live state — it is called per chain, never
 * cached at mount (ADR-0020 rule 3).
 */
export interface UsageLoadRequest {
  readonly scope?: UsageScope
  readonly signal: AbortSignal
  readonly now: number
}

/**
 * What a load answered: the renderable result, the scope to cache next (when
 * the load refreshed it), and the display-only rung the credential answered
 * for (never the key; ADR-0020 rule 2). A loader never throws for a host
 * degradation — a missing credential is `no-credential`, a failed read is
 * `unavailable` — and a throw is mapped to `unavailable` anyway.
 */
export interface UsageLoadOutcome {
  readonly result: UsageResult
  readonly scope?: UsageScope
  readonly provenance?: UsageCredentialSource
}

/**
 * One host half's load chain: v1 wraps `resolveTuiCredential` +
 * `fetchUsageSnapshot`; v2 is `createUsageRpcLoader` over the plugin-RPC
 * bridge. The controller never sees which half answered.
 */
export type UsageLoader = (request: UsageLoadRequest) => Promise<UsageLoadOutcome>

/**
 * The v1 half's loader: the panel's own chain, in this process — resolve the
 * credential from the host state the input thunk reads *now*, then run the
 * billing fetch with it. A missing credential answers the notice without a
 * request; a failing client is the next rung, never an error (ADR-0015).
 */
export interface V1UsageLoaderOptions {
  /** Credential-resolver inputs (env, auth-path and home overrides). */
  credential?: TuiCredentialOptions
  /** Fetch inputs (baseURL, fetch, env, catalog); the key/scope/signal/clock come from the load. */
  fetchOptions?: Omit<FetchUsageOptions, "apiKey" | "scope" | "onScope" | "signal" | "now">
}

export function v1UsageLoader(
  input: () => TuiCredentialV1Input,
  options: V1UsageLoaderOptions = {},
): UsageLoader {
  return async (request) => {
    const credential = await resolveTuiCredential(input(), options.credential ?? {})
    if (credential === undefined) return { result: { state: "no-credential" } }
    let scope = request.scope
    const result = await fetchUsageSnapshot({
      ...options.fetchOptions,
      apiKey: credential.key,
      scope,
      onScope: (updated) => {
        scope = updated
      },
      signal: request.signal,
      now: request.now,
    })
    return {
      result,
      ...(scope === undefined ? {} : { scope }),
      provenance: credential.source,
    }
  }
}

/**
 * What the panel renders for the usage segment: the latest load's result and,
 * when a credential resolved, the rung it read with (display data only, never
 * the key; ADR-0020 rule 2). The panel no longer renders the rung — the load
 * chain keeps reporting it.
 */
export interface UsagePanelState {
  result: UsageResult
  provenance?: UsageCredentialSource
}

/**
 * The clock and timer seams the policy schedules through. All scheduling is
 * `setTimeout` (self-rescheduling), so one fake clock drives mount, throttle,
 * countdown and backoff in the tests.
 */
export interface UsagePanelClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** At most one network chain per this window (#245). */
const THROTTLE_MS = 5 * 60_000
/** The first failure's backoff; it doubles per consecutive failure (#245). */
const FAILURE_BACKOFF_MS = 5 * 60_000
/** The backoff ceiling (#245): 5 → 10 → 20 → 30 minutes. */
const MAX_BACKOFF_MS = 30 * 60_000
/** The countdown clock's period, inside the ticket's 30–60-second band (#245). */
const TICK_MS = 30_000

const SYSTEM_CLOCK: UsagePanelClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The two rolling windows a countdown watches. */
type RollWindow = "fiveHour" | "weekly"

/** Each rolling window's reset instant, keyed for the roll bookkeeping. */
function rollResets(snapshot: UsageSnapshot): Array<[RollWindow, number | undefined]> {
  return [
    ["fiveHour", snapshot.fiveHour?.resetAt],
    ["weekly", snapshot.weekly?.resetAt],
  ]
}

export interface UsagePanelOptions {
  /** Called whenever a load changes what the panel shows (a kept snapshot publishes nothing). */
  onChange?: (state: UsagePanelState) => void
  /** Called on every countdown tick with the new instant (the panel's render clock). */
  onTick?: (now: number) => void
  /** Clock/timer seam for tests; defaults to the platform clock. */
  clock?: UsagePanelClock
}

export interface UsagePanel {
  /** The latest state, or undefined before the first load settles. */
  state(): UsagePanelState | undefined
  /** Runs the mount chain exactly once per panel and starts the countdown clock. */
  mount(): Promise<void>
  /** Runs a chain again now — the raw seam the refresh policy drives. */
  refresh(): Promise<void>
  /** A completed turn in the watched session: a throttled refresh. */
  turnCompleted(): void
  /** Cancels the clock, the pending refresh and any in-flight chain. */
  unmount(): void
}

/**
 * One panel's usage controller. `load` is the half's chain — built by the
 * caller (v1: `v1UsageLoader`; v2: `createUsageRpcLoader`), called on every
 * load, never captured once, so the host state is read at the moment the
 * panel asks (ADR-0020 rule 3).
 */
export function createUsagePanel(load: UsageLoader, options: UsagePanelOptions = {}): UsagePanel {
  const clock = options.clock ?? SYSTEM_CLOCK

  let state: UsagePanelState | undefined
  let scope: UsageScope | undefined
  let mounted = false
  let unmounted = false
  /** The chain's start instant — the throttle's basis. */
  let lastAttemptAt: number | undefined
  let failures = 0
  let backoffUntil: number | undefined
  /** A signal arrived while cooling down or in flight: one trailing chain is owed. */
  let pendingTrailing = false
  let chains = 0
  let queue: Promise<void> = Promise.resolve()
  let trailTimer: unknown
  let tickTimer: unknown
  /** The last reset value each window's roll was confirmed for. */
  const confirmed: Record<RollWindow, number | undefined> = {
    fiveHour: undefined,
    weekly: undefined,
  }
  const abort = new AbortController()

  const publish = (next: UsagePanelState): void => {
    state = next
    options.onChange?.(next)
  }

  /** A success resets the backoff ladder; `unavailable` climbs it; no-credential is neither. */
  const recordOutcome = (result: UsageResult): void => {
    if (result.state === "usage") {
      failures = 0
      backoffUntil = undefined
      const now = clock.now()
      for (const [window, resetAt] of rollResets(result.snapshot)) {
        // A reset already past at fetch time is the post-roll value: there is
        // nothing left to confirm for it.
        if (resetAt !== undefined && resetAt <= now) confirmed[window] = resetAt
      }
      return
    }
    if (result.state === "unavailable") {
      failures += 1
      backoffUntil =
        clock.now() + Math.min(FAILURE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
    }
  }

  const attempt = async (): Promise<void> => {
    if (unmounted) return
    lastAttemptAt = clock.now()
    let next: UsagePanelState
    try {
      const loaded = await load({ scope, signal: abort.signal, now: clock.now() })
      if (loaded.scope !== undefined) scope = loaded.scope
      next =
        loaded.provenance === undefined
          ? { result: loaded.result }
          : { result: loaded.result, provenance: loaded.provenance }
    } catch {
      // A throwing loader is the unavailable state, never an exception
      // escaping the panel's mount (ADR-0020 rule 1).
      next = { result: { state: "unavailable" } }
    }
    if (unmounted) return
    // A failed load after a good one keeps the last snapshot on screen: stale
    // numbers beat a blank segment while the backoff runs down.
    if (next.result.state === "unavailable" && state?.result.state === "usage") {
      recordOutcome(next.result)
      return
    }
    publish(next)
    recordOutcome(next.result)
  }

  /** The next instant a network chain may start: throttle and backoff, whichever is later. */
  const nextAllowedAt = (): number => {
    const throttle = (lastAttemptAt ?? Number.NEGATIVE_INFINITY) + THROTTLE_MS
    return Math.max(throttle, backoffUntil ?? Number.NEGATIVE_INFINITY)
  }

  const clearTrail = (): void => {
    if (trailTimer === undefined) return
    clock.clearTimeout(trailTimer)
    trailTimer = undefined
  }

  /** Starts the owed trailing chain now, or schedules it for the first allowed instant. */
  const flushTrailing = (): void => {
    if (unmounted || !mounted || chains > 0 || !pendingTrailing) return
    const wait = nextAllowedAt() - clock.now()
    if (wait > 0) {
      clearTrail()
      trailTimer = clock.setTimeout(() => {
        trailTimer = undefined
        flushTrailing()
      }, wait)
      return
    }
    pendingTrailing = false
    clearTrail()
    void runChain()
  }

  /** One chain at a time: later calls queue behind the in-flight one. */
  const runChain = (): Promise<void> => {
    chains += 1
    const settled = queue.then(attempt).finally(() => {
      chains -= 1
      flushTrailing()
    })
    queue = settled.catch(() => {})
    return settled
  }

  const turnCompleted = (): void => {
    if (!mounted || unmounted) return
    pendingTrailing = true
    flushTrailing()
  }

  /** A reset past its instant and not yet confirmed schedules exactly one refresh. */
  const checkRolls = (now: number): void => {
    if (state?.result.state !== "usage") return
    let rolled = false
    for (const [window, resetAt] of rollResets(state.result.snapshot)) {
      if (resetAt === undefined || now < resetAt || confirmed[window] === resetAt) continue
      confirmed[window] = resetAt
      rolled = true
    }
    if (rolled) turnCompleted()
  }

  /** The local countdown clock: re-renders and roll checks, zero network. */
  const startTick = (): void => {
    tickTimer = clock.setTimeout(function tick() {
      tickTimer = undefined
      if (unmounted) return
      const now = clock.now()
      options.onTick?.(now)
      checkRolls(now)
      startTick()
    }, TICK_MS)
  }

  const mount = async (): Promise<void> => {
    if (mounted || unmounted) return
    mounted = true
    startTick()
    await runChain()
  }

  const unmount = (): void => {
    if (unmounted) return
    unmounted = true
    mounted = false
    pendingTrailing = false
    if (tickTimer !== undefined) {
      clock.clearTimeout(tickTimer)
      tickTimer = undefined
    }
    clearTrail()
    abort.abort()
  }

  return {
    state: () => state,
    mount,
    refresh: runChain,
    turnCompleted,
    unmount,
  }
}
