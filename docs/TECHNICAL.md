# Technical reference

How `opencode-cmd-provider` works under the hood — for maintainers, contributors,
and the curious. **Just want to use the plugin?** Read [README.md](../README.md)
instead; everything below assumes you are comfortable with plugin internals,
config keys, and generated catalogs.

- Design decisions: [`docs/adr/`](adr/) (index at the bottom of this file).
- Contributor workflow (commits, PRs, test list): [CONTRIBUTING.md](../CONTRIBUTING.md).
- Release ritual: [RELEASE.md](../RELEASE.md).

## Hosts and entry points

One package serves both OpenCode lines; three host processes load it.

| Host               | Configured in                                   | Default export                       | Registrations                                                                                                                |
| ------------------ | ----------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| OpenCode v1 server | `opencode.json` → `plugin`                      | `dist/index.js` → `{ id, server }`   | `config` hook (auto-registration + Rates & usage enrichment), `auth` (OAuth browser flow + API-key method), `tool` map       |
| OpenCode v2 server | `opencode.json` → `plugins`                     | `dist/index.js` → `{ id, setup }`    | `ctx.provider.transform` + `ctx.model.transform`, `ctx.integration.transform`, `ctx.tool.transform`, `ctx.aisdk.hook("sdk")` |
| TUI (both lines)   | v1: `tui.json`; v2: the package's `./tui` entry | `dist/tui.js` → `{ id, tui, setup }` | v1: `api.slots.register` on `sidebar_content`; v2: `ctx.ui.slot({ append: "sidebar.content" })`                              |

- The v1 and v2 halves are **independent implementations** of the same
  capabilities — v2 does not translate v1 hooks. The v2 host context is mirrored
  in `src/plugin/v2-types.ts` and the v2 TUI context in
  `src/plugin/v2-tui-types.ts`: the host injects those objects, so nothing in
  this package resolves `@opencode/*` or `@opencode-ai/*` at runtime (a runtime
  import would fail to resolve at load and kill the whole plugin).
- Both TUI hosts rewrite the bundle's `@opentui/*` and `solid-js` imports to
  their own module instances, which is why `dist/tui.js` is built as a single
  file with those specifiers external.
- `npm run build` needs [bun](https://bun.sh) on `PATH`: `tsc` emits the server
  halves, then `scripts/build-tui.ts` compiles `src/rates-usage/tui.tsx` with
  `@opentui/solid`'s solid transform so the panel's JSX props stay reactive.
- See [ADR-0001](adr/0001-auto-registration-snapshot.md) (auto-registration),
  [ADR-0004](adr/0004-rates-usage-slice.md) (the excisable Rates & usage slice),
  [ADR-0009](adr/0009-version-pinned-provider-specifier.md) (runtime-provider
  specifier), and [ADR-0010](adr/0010-dual-v1-v2-plugin-entrypoint.md) (the dual
  v1/v2 entrypoint, including the TUI half).

## Installation mechanics and caching

**v1.** `opencode plugin <spec>` detects `exports["./tui"]` and `main` /
`exports["./server"]` in the package manifest and writes the same spec into both
`opencode.json` (runner) and `tui.json` (sidebar panel) — project-local by
default, `--global` for `~/.config/opencode/`. Installed packages land in
OpenCode's plugin cache (`~/.cache/opencode/packages/`).

**v2.** `opencode plugin add <spec>` writes the global `plugins` entry. The v2
TUI host resolves each registered package's own `./tui` entrypoint itself, so no
`tui.json` is involved. Packages are cached under `~/.cache/opencode/npm/`.
Sibling commands: `opencode plugin list`, `check`, `update [<target>]`, `remove
<package>`.

**Nothing updates by itself.** OpenCode reuses a cached copy on every startup
without checking for a newer version, so a new release only appears after the
cache entry is removed (v1) or after `opencode plugin update` (v2). A launch
right after clearing the cache is slower because the package is re-downloaded.

**The runtime provider is version-pinned.** Auto-registration sets
`provider.commandcode.npm` to `opencode-cmd-provider@<package.json version>`
(v2: the same specifier as the provider's `package`, with the `aisdk:` prefix),
so the streaming runtime can never drift away from the plugin that registered it
([ADR-0009](adr/0009-version-pinned-provider-specifier.md)). The consequence for
development: a local build whose `version` has not been published cannot be
installed as the runtime provider — declare
`provider.commandcode.npm = "file://…/dist/index.js"` to point it at your
working tree instead. Clearing the cache removes both copies.

**OpenChamber users:** use **Reload OpenCode** in its settings instead of
restarting manually; a running OpenCode server keeps the old plugin loaded.

## Model discovery and offline behaviour

The package bundles its catalogs, so `/models` is populated without any network
call: OpenCode startup gains no latency, and model availability never depends on
the Command Code API being reachable.

- Auto-registered models carry the `[CMD] ` Display name prefix (e.g.
  `[CMD] Claude Sonnet 5`) so they are not confused with same-named models from
  other providers. A free-tier variant that shares an upstream display name gets
  a `(free)` suffix (`[CMD] MiniMax M3 (free)`); a model is labelled free only
  when the bundled pricing table carries an explicit zero-cost entry.
- The prefix is configurable on the declared provider entry — read-only, never
  written back to your config, and it applies to auto-registered models only
  (declared model entries are never renamed):

  ```jsonc
  // v1
  {
    "provider": {
      "commandcode": { "options": { "display_prefix": "" } }, // default "[CMD] "
    },
  }
  ```

  ```jsonc
  // v2 — providers are `providers`, the free-form bag is `settings`
  {
    "providers": {
      "commandcode": { "settings": { "display_prefix": "" } },
    },
  }
  ```

- Declared entries always win: `provider.commandcode` (v2:
  `providers.commandcode`) fills in only what it leaves unset, and
  `whitelist` / `blacklist` on a declared entry also filter the auto-registered
  models.
- A stale plugin cache is the usual reason a newly released model does not show
  up in `/models`.

## Generated catalogs

Four generated modules carry the data, all regenerated from upstream rather than
hand-edited:

| Module                          | Contents                                                                                                                                 | Regenerated by                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `src/catalog/snapshot.ts`       | Model ids, names, context lengths — the membership authority (the `models.md` table shipped by the CLI package)                          | `npm run refresh:snapshot`       |
| `src/catalog/facts.ts`          | Reasoning efforts, per-1M-token rates, input modalities, model families                                                                  | `npm run refresh:snapshot`       |
| `src/catalog/classification.ts` | Per-model reasoning capability, derived any-true-wins from the models.md efforts entry, the docs' RSC flag, and the models page Caps bit | `npm run refresh:classification` |
| `src/rates-usage/catalog.ts`    | Tier, benchmark, deal discounts, `was`/`now` rates, peak/off-peak windows, GOAT/Pro allowances                                           | `npm run refresh:deals`          |

`npm run refresh` runs the whole pipeline: snapshot + facts from the live
catalog, the RSC fixtures re-captured from the live docs pages
(`npm run refresh:fixtures`), then the classification module and deals catalog
regenerated from the fresh fixtures — so fixtures, catalogs, and their
fixture-based tests stay in lockstep. Standalone live runs fall back to the
committed fixtures on 5xx/network failure and fail loudly on 4xx; add
`-- --fixtures` to regenerate offline.

A daily GitHub Actions cron (`.github/workflows/catalog-refresh.yml`, 06:00 UTC,
also `workflow_dispatch`) runs the same pipeline and opens a
`chore: catalog refresh` PR when upstream moved, with the human-readable diff
from `scripts/diff-catalog.mjs` (model catalog, classification flips, deals
sections). A run whose only change is the refreshed-date stamps exits silently.

Coverage gates are inverted to membership-superset-of-enrichment: enrichment
(deals, classification, modalities) must be a subset of the Snapshot, and a
model with no enrichment ships core-only with a visible `pending` report — never
a failed refresh. The shape gate stays loud: a parser change in any source, or an
unshippable ship-bar row after the full ladder, fails the refresh.

## Rates & usage

The Deals catalog is extracted from the Command Code docs' React Server Components
(RSC) stream — the `pricing-limits`, `plans/goat`, and `plans/pro` pages fetched
with an `rsc: 1` header ([ADR-0005](adr/0005-rsc-primary-deals-cron.md)). It
surfaces in two places:

- **Rates & usage panel** (`src/rates-usage/tui.tsx`): the server half writes the payload to
  the model's provider options — v1 `options.cmd`, v2 `settings.cmd` — and the
  panel renders in segmented rows for the session's selected model: tier/status,
  an `Allowance` heading over one row per displayed plan (Pro (legacy) and
  Provider keep their catalog rows and payload data — the plan-summary tool and
  the transport still read them — but never render as panel rows), a **`Rates`**
  section, then an **`Other Information`** heading over the deal/benchmark rows
  (`Deal`, `Was`, `Now`, `Intelligence`, `Tok/s`), blank lines between segments.
  `Rates` prints each published band — time-of-day (`Peak`, `Off-peak`) and/or
  context-window bands labeled by their published thresholds (`≤ 272K`,
  `> 272K`, …) — as a `Name: in | out | cache r | w` label over its
  pipe-separated per-million values, then the `Peak Windows` schedule as its own
  block; a model with no published band shows the host model cost it bills
  against in the same two-line shape, and one with neither reads `N/A`. The row
  set is fixed: every Command Code model shows every row, with `N/A` for rows
  the payload says nothing about, and a selected model from any other provider
  hides the panel.
- **`cmd_plan_summary` tool**: plan-aware allowances and deal rates for
  estimating monthly request counts. It resolves the plan from
  `GET /alpha/billing/subscriptions`, org-scoped through `/alpha/whoami`, using
  the credential the Host resolved for the provider — v2's active connection,
  v1's provider record — and only falls back to `COMMANDCODE_API_KEY` and the
  legacy auth files when the Host resolves none
  ([ADR-0015](adr/0015-host-credential-for-tools.md)); pass the `plan` argument
  or set `COMMANDCODE_PLAN` (`go|goat|pro|prolegacy|max|max20|teampro|provider`)
  to skip the lookup, and the header then reads `# Command Code plan: Go (pinned)` — a pin
  never renders as a detected plan (issue #214). It renders one provenance line
  under the plan header — the account the
  lookup answered for plus the credential rung (`Host connection`,
  `COMMANDCODE_API_KEY`, `legacy file ~/.commandcode/auth.json`, the pin) — so a
  lookup that fell through to another account's file is visible; the line carries
  no key material ([ADR-0017](adr/0017-plan-summary-provenance-line.md)). An
  unresolvable plan reports "plan unknown" — never a guessed default
  ([ADR-0011](adr/0011-billing-derived-plan-identity.md)). Plan detection does
  not choose a transport: requests start on the Provider API unless `plan=go` is
  pinned, and a Go account switches to the legacy endpoint automatically when the
  Provider API answers the plan-gate `403` — `/chat/completions` sends
  `error.code: upgrade_required`, while `/messages` sends the Anthropic envelope
  (`type: permission_error`) with the plan phrasing and no code (issue #175). A
  stale-client version gate (`minVersion` / "out of date") is never read as a
  plan flip — it surfaces its own plugin-named update message instead (see
  [Legacy wire version and temperature](#legacy-wire-version-and-temperature)).
- **Visible degradation:** when the bundled Deals catalog is empty (upstream
  fetch failed or the RSC shape changed), the sidebar shows a
  `Deals unavailable` banner with every row reading `N/A` and the tool says no
  deal data is bundled. Core (models, auth, streaming) is unaffected.

### Live usage segment

The sidebar's `Usage` segment (issue #241) reads the same billing API the
official CLI's `/usage` overlay reads, one request per leg, each failing on its
own — a flaky leg drops only the rows it feeds:

- `GET /alpha/whoami?limits=1` — the org scope for team accounts
- `GET /alpha/billing/subscriptions[?orgId=]` — plan identity and the billing
  period
- `GET /alpha/billing/credits[?orgId=]` — the 5-hour and weekly windows, the
  monthly credit pool, and the purchased extra-credit balance
- `GET /alpha/usage/summary[?orgId=][&since=<currentPeriodStart>]` — the
  cycle's requests, tokens and spend

The CLI reads them strictly sequentially, which costs the sum of the leg
latencies; the live API answers a leg in 8–18 seconds (five live probes,
2026-09-30), so the plugin reads them as one **parallel wave** (issue #251)
with a 25-second budget per leg — whoami, subscriptions, credits and the
summary all start at once, with the cached scope's `orgId`/`since` applied when
known. The summary's period pin is a fidelity choice — its pinned and unpinned
outputs were measured byte-identical — and is kept whenever the cached scope
carries the period start. A chain whose whoami names an org discards its
speculative unscoped wave and re-runs it scoped; a whoami that answered "no
org", or failed, keeps the wave (the CLI's own path there is unscoped too). A
failed whoami publishes no scope, so the next chain retries the org read — the
live `scope: {}` freeze is gone.

A chain that cannot refresh a leg merges its last-good snapshot field-wise
over what it did read, and each landing leg is published as it arrives: the
credits meters render (~1 s) long before the slow subscriptions/summary legs
(~16 s) answer. The last-good snapshot also survives panel remounts — the TUI
host remounts the sidebar on session and model switches and, in the plugin's
dev loop, on every hot reload of the TUI module — through an in-memory store
keyed by session (`src/rates-usage/usage-cache.ts`: 30-minute TTL, `globalThis`-backed
because a hot reload re-evaluates the module). It is in-memory only: a disk
cache would outlive the credential it was read with. A chain that answers with
no renderable row at all still reports `unavailable`, so the failed-refresh
backoff (below) keeps its meaning.

The credential those reads use is resolved per TUI half (issue #243,
[ADR-0020](adr/0020-tui-host-credential-for-usage.md)):

- **v1 TUI:** the `commandcode` provider record the TUI state already holds
  (the structural `options.apiKey ?? key` read), falling back to its own
  `client.provider.list()` when the record carries neither at runtime; below
  it, the package ladder — `COMMANDCODE_API_KEY`, then the legacy auth files,
  keeping the file label as provenance. That ladder mirrors the transport's
  own last resort, so it only answers what would actually stream.
- **v2 TUI:** the plugin's own server half, over the plugin-RPC bridge
  (`src/rates-usage/usage-rpc.ts`): the server registers the `commandcode` port at
  setup, resolves the Host's active connection per call — stored credentials
  included, the read the TUI process cannot make — and runs the billing fetch
  itself, returning the snapshot, the refreshed scope and the rung. The
  caller's last-good snapshot rides _in_ (display data only; the server half
  stays stateless), and each landing leg rides back out as a `progress` event
  the TUI correlates by `callId` (issue #251). The key never leaves the server,
  and there is no fallback: no connected credential answers the notice, and an
  unreachable bridge degrades to `unavailable` rather than another account's
  numbers.

Nothing resolving means zero requests and the one-line notice
`Usage needs COMMANDCODE_API_KEY — set it to see live limits`; the credential
rung the loaders report is no longer rendered.

The segment renders one sub-section per meter — a muted label, a 33-cell
progress bar (the 37-character sidebar column minus the four-character
right-aligned percentage field) and the `$used / $cap` detail with its
countdown or renewal — then a summary: tokens in/out, requests, spend, and the
purchased extra-credit balance the `/usage` overlay labels `Extra Credits`. A
bar fills to the nearest half cell and colours by progress: green at 40% or
below, yellow through 80%, red above.

The refresh is event-driven, never polled (issue #245): **4 requests on a cold
mount** (the parallel wave above — a team account whose whoami names an org
additionally pays the discarded unscoped wave and its scoped re-run, 7 in
total; the whoami org scope is cached for the panel's lifetime — unless the
whoami failed, in which case the next chain retries it — and the subscription
record is re-read only once its period has ended or it is over an hour old),
**2 per throttled refresh** (credits + summary, triggered by a completed turn
in the watched session at most once every five minutes — in-cooldown signals
coalesce into one trailing refresh), and **zero while idle** — a 30-second
local clock redraws the countdowns with no network and confirms each window
roll with at most one refresh. A failed chain backs off 5 → 10 → 20 → 30
minutes while the last-good snapshot stays on screen; a success resets the
ladder. On v2 each chain is one plugin-RPC call plus its `progress` events,
and the counts above are the billing requests the server half makes.

### Sidebar segments and the layout dialog

The panel's rows are five segments — Tier/Status, Allowance, Rates, Other
Information and the Usage block above. Which of them render, and in which
order, is a per-machine user choice (issue #253,
[ADR-0022](adr/0022-sidebar-segment-layout.md)): the **Show, hide and reorder
sidebar content** command — `/cmd-rates-usage` in the prompt — opens a dialog where
up/down moves the cursor, space/enter toggles the selected segment,
shift+up/down reorders it, `r` restores the default layout and escape closes.
Changes apply live.

The layout is a JSON record `{ order, hidden }`; `order` carries all five ids
including hidden ones (unhiding restores a position) and `hidden` names what
not to render. `src/rates-usage/segments.ts` owns the vocabulary, the key map and
`normalizeLayout`, which drops unknown/duplicate ids and appends ids a store
is missing — so a release that adds or removes a segment can never make it
vanish or crash the panel, and no migration exists. Persistence is each TUI
host's own durable store: v1 `api.kv` under `commandcode.rates-usage.segments`
(the shared `state/kv.json`, read reactively), v2 `ctx.storage.store(...)`
(disk-persisted, live-synced across TUI instances, host-namespaced by plugin
id).

Composition rules: `panelRows` joins the visible segments with exactly one
blank line, trims blank edges a segment ships itself (the usage renderer's
leading separator), skips segments that render no rows (Usage before its
first load), and emits nothing when every segment is hidden — the panel and
its `Command Code` header disappear entirely. The `Deals unavailable` banner
is pinned above whichever segment comes first, but only while a catalog
segment (anything but Usage) is visible; a Usage-only panel carries no
catalog warning.

The commands register through `api.keymap.registerLayer` on v1 (the
deprecated `api.command` shim only forwards to it and warns) and
`ctx.keymap.layer` on v2. The v1 dialog additionally registers a
`priority: 1` keymap layer for its lifetime (`bindV1DialogKeys`): the prompt's
managed textarea layer owns the focused prompt's arrows at default priority,
so raw keyboard handlers never see them while a session prompt is mounted —
the host's own `DialogSelect` wins them the same way through its focused
filter input. On v2 the layer comes from a headless component mounted through
the `app` slot instead, because the v2 keymap layer is a Solid context owned
by the calling component: created from `setup` it throws
`Keymap.Provider is missing` and takes the sidebar down with it. The v2 layer
is `mode: "global"` because layers otherwise default to `base`, and the
command palette lists only reachable commands while its own dialog is open —
a base-mode entry silently disappears. Both measured on opencode 2.0.20.
`SegmentsDialog` is one shared component mounted through
`api.ui.dialog.replace` / `ctx.ui.dialog.show`; its key handling is the pure
`segmentKeyIntent`. The v1 keymap slice is mirrored inside
`src/rates-usage/tui.tsx` (`@opentui/keymap` is host-provided and not installed);
the v2 `keymap`/`storage`/`ui.dialog` slices extend
`src/plugin/v2-tui-types.ts` and are re-checked across 2.0.3–2.0.20.

## Reasoning support

Reasoning metadata derives from the generated classification module
([ADR-0006](adr/0006-derived-reasoning-classification.md)): models upstream flags
as reasoning-capable advertise `reasoning: true` automatically — with explicit
effort variants when the generated facts list levels, without variants
otherwise. Supported levels are sent as the documented `reasoning_effort`
request field; an unadvertised ladder level snaps to the nearest advertised one,
ties upward, on the fixed ladder
`off < minimal < low < medium < high < xhigh < max`
([ADR-0019](adr/0019-out-of-vocabulary-efforts-snap.md)). `off`, a string that is
not a ladder level, and a model with no advertised levels add no reasoning
fields. No prompt instructions are injected. On the Anthropic dialect
(claude models), reasoning blocks from completed assistant turns are not
replayed upstream in later requests — only user-visible text and completed tool
calls go back as history — because a replayed Anthropic thinking block must
carry the provider's signature, which a history part never does: signatures are
attached only to the parts of the turn being streamed, and no history codec
reads `providerMetadata` when building a request. The one
exception there is a paused turn's continuation, which replays the portion of
the turn the provider paused — its signed thinking blocks included, signature
and all (issue #189): the parser carries the signature on the block's
`reasoning-end` part in `providerMetadata.anthropic.signature` for exactly that
replay.

On the OpenAI dialect (`/provider/v1/chat/completions`), reasoning from
completed assistant turns **is** replayed as `reasoning_content` — but only for
reasoning-capable models (the same catalog-derived gate as `reasoning_effort`,
[ADR-0016](adr/0016-openai-dialect-reasoning-history.md)). DeepSeek V4.x
requires the full prior `reasoning_content` on tool-calling continuations
(HTTP 400 without it); GLM-5.3 and Qwen 3.8 preserve prior thinking for
accuracy and cache hits (for GLM, Z.ai documents preservation as default-on on
its Coding Plan endpoint, `clear_thinking: false` opt-in on the standard one —
which behavior the Provider API applies is not published, and replaying is
correct on either). A turn whose only tool call was unpaired (no result) is
still dropped whole: an assistant message without `tool_calls` cannot carry
`content: null`. The field matches the one the stream parser reads
these models' reasoning from, and the pause-resume path already replays it.

Anthropic's `redacted_thinking` block — reasoning the provider's safety system
encrypted — surfaces as a reasoning part too: no text, and its payload in
`providerMetadata.anthropic.redactedData` on the `reasoning-start` part (issue
#193). That is the shape the AI SDK's own Anthropic provider emits, and it is
what makes the block replayable — a continuation puts it back verbatim, because
the payload cannot be re-derived. A block type the parser does _not_ model emits
no part at all (#72): harmless for a turn that ends, refused for a pause whose
continuation would otherwise drop it (issue #192).

## Image input

Image input is advertised only for models marked with the `image` input modality
in the Command Code CLI bundle (generated into `src/catalog/facts.ts`); unknown
models stay text-only until reviewed. For vision-capable models, image blocks
from user messages and tool results are forwarded in Command Code's data-URL wire
format; text-only models reject image content before making a network request
rather than silently dropping it.

## Claude prompt caching

Claude requests through the Provider API (`POST /provider/v1/messages`) send the
system prompt as a content-block array carrying one ephemeral cache breakpoint
(`cache_control: { type: "ephemeral" }`), mirroring the official CLI's
`toWireSystem()`. Anthropic's cache is prefix-based, and the system block is the
stable head every turn shares: with the breakpoint a repeated ~7k-token prefix
reads back as `cache_read_input_tokens` (~99%) instead of being re-billed as
fresh input — live-measured 7015 fresh tokens per turn without it, against 13
fresh + 7142 cached with it. Only the system prefix is marked; caching message
history (a rolling breakpoint) is a separate product decision and is not
requested. The legacy `/alpha/generate` body keeps its plain-string system
prompt: that gateway injects its own 1-hour breakpoint and replaces the client's
5-minute one, so the port would be inert.

## Legacy wire version and temperature

`POST /alpha/generate` is version-gated: an absent, unparseable or too-old
`x-command-code-version` answers `403 upgrade_required` with a `minVersion`
(`0.18.10` when last probed; `/provider/v1/*` is not gated at all). The plugin
reports the command-code build its Snapshot was refreshed from
(`FACTS_PACKAGE_VERSION`) rather than a frozen literal: `npm run refresh:snapshot`
moves it with the published package, and the release pipeline fails on a stale
catalog ([ADR-0003](adr/0003-release-gates.md)), so the reported version travels
with the published CLI. `tests/provider-version-gate.test.ts` keeps it clear of
the floor the live gate last recorded — a static backstop, since the floor is
server state that no CI run can probe. When a gate does fire, the transport
surfaces its own message naming `opencode-cmd-provider` and the server's minimum
instead of forwarding the body's advice to update "the Command Code CLI" — a
binary plugin users are not running. The failure is a fatal `403`: never
replayed by the retry ladder, never a transport flip. `x-co-flag`, which the
frozen literal travelled with, is gone — it appears nowhere in
`command-code@1.54.0` and is inert.

The caller's `temperature` is forwarded verbatim when the host sets one (v1's
`chat.params` hook, v2's call settings), with the legacy body falling back to
the `0.3` it has always sent when none is set. The Provider API bodies forward
the value only: upstream's own request builders omit the field when it has no
value, and Anthropic rejects a temperature alongside extended thinking, so an
invented default there would break reasoning models.

## Stream termination and retries

A turn ends only on a terminal event. A `finish` part is held until the response
body is drained, so a trailing usage-only chunk (OpenAI `choices: []`) or
`message_delta` (Anthropic) can replace it. A held finish is emitted only when it
carries usage the provider actually reported: a body that dies after a
usage-bearing finish (the legacy codec's `totalUsage`, Anthropic's
`message_delta`) has declared the turn complete, while a finish synthesized from
an OpenAI `finish_reason` chunk — its trailing usage chunk never arrived — fails
the turn with `MissingUsageError` (`status` 502) instead of reporting a complete,
zero-cost answer. A **pause** is the one exception: the turn is not over, so the
turn is continued rather than failed, and the unpriced segment contributes
nothing to the sum the resumed turn reports — a segment the provider never
priced is unknown, not zero (issue #190). The legacy `{"type":"abort"}` event is
the other terminal: it carries no finish part, so the transport closes the parts
the parser still holds open and ends the turn without inventing one — `ai@6`
tolerates a missing finish, as upstream's own consumer does (`!finish && !abort`
is its truncation check). Anything else is a failure: a body that closes with no
terminal — truncated by a proxy, or ended early by the server — raises
`TruncatedStreamError` (upstream's wording, `status` 502, `name` on the Error).
Both failures surface as the `error` part; `doGenerate` fails the same way, off
the same transport.

On the OpenAI dialect a `usage` report is not by itself a terminal. Some
providers — Command Code's GLM-5.3, via its Z.ai upstream — attach a cumulative
usage object to every chunk, and reading each as the turn's end closed and
reopened the reasoning and text parts once per token, so the Host stored one
part per token and rendered the answer one word per line. Only a chunk with no
choices (the dialect's trailing usage-only report) is terminal on usage alone,
and only once a `finish_reason` has already been seen — a usage-only chunk
before any `finish_reason` is a running report, not an ending. A chunk with
choices ends the turn only through a `finish_reason`, which the held finish
keeps for that trailing usage-only chunk (ADR-0018). A stream that never
reports a `finish_reason` is therefore a truncation, exactly like any other body
that closes without a terminal.

A `pause_turn` is not an ending either. The provider stopped mid-turn and
expects the request to continue it — Anthropic reports it as a
`message_delta` stop_reason, the legacy codec in its `finish` event (upstream
reads `rawFinishReason ?? finishReason` there), the OpenAI shape as a
`finish_reason` — and upstream `command-code@1.54.0` loops on it in both of its
paths (`Ph = 5`). This transport appends the continuation's parts to the same
stream and folds each continuation's usage into the turn's single `finish`
(upstream's `addUsage2`, the only place the CLI sums usage — the usage of a
retry that _replaced_ an attempt is not part of the sum). What the continuation
_asks for_ differs by transport: the legacy `/alpha/generate` transport re-POSTs
the same body, byte for byte, while the Provider API re-sends the request with
the paused assistant turn appended (upstream's AI-SDK path resumes it exactly
that way). That appended turn is everything the turn has produced so far —
every continuation included, so a turn the provider paused twice carries both
segments — in the dialect's shape: text as content, tool calls with their ids,
names and arguments verbatim, and thinking blocks with whatever the provider gave
them — a signature, or the encrypted payload of a redacted block — because
neither can be re-derived. That is what keeps a resumed turn the turn the model was making. A paused turn
carrying a shape the continuation cannot represent faithfully is failed loudly,
naming what could not be carried, rather than resumed as a turn the model never
made: unsigned thinking (Anthropic requires a signature and the plugin cannot
derive one), a tool call with no id or name, arguments that are not JSON, and any
part the builder does not model. Content the stream never turned into a part is
invisible to that builder, so it is refused a step earlier: the Anthropic parser
reports the content-block types it does not model, and the transport refuses to
continue a pause whose response held one, naming the type — the alternative is a
continuation that silently drops it (ADR-0014). A turn that _ends_ with such a
block is unaffected: #72 still emits no part for it. The bound is five
continuations: a turn still paused there fails with `PauseTurnLimitError` instead
of emitting `finish{pause_turn}`, which v1 reads as a completed turn and v2
rejects as a retryable incomplete stream. Whatever the paused response left open
is closed before its continuation opens its own parts.

### Finish reasons

A turn that ended must never be reported with `unified: "other"`: OpenCode v2
coerces that to `unknown` and fails the turn as a retryable incomplete stream,
while v1 completes it quietly — the failure was invisible anywhere except v2
(ADR-0013). The mapper therefore knows the vocabulary the wire can actually
send, matched case-insensitively the way upstream's own normaliser lowercases
before matching:

| wire reason                                                                                                       | unified      |
| ----------------------------------------------------------------------------------------------------------------- | ------------ |
| `tool_use`, `tool_calls`, `tool-calls`, `function_call`                                                           | `tool-calls` |
| `length`, `max_tokens`, `max_output_tokens`, `model_context_window_exceeded`                                      | `length`     |
| `error`                                                                                                           | `error`      |
| `stop`, `end_turn`, `stop_sequence`, `refusal`, `content_filter`, `max_turn_requests`, `cancelled`, anything else | `stop`       |

Each spelling is taken with either separator (`tool_calls` / `tool-calls`,
`max_tokens` / `max-tokens`, `max_output_tokens` / `max-output-tokens`,
`model_context_window_exceeded` and its hyphenated form), since the wire chooses.
The last row is upstream's own default (`normalizeStopReason2` completes every
reason it does not know), and `refusal` / `content_filter` follow it too: the
plugin's contract is CLI parity, and the model's refusal is the answer the user
is meant to read, not a turn the Host should treat as blocked. `pause_turn` is
in that row as well — it maps to a completed turn like any other unknown reason,
and the transport intercepts it by its **raw** reason before any finish part is
emitted. The old vocabulary gap (the OpenAI spellings `tool_calls` /
`content_filter`, Anthropic's `refusal` / `model_context_window_exceeded`,
`function_call`, `max_turn_requests`, `cancelled`, and every casing variant) sent
those reasons to `other`, which is exactly the v2 failure ADR-0013 records.
`tests/stream.test.ts` holds the vocabulary table and an invariant test that no
stream the three codecs can produce ends `other`.

Two finish _events_ never reach that mapper, because they are not endings at all
— upstream's own guards on its legacy consume loop, mirrored here (issue #187).
A legacy `finish` reporting `other` with **no** raw reason is upstream's
truncation condition (`stopReason === "other" && rawFinishReason === undefined`):
the codec raises `TruncatedStreamError`'s wording as a classified, retryable
truncation instead of completing the turn. A reason matching
`network` / `connection` / `upstream` + `error` (any separator or case —
upstream's `isNetworkFailureFinish` regex) is a connection that died mid-stream:
the codec raises a retryable transport failure naming the reason. Both are
replayed only while the consumer has seen nothing, like every other transient
failure, and both surface as the `error` part after the budget. A raw reason
beside `other` is the explanation the guard was waiting for, so that turn ends
normally.

Retries are causal: every failure is classified first, and only the kinds whose
own shape says "transient" are replayed. The vocabulary and the rules are ported
from upstream `command-code@1.54.0` (`isModelCallRetryable`,
`isStreamErrorRetryable`, `parseWindowLimitError`):

| failure                                                                                                                                                                                           | kind               | replayed                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------- |
| fetch rejection, read failure, per-attempt timeout, or a legacy `finish` naming a network/connection/upstream error                                                                               | network            | yes                           |
| HTTP 408 / 429 / 5xx                                                                                                                                                                              | retryable status   | yes                           |
| HTTP 400 / 401 / 403 / 404 / 422, and every other status                                                                                                                                          | fatal status       | no                            |
| 429 (or a `RATE_LIMITED` code) naming a usage window                                                                                                                                              | window limit       | no                            |
| `Retry-After` beyond `maxRetryDelayMs`                                                                                                                                                            | retry-after cap    | no                            |
| the plan-gate 403: `upgrade_required`, `upgrade to GOAT/provider`, or "without / doesn't include API access"                                                                                      | transport flip     | flipped once, never replayed  |
| body ended with no terminal, with only a synthesized finish that is not a pause, or with a legacy `finish` reporting `other` and no raw reason                                                    | truncation         | yes, while nothing is visible |
| server `error` event: `isRetryable: true`, else a reported 408/429/5xx, else retryable unless it says `false` or names `premium_credits_exhausted` / `model_not_in_plan` / `insufficient credits` | stream error       | per that rule                 |
| a turn still paused after five `pause_turn` continuations                                                                                                                                         | pause-turn limit   | no                            |
| a paused turn whose continuation cannot represent its content faithfully                                                                                                                          | resume-unsupported | no                            |

`maxRetries` defaults to **2**: the hosts already run their own slower ladders
outside the plugin (v1 1.18.30: 5 retries; v2 2.0.3: 4, behind a hard
`!outputStarted` gate), so this ladder is deliberately short and fast — upstream
`command-code@1.54.0` sizes its 10-attempt ladder for the standalone CLI. The
option is reachable as `provider.commandcode.options.maxRetries` (v1) /
`providers.commandcode.settings.maxRetries` (v2), alongside `maxRetryDelayMs`
(default 60 s) which caps both the ladder's own backoff and any `Retry-After` the
transport is willing to honour. `maxRetries: 0` disables the ladder.

The backoff is `min(10 s, max(1 s, 500 ms·2^attempt))`, no jitter, bounded by
`maxRetryDelayMs`. A response's own `Retry-After` replaces it for that attempt
(0 means retry immediately), and a delay beyond the cap fails the request rather
than being thrown into a generic retry. Request headers are rebuilt for every
attempt, so a credential rotated mid-ladder is picked up by the next request.

Every failure raised from a non-OK response is surfaced as an AI SDK
`APICallError` (`HttpTransportFailureError`, ADR-0023): `statusCode`,
`responseBody` (the full redacted body), `responseHeaders`, `url` and
`isRetryable` are what the host classifiers read, so a fatal 4xx is not
retried as an unknown shape on v2 and a context-overflow body can trigger
compaction. The `failure` the ladder classified rides on the same instance, so
the host shape changes nothing here. Failures that are not an HTTP response
(network, timeout, truncation, stream events, pause/resume) stay plain errors.

A replay only ever happens while the consumer has seen nothing _from the request
being replayed_: any part it emitted other than `finish` — a bare `text-start` or
`tool-input-start` included — rules it out, because part lifecycles cannot be
replayed either. A terminal that carries the turn's usage report settles the turn
the same way. The request, not the stream, is the unit: a paused turn's
continuation may be replayed after earlier continuations put parts on the stream,
since those are never re-requested. The same rule bounds the transport flip — a
plan-gate `403` arriving mid-turn surfaces instead of re-running the call from
the start on `/alpha/generate` — while the session is pinned to legacy either way.

## Pricing display

The Command Code Provider API does not include prices in its model catalog, so
this provider builds an estimate table from the bundled `models.md` catalog for
OpenCode's cost display. The transport computes no cost of its own — it reports
each turn's usage and the host prices it from the advertised rates, so there is
exactly one cost path (issue #176). A model missing from that table displays zero
cost — which does **not** mean Command Code bills the request at zero. Check the
current [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits)
before relying on the displayed value.

## Environment variables

Credentials:

| Variable              | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `COMMANDCODE_API_KEY` | The API key. Used when no `/connect` credential is stored.        |
| `COMMANDCODE_PLAN`    | Pin the plan for `cmd_plan_summary`, skipping the billing lookup. |

Test, mock, and compatible-endpoint overrides:

| Variable                      | Purpose                                    |
| ----------------------------- | ------------------------------------------ |
| `COMMANDCODE_API_BASE`        | Override the Command Code API base URL     |
| `COMMANDCODE_FACTS_URL`       | Override the bundled `models.md` URL       |
| `COMMANDCODE_MODALITIES_URL`  | Override the CLI bundle URL                |
| `COMMANDCODE_RSC_PRICING_URL` | Override the `pricing-limits` RSC page URL |
| `COMMANDCODE_RSC_GOAT_URL`    | Override the `plans/goat` RSC page URL     |
| `COMMANDCODE_RSC_PRO_URL`     | Override the `plans/pro` RSC page URL      |

## Development and testing

```sh
npm install
npm run build       # tsc + bun scripts/build-tui.ts (bun must be on PATH)
npm test            # typecheck → unit → integration → contract → format:check
npm run lint:secrets
```

The headless end-to-end tests run the real OpenCode CLI against a mock Command
Code server through the built package:

```sh
npm run build && npm run test:e2e      # OpenCode v1 host
npm run build && npm run test:e2e:v2   # OpenCode v2 host
```

Both scripts take the binary from `PATH` and accept `OPENCODE_BIN` to point at a
specific install; each skips when that binary belongs to the other host's line,
so a v1 and a v2 install can sit side by side:

```sh
# npm skips the package's own postinstall in some environments (it fetches the
# platform binary) — run it yourself if `opencode --version` prints that hint.
mkdir -p /tmp/ocv1 && npm install --prefix /tmp/ocv1 opencode-ai@1.18.30
(cd /tmp/ocv1/node_modules/opencode-ai && node postinstall.mjs)

OPENCODE_BIN=/tmp/ocv1/node_modules/.bin/opencode npm run test:e2e   # v1 host
npm run test:e2e:v2                                                  # v2 host
```

`scripts/opencode-fixture.mjs` writes a throwaway `opencode.json` that wires only
the local build as a plugin — no declared provider or models — so
`opencode models` proves auto-registration against a real v1 binary.
`test:e2e:v2` installs the build at the documented v2 local-plugin path
(`.opencode/plugins/commandcode/`), runs a headless session, and asserts what the
host itself reports back: the provider, every Snapshot model, and the `/connect`
integration. Both scripts treat the `opencode run` leg's known hang against a
local/mock base URL as a skip (upstream bug: anomalyco/opencode #14956, #5674).

Both e2e scripts are excluded from `npm test`.

## Troubleshooting

- **New models or a new release do not appear.** Stale plugin cache — see
  [Installation mechanics and caching](#installation-mechanics-and-caching).
- **The provider fails loudly right after a local build.** The runtime provider
  is pinned to the package version; an unpublished version cannot be installed.
  Declare `provider.commandcode.npm` yourself
  ([ADR-0009](adr/0009-version-pinned-provider-specifier.md)).
- **v2 loads the plugin but nothing happens yet.** v2 activates plugins
  asynchronously; one-shot CLI reads such as `opencode models --standalone` can
  win the race and print nothing. `opencode run` waits, and a `serve`d instance
  exposes `POST /api/plugin/await-activation` as the explicit wait primitive.
- **v2 rejects a configured local plugin path.** It must be a **directory**
  ("configured plugin path must be a directory"), and a directory plugin can
  carry both halves (`index.mjs` for the server, `tui.mjs` for the sidebar).
- **`opencode --version` prints nothing.** It could not write its log — isolate
  `HOME` / `XDG_*` in scripted probes.
- **`opencode run` hangs before sending a request.** Known upstream bug against
  local/mock base URLs (anomalyco/opencode #14956, #5674); irrelevant against the
  real API.
- **A TUI plugin's `console.error` is invisible.** The TUI owns the screen and
  swallows the CLI process's output; log to a file when debugging a TUI half.

## Design records

| ADR                                                            | Decision                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [0001](adr/0001-auto-registration-snapshot.md)                 | Auto-registration from a bundled snapshot, config-hook mutation                                    |
| [0002](adr/0002-tag-driven-releases.md)                        | Tag-driven releases via GitHub Actions                                                             |
| [0003](adr/0003-release-gates.md)                              | Release gates and non-blocking catalog checks                                                      |
| [0004](adr/0004-rates-usage-slice.md)                          | Rates & usage as an excisable slice with visible degradation                                       |
| [0005](adr/0005-rsc-primary-deals-cron.md)                     | RSC stream as the primary deals source, refreshed by cron                                          |
| [0006](adr/0006-derived-reasoning-classification.md)           | Reasoning capability derived from generated classification                                         |
| [0007](adr/0007-auto-release.md)                               | Auto-release on merged catalog-refresh PRs                                                         |
| [0008](adr/0008-models-md-primary-catalog.md)                  | The models.md table is the sole membership authority                                               |
| [0009](adr/0009-version-pinned-provider-specifier.md)          | Runtime provider pinned to the plugin's exact version                                              |
| [0010](adr/0010-dual-v1-v2-plugin-entrypoint.md)               | One package and entrypoint for OpenCode v1 and v2 (server and TUI halves)                          |
| [0011](adr/0011-billing-derived-plan-identity.md)              | Plan identity from the billing subscription, never a default                                       |
| [0012](adr/0012-connect-callback-budget-and-api-key-method.md) | Human-scale connect callback budget, `api` method without `authorize`                              |
| [0013](adr/0013-finish-reason-vocabulary.md)                   | A turn that ended is never reported with `unified: "other"`                                        |
| [0014](adr/0014-unmodelled-block-refuses-resume.md)            | A resumed turn never silently drops a block the stream did not model                               |
| [0015](adr/0015-host-credential-for-tools.md)                  | The plan summary uses the Host's resolved credential, not a legacy file                            |
| [0016](adr/0016-openai-dialect-reasoning-history.md)           | The OpenAI dialect replays assistant reasoning in history                                          |
| [0017](adr/0017-plan-summary-provenance-line.md)               | The plan summary renders the account and the credential rung                                       |
| [0018](adr/0018-usage-is-not-a-terminal.md)                    | A usage report is not by itself a terminal on the OpenAI dialect                                   |
| [0019](adr/0019-out-of-vocabulary-efforts-snap.md)             | An unadvertised reasoning effort snaps to the nearest advertised level                             |
| [0020](adr/0020-tui-host-credential-for-usage.md)              | The TUI host resolves its usage credential (v1 in-process, v2 via the plugin-RPC bridge)           |
| [0021](adr/0021-usage-parallel-wave-progressive-merge.md)      | The usage refresh is one parallel wave, publishes progressively, and merges the last-good snapshot |
| [0022](adr/0022-sidebar-segment-layout.md)                     | The sidebar segment layout is user state, persisted by each TUI host                               |
| [0023](adr/0023-http-failures-surface-as-apicallerror.md)      | HTTP failures surface as AI SDK `APICallError`s (status, redacted body, retryable)                 |
