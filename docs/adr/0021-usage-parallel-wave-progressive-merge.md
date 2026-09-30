# ADR-0021: The usage refresh is one parallel wave, publishes progressively, and merges the last-good snapshot

Status: accepted

Issue #251. Three reported symptoms — ~10 s of blank `Usage` segment after a
session starts, a first render that is missing the Monthly meter and the
summary rows, and the data vanishing again — traced to one chain design and one
missing seam.

## What was measured (2026-09-30, live API, the reporter's credential)

- The four billing legs the CLI's `/usage` overlay reads answer in **8–18 s
  each** (whoami 8.7–18.1 s, subscriptions 10.0–20.6 s, summary 7.2–13.5 s,
  credits 0.2–2.4 s over the probe runs). The upstream API is also flaky: whoami
  answered 500 and subscriptions answered `{ success: false, error }` on some
  probes.
- The legs **parallelize**: four concurrent requests each kept their sequential
  latency and the wall clock was the slowest leg (~16.5 s), not the sum
  (~42 s). The 8–18 s figure is latency, not contention.
- The **summary's `since` pin is output-neutral**: an unpinned summary and one
  pinned to `currentPeriodStart` returned 14/14 byte-identical fields. The pin
  stays for CLI fidelity, not correctness.
- The plugin's TUI host **re-evaluates the plugin module on hot reload**
  (module-eval count 1 → 2 in both running processes on a source save, with the
  process unchanged). Any module-scope cache would be wiped exactly on the
  remount that needs it; `globalThis` is not.
- The previous chain design — four legs strictly sequential, each with a
  5-second abort budget — therefore timed out whoami, subscriptions and the
  summary on every chain and published `{limited, fiveHour, weekly,
purchasedCredits}`: exactly the reported partial view. It also cached an
  empty `scope: {}` after a failed whoami and then skipped whoami forever, so a
  team account could never be re-scoped.

## The decisions

**1. One parallel wave, 25-second budget.** `fetchUsageSnapshot` starts
credits, subscriptions and the summary together (whoami beside them on a cold
chain), applying the cached scope's `orgId`/`since` when known. The wall clock
approaches the slowest leg. `REQUEST_TIMEOUT_MS` is 25 s — above every measured
leg — because a budget below a leg's true latency does not make the chain
faster, it only guarantees a partial snapshot. The plan lookup
(`cmd_plan_summary`) gets the same budget for the same reason.

**2. The cold chain is speculative and whoami-gated.** With no cached scope the
scope-dependent legs start unscoped at t0. Nothing is published until whoami
answers: a whoami naming an org **discards** the unscoped results and re-runs
the wave scoped (a team account must never show the unscoped context's
numbers), while a whoami that answered "no org" — or failed, where the CLI's
own path is unscoped — keeps the wave. An orgless account, the common case,
therefore gets the full snapshot in ~max(leg) instead of the CLI's ~42 s.

**3. A failed whoami publishes no scope.** The scope cache is only written when
whoami settled (`{orgId}` or the orgless shape) or an earlier chain already
settled it. The next chain retries the org read rather than freezing an
unscoped cache.

**4. Last-good merge.** The fetch takes `previous` (the panel's last-good
snapshot) and merges field-wise: a field an answered leg carries wins, a field
it could not refresh keeps its previous value. `plan`/`periodEnd` deliberately
do **not** fall back — they follow the subscription slice, so a canceled
subscription clears the plan instead of resurrecting it (ADR-0011's "never a
stale plan"). A chain reports `unavailable` when **no leg answered with a
renderable row on this chain**, even if a previous snapshot exists, so the
panel's failed-refresh backoff keeps its meaning.

**5. Progressive publication.** The fetch publishes the merged view through
`onPartial` as each leg lands. v1 forwards it in-process; v2 emits one
`progress` event per landing leg over the plugin-RPC port's event channel,
correlated by a caller-generated `callId` (the definition's first use of
`events`). The v2 loader subscribes around the call and tears the subscription
down on settle — late frames are ignored, so a queued event can never overwrite
a settled outcome. The panel publishes partials without touching the backoff
ladder or the roll bookkeeping; only a settled outcome does.

**6. A session-keyed in-memory last-good cache.** `src/rates-usage/usage-cache.ts`
keeps the last published state per session (30-minute TTL, bounded recency) and
the default instance hangs off `globalThis` so the host's module re-evaluation
on hot reload cannot wipe it. Disk persistence is rejected: the snapshot is
read with whichever credential the session streams with, and a disk cache would
outlive it and could surface one account's numbers under another.

## Verification

- `tests/usage.test.ts` pins the speculative wave and its discard, the whoami
  failure path (no scope published), the 25 s budget, the merge (failed leg
  keeps rows; a dead chain is `unavailable`; a canceled subscription clears the
  plan), and the progressive publication order with held-open legs.
- `tests/usage-rpc.test.ts` pins the `progress` event schema, the handler's
  per-leg frames and `callId` correlation, the `previous` round-trip, and the
  loader's subscribe/filter/unsubscribe behaviour (a foreign `callId` and a
  late frame are dropped).
- `tests/tui-usage.test.ts` pins the seed-before-first-chain behaviour and the
  `previous`/`onPartial` panel wiring; `tests/tui-usage-refresh.test.ts` still
  pins throttle, coalescing, roll confirmation and the 5 → 10 → 20 → 30 minute
  backoff (request counts unchanged: 4 on cold mount, 2 per refresh).
- `tests/usage-cache.test.ts` pins the TTL, the recency cap and the
  process-global default.

## Consequences

- The four legs are still independently failing, but their latencies now
  overlap; the failure surface is one chain whose result may be partial, merged
  and published progressively.
- The v2 port definition gains its first event (`progress`) and its input
  gains `previous`/`callId`. `src/plugin/v2-types.ts` now mirrors the resolved
  registration (`events.emit`) and `v2-tui-types.ts` mirrors the subclient's
  `events.on`; both were re-checked against `@opencode/plugin` /
  `@opencode/client` 2.0.3 through 2.0.20.
- The scope cache no longer publishes on a pure-reuse chain, and a chain whose
  whoami failed publishes nothing — a behaviour change in `onScope` callers.
- Deleting the Rates & usage slice still leaves Core green: the cache lives in
  `src/rates-usage/`, and nothing in Core imports it.
