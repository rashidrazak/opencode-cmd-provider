// src/deals/usage.ts — the live usage snapshot behind the sidebar `Usage`
// segment (issue #242): one host-agnostic fetch of the four billing requests
// the official CLI's /usage overlay makes (whoami → org-scoped subscriptions →
// org-scoped credits → summary pinned with `since=currentPeriodStart`), its
// defensive row-oriented parse, and the pure renderer that turns a snapshot
// into the panel's rows. No UI wiring lives here (issues #243/#244 wrap it).
//
// Each leg fails on its own — a flaky whoami, credits or summary leg drops
// only the rows that leg feeds, never the whole segment — and every request
// carries only `Authorization: Bearer` with a 5-second abort budget, mirroring
// the plan lookup (issue #159, ADR-0011). No credential resolved means zero
// requests: `fetchUsageSnapshot` answers `no-credential` up front and the
// renderer prints the one-line notice.
//
// Since #245 the fetch also carries the panel's cached scope: the first chain
// reads whoami once and caches it with the subscription record; a later
// refresh passes the scope back in and the chain collapses to the two live
// legs — credits + summary — while the record is fresh (re-read only when its
// period end has passed or it is over an hour old). The caller's abort signal
// joins each request's timeout, so the panel's unmount cancels an in-flight
// chain.
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
// The renderer pins the segment: a `Usage` heading, the 5-hour/weekly meters,
// the monthly meter with renewal days, the muted cycle-totals line (requests,
// tokens, spend), the muted provenance line, and every degradation variant —
// no credential, no rolling windows (pay-as-you-go), idle window, unavailable.
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
import type { DealsRow } from "./tui.js"

/** Abort budget for each billing request, mirroring the plan lookup. */
const REQUEST_TIMEOUT_MS = 5000

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
 * The panel's cached billing context (issue #245). The first chain reads
 * whoami once and caches the org scope for the panel's lifetime; every later
 * chain reuses it and re-reads the subscription record only while it is
 * fresh, so a routine refresh is just the two live legs — credits + summary.
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
   * credential) runs in full.
   */
  scope?: UsageScope
  /** Called with the scope to cache whenever the chain reads whoami/subscriptions. */
  onScope?: (scope: UsageScope) => void
  /** The caller's abort signal, joined with each request's five-second budget. */
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
    snapshot.totals !== undefined
  )
}

/**
 * The four-leg billing fetch behind the usage segment: whoami (org scope) →
 * org-scoped subscriptions → org-scoped credits → summary pinned with
 * `since=currentPeriodStart`. Each leg is independent — a miss drops only the
 * rows it feeds — and a lookup without a resolved credential makes no request
 * at all. A cached `scope` (#245) skips whoami for good and subscriptions
 * while the record is fresh, leaving credits + summary.
 */
export async function fetchUsageSnapshot(options: FetchUsageOptions = {}): Promise<UsageResult> {
  const env = options.env ?? process.env
  const key = options.apiKey ?? env.COMMANDCODE_API_KEY
  if (!key) return { state: "no-credential" }
  const base = options.baseURL ?? getApiBase(env)
  const fetchImpl = options.fetch ?? fetch
  const catalog = options.catalog ?? PLAN_CATALOG
  const now = options.now ?? Date.now()

  // One leg: offline, timeout, non-2xx and an unparseable body are all a miss
  // for this leg alone (ADR-0011). Only the Bearer header travels. Each leg
  // arms its own five-second budget, joined with the caller's signal when the
  // panel has one, so an unmount aborts an in-flight chain (#245).
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

  // The cached scope (#245): whoami is read on the first chain and cached for
  // the panel's lifetime; the subscription record is re-read only when its
  // period end has passed or it is over an hour old. A failed re-read keeps
  // the old slice — its staleness re-triggers a read, and plan/since/periodEnd
  // keep shaping this snapshot.
  let orgId = options.scope?.orgId
  let cached = options.scope?.subscription
  let publishScope = options.scope === undefined
  if (options.scope === undefined) {
    const whoami = await getJson(WHOAMI_PATH)
    orgId = isRecord(whoami) && isRecord(whoami.org) ? stringValue(whoami.org.id) : undefined
  }
  if (!subscriptionsFresh(cached, now)) {
    const subscriptions = await getJson(`${SUBSCRIPTIONS_PATH}${scopeQuery(orgId)}`)
    cached = readSubscription(subscriptions, now) ?? cached
    publishScope = true
  }
  if (publishScope) {
    options.onScope?.({
      ...(orgId === undefined ? {} : { orgId }),
      ...(cached === undefined ? {} : { subscription: cached }),
    })
  }
  // Plan identity rides the subscription cache through Core's vocabulary,
  // gated on the statuses that still identify a plan (ADR-0011): a canceled or
  // unpaid subscription must not keep feeding the bundled cap fallbacks below,
  // and an unknown id is unknown — never a default.
  const plan = cached?.plan
  const since = cached?.since
  const periodEnd = cached?.periodEnd

  const creditsPayload = await getJson(`${CREDITS_PATH}${scopeQuery(orgId)}`)
  const credits =
    isRecord(creditsPayload) && isRecord(creditsPayload.credits)
      ? creditsPayload.credits
      : undefined
  const windowLimits =
    isRecord(creditsPayload) && isRecord(creditsPayload.windowLimits)
      ? creditsPayload.windowLimits
      : undefined

  const summaryParams = new URLSearchParams()
  if (orgId !== undefined) summaryParams.set("orgId", orgId)
  if (since !== undefined) summaryParams.set("since", since)
  const summaryQuery = summaryParams.toString()
  const summary = await getJson(`${SUMMARY_PATH}${summaryQuery === "" ? "" : `?${summaryQuery}`}`)
  const summaryRecord = isRecord(summary) ? summary : undefined

  const bundle = plan === undefined ? undefined : catalog[plan]
  const limited =
    windowLimits !== undefined && typeof windowLimits.limited === "boolean"
      ? windowLimits.limited
      : undefined
  const fiveHour = parseWindow(windowLimits?.fiveHour, bundle?.window5h)
  const weekly = parseWindow(windowLimits?.weekly, bundle?.windowWeek)
  const monthly = deriveMonthly(
    credits === undefined ? undefined : numberValue(credits.monthlyCredits),
    summaryRecord === undefined ? undefined : numberValue(summaryRecord.totalMonthlyCredits),
    bundle?.credits,
  )

  const snapshot: UsageSnapshot = {}
  if (plan !== undefined) snapshot.plan = plan
  if (limited !== undefined) snapshot.limited = limited
  if (fiveHour !== undefined) snapshot.fiveHour = fiveHour
  if (weekly !== undefined) snapshot.weekly = weekly
  if (monthly !== undefined) snapshot.monthly = monthly
  const totals = parseTotals(summaryRecord)
  if (totals !== undefined) snapshot.totals = totals
  if (periodEnd !== undefined) snapshot.periodEnd = periodEnd
  const periodBasis =
    summaryRecord === undefined ? undefined : stringValue(summaryRecord.periodBasis)
  if (periodBasis !== undefined && periodBasis !== "") snapshot.periodBasis = periodBasis

  return hasUsageData(snapshot) ? { state: "usage", snapshot } : { state: "unavailable" }
}

/** The segment heading, and its degradation lines. */
const USAGE_HEADING = "Usage"
const NO_CREDENTIAL_LINE = "Usage needs COMMANDCODE_API_KEY — set it to see live limits"
const UNAVAILABLE_LINE = "Usage unavailable — could not read the Command Code billing API"
const PAY_AS_YOU_GO_LINE = "No rolling windows on this plan — usage is pay-as-you-go"

const DAY_MS = 86_400_000
const SEP = " · "

export interface RenderUsageOptions {
  /**
   * The credential rung the snapshot was fetched with, rendered as the muted
   * `via …` line. Display data only: the key never travels with it, so no
   * rendering path can leak one (ADR-0015 rule 4, ADR-0017 rule 1).
   */
  provenance?: UsageCredentialSource
  /** Clock for countdowns and renewal days (defaults to Date.now()). */
  now?: number
}

/**
 * The credential rung behind a lookup, for the provenance line: the resolver
 * (#243) reports one of these — the same three display rungs the plan summary
 * names (Host connection / `COMMANDCODE_API_KEY` / a legacy file's label).
 */
export type UsageCredentialSource =
  { kind: "host" } | { kind: "environment" } | { kind: "file"; label: string }

/**
 * The `Usage` segment rows: a leading blank separator, then the heading. A
 * missing result is the no-credential state (the resolver found nothing,
 * #243) and every other state maps to its own degradation line. Pure:
 * countdowns and renewal days come from `options.now`.
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
  if (snapshot.limited === false) {
    // `limited: false` is the pay-as-you-go shape (extra credits bypass the
    // windows), so the rolling meters are explained away, not rendered.
    rows.push([PAY_AS_YOU_GO_LINE, "", "value"])
  } else {
    if (snapshot.fiveHour !== undefined) rows.push(meterRow("5-hour", snapshot.fiveHour, now, ""))
    if (snapshot.weekly !== undefined) rows.push(meterRow("Weekly", snapshot.weekly, now, ""))
  }
  if (snapshot.monthly !== undefined) {
    rows.push(meterRow("Monthly", snapshot.monthly, now, renewalSuffix(snapshot.periodEnd, now)))
  }
  const cycle = snapshot.totals === undefined ? undefined : cycleLine(snapshot.totals)
  if (cycle !== undefined) rows.push([cycle, "", "value"])
  if (options.provenance !== undefined) {
    rows.push([provenanceLine(options.provenance), "", "value"])
  }
  return rows
}

/**
 * One meter row: `$used / $cap · N%` plus a reset countdown when the window is
 * active, `$used used` when no cap is known, and the caller's suffix (the
 * monthly meter's renewal days) at the end.
 */
function meterRow(
  label: string,
  meter: { used: number; cap?: number; resetAt?: number },
  now: number,
  suffix: string,
): DealsRow {
  let value =
    meter.cap === undefined
      ? `${money(meter.used)} used`
      : `${money(meter.used)} / ${money(meter.cap)}${SEP}${percentOf(meter.used, meter.cap)}%`
  if (meter.resetAt !== undefined && meter.resetAt > now) {
    value += `${SEP}resets in ${formatDuration(meter.resetAt - now)}`
  }
  return [label, value + suffix]
}

/**
 * Days to the subscription renewal, mirroring the CLI: whole days from `ceil`,
 * floored at 0 so a just-rolled period reads "renews today" rather than a
 * negative count.
 */
function renewalSuffix(periodEnd: number | undefined, now: number): string {
  if (periodEnd === undefined) return ""
  const days = Math.max(0, Math.ceil((periodEnd - now) / DAY_MS))
  return days === 0 ? `${SEP}renews today` : `${SEP}renews in ${days}d`
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

/** The muted cycle-totals line: requests, tokens (in/out detail), spend. */
function cycleLine(totals: UsageTotals): string | undefined {
  const parts: string[] = []
  if (totals.requests !== undefined) {
    parts.push(`${totals.requests.toLocaleString("en-US")} requests`)
  }
  const tokens = tokenText(totals)
  if (tokens !== undefined) parts.push(tokens)
  if (totals.cost !== undefined) parts.push(`${money(totals.cost)} spent`)
  return parts.length === 0 ? undefined : `This cycle: ${parts.join(SEP)}`
}

function tokenText(totals: UsageTotals): string | undefined {
  const { tokens, tokensIn, tokensOut } = totals
  if (tokens === undefined) {
    if (tokensIn !== undefined && tokensOut !== undefined) {
      return `${compact(tokensIn)} in / ${compact(tokensOut)} out tokens`
    }
    if (tokensIn !== undefined) return `${compact(tokensIn)} in tokens`
    if (tokensOut !== undefined) return `${compact(tokensOut)} out tokens`
    return undefined
  }
  const detail =
    tokensIn !== undefined && tokensOut !== undefined
      ? ` (${compact(tokensIn)} in / ${compact(tokensOut)} out)`
      : ""
  return `${compact(tokens)} tokens${detail}`
}

/** Compact token counts: 1135619637 → 1.14B. */
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })

function compact(value: number): string {
  return COMPACT.format(value)
}

/**
 * The muted provenance line for one credential rung. The file rung's label is
 * data from outside (a store's path), so it is flattened and stripped of
 * backticks/pipes before it sits inside the line's own code span — the same
 * inert-label rule the plan summary applies (ADR-0017 rule 4).
 */
function provenanceLine(source: UsageCredentialSource): string {
  switch (source.kind) {
    case "host":
      return "via Host connection"
    case "environment":
      return "via COMMANDCODE_API_KEY"
    case "file": {
      const label = flattenLabel(source.label)
      return label === undefined ? "via legacy file" : `via legacy file \`${label}\``
    }
  }
}

/**
 * Flatten a display label so it cannot break or forge the line it sits in; an
 * all-whitespace label renders nothing.
 */
function flattenLabel(value: string): string | undefined {
  const label = value
    .replace(/[`|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return label === "" ? undefined : label
}
