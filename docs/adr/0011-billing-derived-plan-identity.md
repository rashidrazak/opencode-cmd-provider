# ADR-0011: Plan identity is billing-derived, and routing never asks for it

Status: accepted

Two decisions, taken together because the first made the second observable.

## 1. The account's plan comes from the billing endpoints

`GET /alpha/whoami` no longer returns a plan. It answers

```json
{ "success": true, "user": { "id": "…", "name": "…", "email": "…", "userName": "…" }, "org": null }
```

— no `planId`, no `plan`, with or without `?limits=1`. `resolvePlan()` read
`body.planId ?? body.plan?.id`, so every lookup resolved nothing and every
caller fell through to its default. Because the Deals default was `"go"`,
`cmd_plan_summary` rendered Go's credits, windows and deal table on every
account regardless of the plan purchased (issue #159).

Plan identity now comes from the endpoints the official Command Code CLI's own
billing client uses:

| request                                    | carries                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `GET /alpha/whoami`                        | `org.id` — the scope team plans bill under                       |
| `GET /alpha/billing/subscriptions?orgId=…` | `data.planId`, when `data.status ∈ {active, trialing, past_due}` |
| `GET /alpha/billing/credits?orgId=…`       | `credits.planId` — fallback only                                 |

The status gate is upstream's, not ours: a canceled or unpaid subscription must
not keep reporting the plan it used to hold. Each request fails on its own — a
flaky `whoami` must not hide a valid personal subscription — and any failure
(no credential, offline, timeout, non-2xx, unparseable body, unrecognized plan
id) resolves to `undefined`.

**An unresolved plan is not a default.** `resolvePlan()` returns
`PlanId | undefined` and has no `defaultPlan`; callers decide what "unknown"
means. `cmd_plan_summary` renders `# Command Code plan: unknown` with the
override instructions instead of a plan table, on the principle this ADR exists
to record: **a wrong answer presented as a detected fact is worse than no
answer.** The plan vocabulary and alias table (including `teams-pro`, the id
the API actually sends for Team Pro) live in Core, `src/catalog/plans.ts`.

## 2. Transport selection honours an explicit pin only

The plan lookup used to select the transport as well: a resolved `"go"` chose
the legacy `/alpha/generate` transport, everything else the Provider API. With
detection dead, transport selection had been "correct by accident" — paid plans
landed on the Provider API because _nothing_ resolved, and a genuine Go account
paid a wasted `403 upgrade_required` round trip before the issue #56 fallback
flipped it to legacy.

Routing no longer consults the network at all. It reads an explicitly written
pin — per-call `providerOptions.plan` → the model's `plan` option →
`COMMANDCODE_PLAN` — and only a pin that normalizes to `"go"` selects the
legacy transport. With no pin, every session starts on the Provider API and a
Go account flips through the documented 403. The pin stays an escape hatch for
a user who knows their plan; it is not detection.

Two consequences worth stating:

- **No request is made to route.** A model instance needs neither a credential
  nor the billing endpoints to pick a transport, so an unreachable or
  unauthorized billing API cannot change where inference goes.
- **Core no longer imports the Deals slice.** Plan identity moved to
  `src/catalog/plans.ts`, restoring the ADR-0004 invariant that deleting
  `src/deals/` (plus its two registration lines in `src/plugin/index.ts`)
  leaves Core intact. `tests/contract.test.ts` now enforces it.

## The legacy metadata on the Go path, pinned

The legacy transport's request carries `config.workingDir` (absolute cwd) and
the `x-project-slug` / `x-taste-learning` headers; the Provider API carries
none of them. A Go account reaches legacy either way — directly on an explicit
pin, or through the 403 fallback — so this exposure is inherent to serving Go
at all, not something this change introduces or removes.
`tests/provider-transport.test.ts` pins those fields on the fallback path so
the exposure stays visible and deliberate rather than incidental.

## The two Pro SKUs, resolved (issue #162)

The CLI's credits map and the docs table were never in conflict: they describe
two SKUs. `individual-pro` is the pre-reprice Pro — $15/mo, $30 of credits,
5h $9 / weekly $18 — kept for grandfathered subscribers; upstream's own web app
keys its "Legacy Pro" upgrade banner off exactly that id
(`assets/use-legacy-pro-status-*.js`, `assets/constants-*.js`,
`assets/plan-tiers-*.js`, fetched 2026-09-23). `individual-pro-v1` is the
current Pro the docs table describes ($20/$80, 5h $16 / weekly $40); the docs
table swapped its single Pro row for it between the 2026-08-03 and 2026-08-06
captures, which is why our docs-derived catalog lost the legacy row.
`PLAN_CATALOG` therefore carries both — `individual-pro-v1` → `pro`,
`individual-pro` → `prolegacy`, rendered as `Pro (legacy)` — because collapsing
them made a legacy account read as the current tier's price, pool and windows.
The legacy row renders no per-model allowance table: the docs allowances are
keyed `pro` and describe the current tier, not the grandfathered one. Its row
is hand-typed in the generator with a provenance comment, since no live source
still carries it; the #162 follow-up to generate or gate the plan rows instead
of hand-typing them remains open.
