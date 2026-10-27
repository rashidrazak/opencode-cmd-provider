# ADR-0024: Catalog-endpoint membership with a disk-cached startup tier

Status: accepted

Supersedes the membership half of [ADR-0008](0008-models-md-primary-catalog.md).
ADR-0008's source-authority table, ship-bar, ladder rules, and "only two loud
failure classes" disposition all survive; its single membership source does not.

**A note on the word "membership."** It means only _which models the catalog
carries_ — a structural fact about set inclusion, never a subscription, plan, or
account status (those are Plan identity and the Rates & usage slice). Because
this package also models plans, the bare word invited exactly that misreading,
so the living docs and code comments say **"which models ship"** and the on-disk
cache is the **catalog cache**. ADR-0008 and this record keep "membership" where
it names the concept; `CONTEXT.md` defines it with the disambiguation.
The Deals catalog, reasoning classification, and modalities rules in ADR-0006 /
ADR-0005 / ADR-0004 are unchanged.

## Context

ADR-0008 made the npm package's bundled `models.md` table the **sole membership
authority** for the Snapshot, with the listing API demoted to an annotate-only
divergence note. The premise was that the package was the freshest source and
the API was the laggard — true when the decision was made, and it fixed a real
failure (issue #130: models in `models.md` were dropped because the API lagged).

That premise stopped being true in command-code **1.83.0**, and nothing noticed,
because the refresh stayed green. The CLI now ships a structured embedded model
catalog and fetches a live one at runtime from
`GET /provider/v1/models?view=client`; its own system prompt says the live
catalog _overrides_ `reference/models.md`. `models.md` became a _rendering_ of
the embedded catalog's non-`hidden` rows — accurate data, but frozen at package
build time.

The consequence surfaced on 2026-10-27. `gpt-6.1-terra` and
`moonshotai/Kimi-K3.1-Pro` were live in the catalog and selectable in the CLI,
but absent from `command-code@1.88.0`'s `models.md`, so the plugin withheld
them with no visible error. Worse, the refresh **already fetched the authoritative
list** — `fetchApiModelIds()` returns exactly the same 94-id set as the client
view's selectable rows — used it for one log line, and discarded it. The
plugin preferred a stale file to a fresher answer it was already holding.

Two secondary defects were found in the same audit:

- 22 of 92 context lengths were inflated by the decimal parse (`1.05M` →
  1,050,000 vs the true 1,048,576), over-advertising context by ~1.4k tokens.
- The modalities pipeline scraped a 3.3 MB `dist/cli.mjs` for
  `inputModalities` — data the catalog endpoint returns directly.

## Decision

**Membership comes from the catalog endpoint's client view, and startup reads a
disk cache rather than the network.**

### Membership authority

`GET {apiBase}/provider/v1/models?view=client` is the only source of which models ship.
Every record with `hidden !== true` ships in the Snapshot with its ship-bar
fields (id, name, exact `context_length`, costs, efforts). `hidden: true` is the
catalog's own "do not offer this" marker — the free variants, retired aliases,
and stealth previews — and is excluded from membership while being reported in
the refresh log (never a failure).

The npm registry is still consulted, but only for the `command-code` `latest`
dist-tag: `FACTS_PACKAGE_VERSION` feeds the `x-command-code-version` runtime
header, which the legacy gateway version-gates (ADR-0003), and the
version-pinned provider specifier (ADR-0009). It no longer decides which models ship.

`scripts/parse-facts.mjs` and `scripts/parse-modalities.mjs` are **deleted**
with their tests and the `tests/fixtures/models.md` fixture. Their exported
helpers had no other consumer. The four things they fed were moved, not dropped:

| Was                          | Now                                      |
| ---------------------------- | ---------------------------------------- |
| model list + context + costs | catalog record fields                    |
| efforts (`MODEL_EFFORTS`)    | catalog `reasoningEfforts` (minus `off`) |
| input modalities             | catalog `inputModalities`                |
| `FACTS_PACKAGE_VERSION`      | npm dist-tag (unchanged)                 |

`scripts/parse-catalog.mjs` parses the payload and keeps ADR-0008's parser
discipline: a required field that is missing or wrongly typed is a loud shape
failure naming the model. An **absent** `context_length` or `pricing` block is a
gap, not a failure — it engages the existing #132 enrichment ladders, exactly as
a blank `models.md` cell did.

### The startup tier

The plugin must not fetch on the startup path, because it _cannot_ do so
gracefully: OpenCode awaits the `config` hook before reading `provider.config`,
and `commandcode` is not in models.dev, so the lazy async `provider.models` hook
never fires for us (`src/plugin/models.ts`). A fetch in `config` is therefore a
synchronous startup stall for the length of its timeout.

Membership is layered instead, in precedence order:

1. **Disk cache** — `$XDG_CACHE_HOME/opencode-cmd-provider/models.json` (else
   `~/.cache/...`), written by the previous session's background fetch.
2. **Bundled Snapshot** — `src/catalog/snapshot.ts`, generated pre-release from
   the same endpoint. This is the floor and is always present.
3. _(nothing — never reached)_

Startup reads the cache (≈1 ms), registers, returns; the fetch runs unawaited
and primes the cache for the next start. So the network is never on the startup
path, and a slow, blocked, or captive-portal endpoint costs freshness only.

Three rules make the cached tier safe:

- **Union, never replace.** The id set is `bundled ∪ cached`. A cached row may
  add a model the bundle lacks and may refresh the fields of one it carries, but
  it can never remove a bundled model — so a cache written before a downgrade
  cannot hide a model the running package ships.
- **Any defect is "no cache".** Missing, unreadable, malformed, or wrongly-shaped
  files degrade silently to the bundle. The cache is an accelerator, never a
  dependency; a first run has no cache by definition and must not warn.
- **Failures are invisible.** Network errors, non-OK responses, bad JSON, and
  failed writes resolve to `false` and never surface as plugin errors. A bad
  payload never overwrites a good cache.

`COMMANDCODE_DISABLE_CATALOG_SYNC=1` disables the background fetch, mirroring
the CLI's own `CMD_DISABLE_REMOTE_MODEL_CATALOG`.

### The plain listing endpoint

`GET /provider/v1/models` (the thin shape, no `catalogVersion`, no `pricing`)
stays what issue #130 made it: an annotate-only divergence note. It agrees with
the client view on ids; when it does not, that is a log line, never a gate and
never a fallback. It is not a membership source.

## Verified host behaviour (2026-10-27, opencode 2.1.4)

Two findings from exercising the built plugin in a real v2 host, both of which
shaped the implementation and neither of which a unit test had caught:

- **`config` is a v1-only hook.** A v2 host never calls it, so the background
  refresh must be started from `setup`. Starting it in `config` left the cache
  permanently empty on every v2 install — the plugin worked, but only ever from
  the bundled Snapshot.
- **`opencode models` does not activate plugins.** The one-shot read exits in
  ~60 ms without calling `setup`, so it exercises `config`-path registration
  only and can never demonstrate the cache. `opencode run` and a served instance
  (via `POST /api/plugin/await-activation`) are the paths that do. This is the
  same activation race AGENTS.md records for the v2 e2e script.

A third, design-level correction: the sync must **not** derive its URL from
`COMMANDCODE_API_BASE`. That variable points the _transport_ at a mock or a
compatible proxy, and no such server serves `?view=client` — so reusing it made
every session with a custom transport base silently skip the refresh (a 404 in
~1 ms, indistinguishable from "no cache yet"). The catalog endpoint defaults to
the public catalog and is redirected only by `COMMANDCODE_CATALOG_URL`.

## Consequences

- **A newly launched model ships on the next refresh, not the next package
  release.** This is the bug that motivated the change.
- **The catalog now moves independently of the CLI package**
  (`refreshAfterSeconds: 900` upstream, our cron daily at 06:00 UTC). A refresh
  diff therefore means "the catalog changed since the last refresh," not
  "upstream published a CLI." The 15-minute upstream cadence versus our daily
  one is a deliberate freshness/latency trade, and `FACTS_CATALOG_VERSION`
  records which catalog a snapshot came from so a diff is explainable.
- **`models.md` has no role.** It is not consulted, not a fallback, and not a
  fixture. The bundled Snapshot _is_ the fallback. Keeping `models.md` as a third
  tier would reintroduce exactly the staleness this ADR removes.
- **The plugin writes a file on startup for the first time without user action.**
  `auth-mirror.ts` already wrote (credentials, after `/connect`); this is the
  first _automatic_ write. It follows the same conventions: XDG-aware path,
  recursive `mkdir`, tmp-then-rename atomicity, mode preservation, 0600.
- **Context lengths got more accurate, not just fresher:** 22 rows moved from
  decimal-parsed values to exact ones.
- **Two scripts and ~450 lines of parser + tests are gone**, along with a
  3.3 MB bundle download per refresh.
- **A stale cache is bounded, not sticky:** the background fetch runs every
  start, so a machine that starts OpenCode at all converges on the current
  catalog.
- **`opencode models` and other one-shot CLI reads remain unaffected:** the
  bundled Snapshot always answers, so no read can observe an empty picker.

## Alternatives considered

- **Fetch synchronously in `config` with a short timeout.** Simplest (no cache,
  no file writes), and defensible if capped at ~1.5 s. Rejected because the
  failure mode is a user-visible startup stall on a captive portal, and because
  it makes first-start latency depend on a public endpoint.
- **Read the embedded catalog out of `dist/cli.mjs`.** No new endpoint, keeps
  package-release latency, still gains `hidden`/`aliases`/`zdr`/`minimumPlan`.
  Rejected because it does not fix the motivating bug: Terra would still wait for
  a package release.
- **Keep `models.md` as a third fallback tier.** Rejected: the bundled Snapshot
  is generated from the same catalog, so a third source adds a staleness window
  and a second parser for no coverage gain.
- **Make membership network-only (no bundle).** Rejected outright: offline
  startup and `opencode models` in CI would break, and ADR-0008's core lesson —
  availability must not depend on the freshest source being reachable — still
  holds in the opposite direction.
