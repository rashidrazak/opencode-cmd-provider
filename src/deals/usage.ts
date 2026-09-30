// src/deals/usage.ts — the live usage snapshot behind the sidebar `Usage`
// segment (issue #242): one host-agnostic fetch of the four billing requests
// the official CLI's /usage overlay makes (whoami → org-scoped subscriptions →
// org-scoped credits → summary pinned with `since=currentPeriodStart`), its
// defensive row-oriented parse, and the pure renderer that turns a snapshot
// into the panel's rows. No UI wiring lives here (issues #243/#244 wrap it).
//
// Each leg fails on its own — a flaky whoami, credits or summary leg drops
// only the rows that leg feeds, never the whole segment — and every request
// carries only `Authorization: Bearer` with a generous abort budget: the live
// billing API routinely answers a leg in 8–18 seconds (five live probes,
// 2026-09-30), so the old five-second budget dropped every slow leg and the
// panel rendered a partial snapshot (issue #251). A chain reads its legs in
// parallel rather than the CLI's sequential waves, so the chain's wall clock
// is the slowest leg, not the sum; `previous` (the panel's last-good snapshot)
// merges field-wise over whatever a chain could not refresh, so a failed leg
// keeps its rows on screen. No credential resolved means zero requests:
// `fetchUsageSnapshot` answers `no-credential` up front and the renderer prints
// the one-line notice.
//
// Since #245 the fetch also carries the panel's cached scope: a chain whose
// whoami answered caches it with the subscription record; a later refresh
// passes the scope back in and the chain collapses to the two live legs —
// credits + summary — while the record is fresh (re-read only when its period
// end has passed or it is over an hour old). A chain whose whoami failed
// caches nothing, so the org read is retried instead of frozen (#251). The
// caller's abort signal joins each request's timeout, so the panel's unmount
// cancels an in-flight chain.
//
// Parsing never throws: upstream shape drift drops a row. `resetAt` is epoch
// milliseconds (the CLI compares it straight to Date.now()), `0` means no
// active window, and a value below 1e12 is re-read as seconds — the unit the
// rate-limit error envelopes use. Monthly cap = `credits.monthlyCredits` +
// `summary.totalMonthlyCredits`, remaining plus spent-from-monthly at one
// instant, falling back to the bundled plan row when either is missing; a live
// window cap always wins over the bundled PLAN_CATALOG value (a live Go
// account reads $3/$6 while the docs table still says $2/$5). Plan identity is
// Core's `normalizePlan` on the subscription's `planId`, status-gated exactly
// as `cmd_plan_summary`'s lookup is (ADR-0011) — never a default, and never
// riding on a subscription the account no longer holds.
//
// The renderer pins the segment: a `Usage` heading, one sub-section per meter
// (label, progress bar, `used / cap` detail with the countdown or renewal),
// then the summary sub-section — tokens in/out, requests, spend, and the
// purchased extra-credit balance — plus every degradation variant: no
// credential, no rolling windows (pay-as-you-go), idle window, unavailable.
// A bar fills 33 cells of the 37-character sidebar column (the percentage
// field reserves four) to the nearest half cell, keeps its end cap, and
// carries a colour token by progress (green ≤ 40%, yellow ≤ 80%, red above).
// Percent is a clamped integer, money two decimals, tokens compact, and reset
// countdowns mirror the CLI's own duration format. It takes `now` so a render
// stays a function of its inputs (the ticking clock is the panel's, #245).
//
// Host-agnostic by design: no TUI runtime (solid-js) and no runtime
// `@opencode-ai/*` import; the server barrel does not re-export it.
import { normalizePlan, PLAN_BEARING_SUBSCRIPTION_STATUSES, type PlanId } from "../catalog/plans.js"
import { getApiBase } from "../env.js"
import { isRecord, numberValue, stringValue } from "../provider/converters.js"
import { PLAN_CATALOG, type PlanInfo } from "./catalog.js"
import type { DealsRow, DealsRowTone } from "./tui.js"

/** Abort budget for each billing request. The live API answers a leg in
 * 8–18 s, so a tighter budget drops data that was one or two seconds away;
 * the legs run in parallel, so this bounds the chain too. */
const REQUEST_TIMEOUT_MS = 25_000

/** The official CLI's own usage endpoints (verified against command-code 1.69.0). */
const WHOAMI_PATH = "/alpha/whoami?limits=1"
const SUBSCRIPTIONS_PATH = "/alpha/billing/subscriptions"
const CREDITS_PATH = "/alpha/billing/credits"
const SUMMARY_PATH = "/alpha/usage/summary"

/**
 * Every epoch below this is read as seconds: a real millisecond timestamp is
 * past 2001-09-09, and window `resetAt` values below the floor are the seconds
 * unit the rate-limit envelopes use (issue #241's unit rule).
 */
const EPOCH_MS_FLOOR = 1e12

/** One rolling window's meter, in credit-value dollars. */
export interface UsageWindow {
  used: number
  /** Live cap, else the bundled plan row's window; absent when neither exists. */
  cap?: number
  exceeded: boolean
  /** Epoch milliseconds; absent for an idle window (`resetAt: 0`). */
  resetAt?: number
}

/** The monthly credit pool for the current billing cycle. */
export interface UsageMonthly {
  used: number
  cap: number
}

/** The cycle totals the summary reports, as far as it reports them. */
export interface UsageTotals {
  requests?: number
  tokens?: number
  tokensIn?: number
  tokensOut?: number
  cost?: number
}

/** Everything one usage lookup could read, defensively. */
export interface UsageSnapshot {
  plan?: PlanId
  /** `windowLimits.limited`; false renders the pay-as-you-go line. */
  limited?: boolean
  fiveHour?: UsageWindow
  weekly?: UsageWindow
  monthly?: UsageMonthly
  /** The purchased extra-credit balance remaining, in credit dollars. */
  purchasedCredits?: number
  totals?: UsageTotals
  /** Epoch milliseconds of the subscription period end (renewal basis). */
  periodEnd?: number
  /** The summary's own period basis (e.g. "billing-period"). */
  periodBasis?: string
}

/** What one lookup produced: a snapshot, or the degradation the panel shows. */
export type UsageResult =
  | { state: "no-credential" }
  | { state: "unavailable" }
  | { state: "usage"; snapshot: UsageSnapshot }

/** The slice of a subscription record the refresh path reuses between chains. */
export interface UsageSubscriptionCache {
  /** Plan identity in Core's vocabulary — the bundled cap fallback's key. */
  plan?: PlanId
  /** `currentPeriodStart` — the summary's `since` pin. */
  since?: string
  /** Epoch milliseconds of the period end (the freshness trigger). */
  periodEnd?: number
  /** When the record was read, epoch milliseconds (the one-hour rule's basis). */
  readAt: number
}

/**
 * The panel's cached billing context (issue #245). A chain whose whoami
 * answered caches the org scope — org id or explicit no-org — for the panel's
 * lifetime; every later chain reuses it and re-reads the subscription record
 * only while it is fresh, so a routine refresh is just the two live legs —
 * credits + summary. A chain whose whoami *failed* caches nothing, so the
 * next chain retries the org read instead of freezing an unscoped cache
 * (issue #251).
 */
export interface UsageScope {
  /** Whoami's org id; absent when whoami said nothing (still cached). */
  orgId?: string
  /** The subscription record's cached slice. */
  subscription?: UsageSubscriptionCache
}

export interface FetchUsageOptions {
  /** Resolved credential for the billing reads (defaults to COMMANDCODE_API_KEY). */
  apiKey?: string
  /** Base URL for the reads (defaults to getApiBase(env)). */
  baseURL?: string
  /** Fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch
  /** Environment for the credential/base fallbacks (defaults to process.env). */
  env?: NodeJS.ProcessEnv
  /** Bundled plan rows for the cap fallbacks (defaults to PLAN_CATALOG). */
  catalog?: Readonly<Record<PlanId, PlanInfo>>
  /**
   * The cached scope from an earlier chain (#245). When present, whoami is not
   * re-read and a fresh subscription record collapses the chain to credits +
   * summary; a chain without one (the mount, or the first chain after a late
   * credential) reads whoami and the subscription record itself.
   */
  scope?: UsageScope
  /** Called with the scope to cache when whoami settled and/or subscriptions were read. */
  onScope?: (scope: UsageScope) => void
  /**
   * The panel's last-good snapshot (#251). Every field this chain cannot
   * refresh — a failed leg, a sub-request that answered nothing — keeps its
   * previous value instead of dropping rows. Absent on a cold panel.
   */
  previous?: UsageSnapshot
  /**
   * Progressive publication (#251): called with the merged snapshot whenever a
   * leg lands, so the panel fills in as the fast legs (credits, ~1 s) answer
   * long before the slow ones (subscriptions/summary, ~16 s). Only results
   * carrying at least one renderable row are emitted.
   */
  onPartial?: (result: UsageResult) => void
  /** The caller's abort signal, joined with each request's own budget. */
  signal?: AbortSignal
  /** Clock for the subscription-cache rule (defaults to Date.now()). */
  now?: number
}

/**
 * The subscription cache's ceiling: a record older than this is re-read, and
 * the period-end rule re-reads sooner when the cycle has rolled (#245).
 */
const SUBSCRIPTION_CACHE_MS = 60 * 60_000

/** The org scoping query for a whoami-known org, or the empty string. */
function scopeQuery(orgId: string | undefined): string {
  return orgId === undefined ? "" : `?orgId=${encodeURIComponent(orgId)}`
}

/** A subscription record's freshness: the period end, then the hour rule. */
function subscriptionsFresh(cache: UsageSubscriptionCache | undefined, now: number): boolean {
  if (cache === undefined) return false
  if (cache.periodEnd !== undefined && cache.periodEnd <= now) return false
  return now - cache.readAt <= SUBSCRIPTION_CACHE_MS
}

/**
 * The cacheable slice of a subscriptions payload: the plan identity from the
 * status-gated `planId` (never a default), the period start the summary pins,
 * and the period end the freshness rule reads. Undefined when the payload
 * carries no record at all.
 */
function readSubscription(raw: unknown, now: number): UsageSubscriptionCache | undefined {
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : undefined
  if (data === undefined) return undefined
  const cache: UsageSubscriptionCache = { readAt: now }
  const status = stringValue(data.status)
  if (status !== undefined && PLAN_BEARING_SUBSCRIPTION_STATUSES.has(status)) {
    const plan = normalizePlan(data.planId)
    if (plan !== undefined) cache.plan = plan
  }
  const since = paramValue(data.currentPeriodStart)
  if (since !== undefined) cache.since = since
  const periodEnd = toEpochMs(data.currentPeriodEnd)
  if (periodEnd !== undefined) cache.periodEnd = periodEnd
  return cache
}

/** A string query-parameter value; numbers stringify, anything else is absent. */
function paramValue(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * A reset epoch or subscription date as milliseconds. `0` and negatives mean
 * no active window; a positive number below 1e12 is read as seconds, anything
 * else as milliseconds; ISO strings parse through Date.
 */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return undefined
    return value < EPOCH_MS_FLOOR ? value * 1000 : value
  }
  const text = stringValue(value)
  if (text === undefined || text === "") return undefined
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * One window limit: `used` is required (no used, no meter), a live cap always
 * wins over the bundled plan row's window, and a non-positive `resetAt` means
 * no active window.
 */
function parseWindow(raw: unknown, fallbackCap: number | undefined): UsageWindow | undefined {
  if (!isRecord(raw)) return undefined
  const used = numberValue(raw.used)
  if (used === undefined) return undefined
  const cap = numberValue(raw.cap) ?? fallbackCap
  const resetAt = toEpochMs(raw.resetAt)
  return {
    used,
    ...(cap === undefined ? {} : { cap }),
    exceeded: raw.exceeded === true,
    ...(resetAt === undefined ? {} : { resetAt }),
  }
}

/**
 * The monthly pool: the cap is remaining + spent-from-monthly at one instant,
 * the two live numbers that add up to the granted pool. When either is
 * missing, the bundled plan row's credits is the cap and `used` is
 * reconstructed from whichever live side is known — never invented when
 * neither is.
 */
function deriveMonthly(
  remaining: number | undefined,
  spent: number | undefined,
  bundled: number | undefined,
): UsageMonthly | undefined {
  const cap = remaining !== undefined && spent !== undefined ? remaining + spent : bundled
  const used =
    spent ?? (remaining !== undefined && bundled !== undefined ? bundled - remaining : undefined)
  if (used === undefined || cap === undefined || cap <= 0) return undefined
  return { used: Math.max(0, used), cap }
}

/** The summary's cycle totals, as present; undefined when it says nothing. */
function parseTotals(summary: Record<string, unknown> | undefined): UsageTotals | undefined {
  if (summary === undefined) return undefined
  const totals: UsageTotals = {}
  const requests = numberValue(summary.totalCount)
  if (requests !== undefined) totals.requests = requests
  const tokensIn = numberValue(summary.totalTokensIn)
  if (tokensIn !== undefined) totals.tokensIn = tokensIn
  const tokensOut = numberValue(summary.totalTokensOut)
  if (tokensOut !== undefined) totals.tokensOut = tokensOut
  const tokens =
    numberValue(summary.totalTokens) ??
    (tokensIn !== undefined && tokensOut !== undefined ? tokensIn + tokensOut : undefined)
  if (tokens !== undefined) totals.tokens = tokens
  const cost = numberValue(summary.totalCost)
  if (cost !== undefined) totals.cost = cost
  return Object.keys(totals).length === 0 ? undefined : totals
}

/** True when the snapshot feeds at least one renderable row. */
function hasUsageData(snapshot: UsageSnapshot): boolean {
  return (
    snapshot.limited === false ||
    snapshot.fiveHour !== undefined ||
    snapshot.weekly !== undefined ||
    snapshot.monthly !== undefined ||
    snapshot.purchasedCredits !== undefined ||
    snapshot.totals !== undefined
  )
}

/**
 * One wave of billing legs: the credits and summary request, plus the
 * subscription record when the cached one is stale enough to re-read.
 */
interface UsageLegSet {
  credits: Promise<unknown>
  /** Absent when the cached subscription record is still fresh (#245). */
  subscriptions?: Promise<unknown>
  summary: Promise<unknown>
}

/**
 * The billing fetch behind the usage segment. The CLI's own /usage overlay
 * reads the same four endpoints strictly sequentially (whoami → subscriptions
 * ∥ credits → summary), which costs the sum of the leg latencies — ~42 s on
 * the 2026-09-30 measurements when every leg answers, and the reason the old
 * five-second budget "finished" in ~15 s with a permanently partial snapshot
 * (issue #251).
 *
 * This chain runs the legs as one parallel wave instead: credits,
 * subscriptions and the summary all start together, with the cached scope's
 * `orgId`/`since` applied when known (the summary's unpinned output was
 * measured byte-identical to the pin, so the period pin is a fidelity choice,
 * not a correctness one — it is kept whenever the scope carries it). On a cold
 * chain the wave is speculative until whoami answers: a whoami naming an org
 * discards the unscoped legs and re-runs them scoped, while a whoami that
 * answered "no org" — or failed: the CLI's own path there is unscoped too —
 * keeps the wave. A failed whoami publishes no scope, so the next chain
 * retries the org read instead of pinning an unscoped cache (the live
 * `scope: {}` bug).
 *
 * Each landing leg publishes the merged view through `onPartial`, and the
 * final snapshot merges field-wise over `previous`: a field an answered leg
 * omits keeps its previous value, so a timed-out leg can no longer drop rows
 * that were on screen. The chain still reports `unavailable` when no leg
 * answered with a renderable value on this chain — the panel's backoff ladder
 * reads that, not the merged view.
 */
export async function fetchUsageSnapshot(options: FetchUsageOptions = {}): Promise<UsageResult> {
  const env = options.env ?? process.env
  const key = options.apiKey ?? env.COMMANDCODE_API_KEY
  if (!key) return { state: "no-credential" }
  const base = options.baseURL ?? getApiBase(env)
  const fetchImpl = options.fetch ?? fetch
  const catalog = options.catalog ?? PLAN_CATALOG
  const now = options.now ?? Date.now()
  const previous = options.previous

  // One leg: offline, timeout, non-2xx and an unparseable body are all a miss
  // for this leg alone (ADR-0011). Only the Bearer header travels. Each leg
  // arms its own budget, joined with the caller's signal when the panel has
  // one, so an unmount aborts an in-flight chain (#245).
  const getJson = async (path: string): Promise<unknown> => {
    const budget = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? budget : AbortSignal.any([options.signal, budget])
    try {
      const response = await fetchImpl(`${base}${path}`, {
        headers: { authorization: `Bearer ${key}` },
        signal,
      })
      return response.ok ? await response.json() : undefined
    } catch {
      return undefined
    }
  }

  // The chain's accumulated leg state: the subscription slice plan/since/
  // periodEnd ride on, the credits payload's two records, and the summary
  // record. Each `apply` is called as its leg settles; the snapshot builder
  // and the partial publisher read whatever has landed so far.
  let orgId = options.scope?.orgId
  let cached = options.scope?.subscription
  let windowLimits: Record<string, unknown> | undefined
  let creditsRecord: Record<string, unknown> | undefined
  let summaryRecord: Record<string, unknown> | undefined

  /** The credits leg answered with one of its records; false is a missed leg. */
  const applyCredits = (payload: unknown): boolean => {
    if (!isRecord(payload) || payload.success === false) return false
    const windows = isRecord(payload.windowLimits) ? payload.windowLimits : undefined
    const credits = isRecord(payload.credits) ? payload.credits : undefined
    if (windows === undefined && credits === undefined) return false
    if (windows !== undefined) windowLimits = windows
    if (credits !== undefined) creditsRecord = credits
    return true
  }

  /** A failed read keeps the old slice; a read that answered replaces it. */
  const applySubscriptions = (payload: unknown): boolean => {
    const slice = readSubscription(payload, now)
    if (slice === undefined) return false
    cached = slice
    return true
  }

  /** The summary leg answered with its own (totals-shaped) record. */
  const applySummary = (payload: unknown): boolean => {
    if (!isRecord(payload) || payload.success === false) return false
    summaryRecord = payload
    return true
  }

  /**
   * The snapshot as far as the landed legs and `base` can build it: every
   * field an answered leg carries wins, every field it could not refresh keeps
   * `base`'s value. `plan`/`periodEnd` are the exception — they follow the
   * subscription slice, so a canceled subscription clears the plan instead of
   * resurrecting it from `base` (ADR-0011: never a stale plan presented as
   * current).
   */
  const buildSnapshot = (base: UsageSnapshot | undefined): UsageSnapshot => {
    const bundle = cached?.plan === undefined ? undefined : catalog[cached.plan]
    const snapshot: UsageSnapshot = {}
    const plan = cached === undefined ? base?.plan : cached.plan
    if (plan !== undefined) snapshot.plan = plan
    const limited =
      windowLimits !== undefined && typeof windowLimits.limited === "boolean"
        ? windowLimits.limited
        : base?.limited
    if (limited !== undefined) snapshot.limited = limited
    const fiveHour =
      (windowLimits === undefined
        ? undefined
        : parseWindow(windowLimits.fiveHour, bundle?.window5h)) ?? base?.fiveHour
    if (fiveHour !== undefined) snapshot.fiveHour = fiveHour
    const weekly =
      (windowLimits === undefined
        ? undefined
        : parseWindow(windowLimits.weekly, bundle?.windowWeek)) ?? base?.weekly
    if (weekly !== undefined) snapshot.weekly = weekly
    const monthly =
      deriveMonthly(
        creditsRecord === undefined ? undefined : numberValue(creditsRecord.monthlyCredits),
        summaryRecord === undefined ? undefined : numberValue(summaryRecord.totalMonthlyCredits),
        bundle?.credits,
      ) ?? base?.monthly
    if (monthly !== undefined) snapshot.monthly = monthly
    // The extra-credit balance is the CLI's `Extra Credits` figure (its
    // `purchasedCredits`); negative values are unreadable and clamp to zero.
    const purchasedCredits =
      (creditsRecord === undefined ? undefined : numberValue(creditsRecord.purchasedCredits)) ??
      base?.purchasedCredits
    if (purchasedCredits !== undefined) snapshot.purchasedCredits = Math.max(0, purchasedCredits)
    const totals =
      (summaryRecord === undefined ? undefined : parseTotals(summaryRecord)) ?? base?.totals
    if (totals !== undefined) snapshot.totals = totals
    const periodEnd = cached === undefined ? base?.periodEnd : cached.periodEnd
    if (periodEnd !== undefined) snapshot.periodEnd = periodEnd
    const periodBasis =
      (summaryRecord === undefined ? undefined : stringValue(summaryRecord.periodBasis)) ??
      base?.periodBasis
    if (periodBasis !== undefined && periodBasis !== "") snapshot.periodBasis = periodBasis
    return snapshot
  }

  /** The merged view, as far as the landed legs can build it. */
  const currentResult = (): UsageResult => {
    const snapshot = buildSnapshot(previous)
    return hasUsageData(snapshot) ? { state: "usage", snapshot } : { state: "unavailable" }
  }

  /** Publishes each landing leg's merged view; degraded states stay private. */
  const publishProgress = (): void => {
    const result = currentResult()
    if (result.state !== "usage") return
    // A progress consumer must never break the chain; a partial is cosmetic.
    try {
      options.onPartial?.(result)
    } catch {
      // swallowed deliberately
    }
  }

  /** Starts one wave; the subscription leg is skipped while its cache is fresh. */
  const startWave = (scope: {
    orgId?: string
    since?: string
    subscriptions: boolean
  }): UsageLegSet => {
    const subscriptions = scope.subscriptions
      ? getJson(`${SUBSCRIPTIONS_PATH}${scopeQuery(scope.orgId)}`)
      : undefined
    const credits = getJson(`${CREDITS_PATH}${scopeQuery(scope.orgId)}`)
    const summaryParams = new URLSearchParams()
    if (scope.orgId !== undefined) summaryParams.set("orgId", scope.orgId)
    if (scope.since !== undefined) summaryParams.set("since", scope.since)
    const summaryQuery = summaryParams.toString()
    const summary = getJson(`${SUMMARY_PATH}${summaryQuery === "" ? "" : `?${summaryQuery}`}`)
    return {
      credits,
      ...(subscriptions === undefined ? {} : { subscriptions }),
      summary,
    }
  }

  /** Applies each leg as it lands and publishes the merged view it produced. */
  const wire = (legs: UsageLegSet): void => {
    void legs.credits.then((payload) => {
      if (applyCredits(payload)) publishProgress()
    })
    void legs.subscriptions?.then((payload) => {
      if (applySubscriptions(payload)) publishProgress()
    })
    void legs.summary.then((payload) => {
      if (applySummary(payload)) publishProgress()
    })
  }

  // A cold chain (no cached scope) starts the wave speculatively beside
  // whoami; nothing is published until the decision, so a team account never
  // shows the unscoped context's numbers. A whoami that names an org discards
  // the speculative wave and re-runs it scoped. A chain that only reuses the
  // cached scope publishes nothing back.
  let legs: UsageLegSet
  let publishScope = false
  if (options.scope === undefined) {
    const whoamiPromise = getJson(WHOAMI_PATH)
    const speculative = startWave({ subscriptions: true })
    const whoami = await whoamiPromise
    const whoamiOk = isRecord(whoami) && whoami.success !== false
    publishScope = whoamiOk
    if (whoamiOk) orgId = isRecord(whoami.org) ? stringValue(whoami.org.id) : undefined
    legs = whoamiOk && orgId !== undefined ? startWave({ orgId, subscriptions: true }) : speculative
  } else {
    const subscriptions = !subscriptionsFresh(cached, now)
    publishScope = subscriptions
    legs = startWave({
      ...(orgId === undefined ? {} : { orgId }),
      ...(cached?.since === undefined ? {} : { since: cached.since }),
      subscriptions,
    })
  }
  wire(legs)
  await Promise.allSettled([legs.credits, legs.subscriptions, legs.summary])

  // The scope cache: whoami settled (or was settled on an earlier chain) and
  // the subscription slice rides along. A chain whose whoami failed publishes
  // nothing, so the next chain retries the org read instead of freezing an
  // unscoped cache.
  if (publishScope) {
    options.onScope?.({
      ...(orgId === undefined ? {} : { orgId }),
      ...(cached === undefined ? {} : { subscription: cached }),
    })
  }

  const merged = buildSnapshot(previous)
  // The chain's own success rule — the panel's backoff ladder reads it: at
  // least one renderable row must have come from this chain, never from
  // `previous` alone. A failed chain is `unavailable`; the panel keeps the
  // last-good numbers on screen.
  const fresh = buildSnapshot(undefined)
  if (!hasUsageData(fresh) || !hasUsageData(merged)) return { state: "unavailable" }
  return { state: "usage", snapshot: merged }
}

/** The segment heading, and its degradation lines. */
const USAGE_HEADING = "Usage"
const NO_CREDENTIAL_LINE = "Usage needs COMMANDCODE_API_KEY — set it to see live limits"
const UNAVAILABLE_LINE = "Usage unavailable — could not read the Command Code billing API"
const PAY_AS_YOU_GO_LINE = "No rolling windows on this plan — usage is pay-as-you-go"

const DAY_MS = 86_400_000
const SEP = " · "

export interface RenderUsageOptions {
  /** Clock for countdowns and renewal days (defaults to Date.now()). */
  now?: number
}

/**
 * The credential rung behind a lookup, as the host loaders report it: the
 * resolver (#243) names one of the same three display rungs the plan summary
 * names (Host connection / `COMMANDCODE_API_KEY` / a legacy file's label).
 * The usage panel no longer renders it; the rung stays display data only, and
 * the key never travels with it (ADR-0015 rule 4, ADR-0017 rule 1).
 */
export type UsageCredentialSource =
  { kind: "host" } | { kind: "environment" } | { kind: "file"; label: string }

/**
 * The `Usage` segment rows: a leading blank separator, then the heading over
 * up to four sub-sections — 5-hour, Weekly, Monthly (label, bar, detail) and
 * the summary — blank-line separated. A missing result is the no-credential
 * state (the resolver found nothing, #243) and every other state maps to its
 * own degradation line. Pure: countdowns and renewal days come from
 * `options.now`.
 */
export function renderUsageRows(
  result: UsageResult | undefined,
  options: RenderUsageOptions = {},
): DealsRow[] {
  const rows: DealsRow[] = [
    ["", ""],
    [USAGE_HEADING, "", "heading"],
  ]
  const state: UsageResult = result ?? { state: "no-credential" }
  if (state.state === "no-credential") {
    rows.push([NO_CREDENTIAL_LINE, "", "value"])
    return rows
  }
  if (state.state === "unavailable") {
    rows.push([UNAVAILABLE_LINE, "", "value"])
    return rows
  }
  const snapshot = state.snapshot
  // A result that carries no renderable row (a hand-built snapshot, a shape
  // the parse could not read) degrades exactly like a failed fetch.
  if (!hasUsageData(snapshot)) {
    rows.push([UNAVAILABLE_LINE, "", "value"])
    return rows
  }
  const now = options.now ?? Date.now()
  const sections: DealsRow[][] = []
  if (snapshot.limited === false) {
    // `limited: false` is the pay-as-you-go shape (extra credits bypass the
    // windows), so the rolling meters are explained away, not rendered.
    sections.push([[PAY_AS_YOU_GO_LINE, "", "value"]])
  } else {
    if (snapshot.fiveHour !== undefined) {
      sections.push(
        meterSection("5-hour", snapshot.fiveHour, resetSuffix(snapshot.fiveHour.resetAt, now)),
      )
    }
    if (snapshot.weekly !== undefined) {
      sections.push(
        meterSection("Weekly", snapshot.weekly, resetSuffix(snapshot.weekly.resetAt, now)),
      )
    }
  }
  if (snapshot.monthly !== undefined) {
    sections.push(meterSection("Monthly", snapshot.monthly, renewalSuffix(snapshot.periodEnd, now)))
  }
  const summary = summarySection(snapshot)
  if (summary.length > 0) sections.push(summary)
  for (const [index, section] of sections.entries()) {
    if (index > 0) rows.push(["", ""])
    rows.push(...section)
  }
  return rows
}

/** The sidebar column the segment lays out against: bar + percentage field. */
const USAGE_COLUMN = 37
/** The reserved percentage field: three digits plus the sign (`  6%`, `100%`). */
const PERCENT_FIELD = 4
/** The bar's width: the column minus the reserved percentage field. */
const BAR_WIDTH = USAGE_COLUMN - PERCENT_FIELD

const BAR_FULL = "█"
const BAR_HALF = "▌"
const BAR_EMPTY = "·"
const BAR_END = "▏"

/**
 * One meter's bar: whole cells for the filled share, a half cell at the
 * boundary, dots for the rest, and the end cap in the last cell. The fill
 * rounds to the nearest half cell, so `100%` still keeps the cap visible.
 */
function usageBar(percent: number): string {
  const cells = BAR_WIDTH - 1
  const halves = Math.round((percent / 100) * cells * 2)
  const full = Math.floor(halves / 2)
  const half = halves % 2
  return `${BAR_FULL.repeat(full)}${half === 1 ? BAR_HALF : ""}${BAR_EMPTY.repeat(cells - full - half)}${BAR_END}`
}

/** The reserved, right-aligned percentage text (`  6%`, ` 36%`, `100%`). */
function percentText(percent: number): string {
  return `${String(percent).padStart(3)}%`
}

/** The bar's colour token by progress: green ≤ 40, yellow ≤ 80, red above. */
function usageTone(percent: number): DealsRowTone {
  if (percent > 80) return "error"
  if (percent > 40) return "warning"
  return "success"
}

/**
 * One meter sub-section: the muted label, the bar with its percentage field
 * (only when a cap exists — no cap, no fabricated percentage), then the muted
 * `$used / $cap` detail with the caller's countdown/renewal suffix.
 */
function meterSection(
  label: string,
  meter: { used: number; cap?: number },
  suffix: string,
): DealsRow[] {
  const rows: DealsRow[] = [[label, "", "value"]]
  if (meter.cap !== undefined) {
    const percent = percentOf(meter.used, meter.cap)
    rows.push([usageBar(percent), percentText(percent), "bar", usageTone(percent)])
  }
  const value =
    meter.cap === undefined
      ? `${money(meter.used)} used`
      : `${money(meter.used)} / ${money(meter.cap)}`
  rows.push([suffix === "" ? value : `${value}${SEP}${suffix}`, "", "value"])
  return rows
}

/** The active window's countdown, or nothing for an idle window. */
function resetSuffix(resetAt: number | undefined, now: number): string {
  return resetAt !== undefined && resetAt > now ? formatDuration(resetAt - now) : ""
}

/**
 * Days to the subscription renewal, mirroring the CLI: whole days from `ceil`,
 * floored at 0 so a just-rolled period never counts negative.
 */
function renewalSuffix(periodEnd: number | undefined, now: number): string {
  if (periodEnd === undefined) return ""
  return `${Math.max(0, Math.ceil((periodEnd - now) / DAY_MS))}d`
}

/** The CLI's clamped meter percent: a zero cap reads 0, an over-cap window 100. */
function percentOf(used: number, cap: number): number {
  return cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0
}

/** Credit-value dollars, two decimals. */
function money(value: number): string {
  return `$${value.toFixed(2)}`
}

/** The CLI's own duration format: whole minutes from `ceil`, `d`/`h`/`m`, minimum 1m. */
function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  return `${rest}m`
}

/**
 * The summary sub-section: the cycle's token counts (in/out, or the total
 * when the split is absent), requests, spend, and the purchased extra-credit
 * balance. Whatever the summary leg said nothing about renders no row.
 */
function summarySection(snapshot: UsageSnapshot): DealsRow[] {
  const rows: DealsRow[] = []
  const totals = snapshot.totals
  if (totals?.tokensIn !== undefined) rows.push(["Token In", compact(totals.tokensIn)])
  if (totals?.tokensOut !== undefined) rows.push(["Token Out", compact(totals.tokensOut)])
  if (
    totals?.tokens !== undefined &&
    totals.tokensIn === undefined &&
    totals.tokensOut === undefined
  ) {
    rows.push(["Tokens", compact(totals.tokens)])
  }
  if (totals?.requests !== undefined) {
    rows.push(["Request", totals.requests.toLocaleString("en-US")])
  }
  if (totals?.cost !== undefined) rows.push(["Total Spent", money(totals.cost)])
  if (snapshot.purchasedCredits !== undefined) {
    rows.push(["Extra Credit", money(snapshot.purchasedCredits)])
  }
  return rows
}

/** Compact token counts: 1135619637 → 1.14B. */
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })

function compact(value: number): string {
  return COMPACT.format(value)
}
