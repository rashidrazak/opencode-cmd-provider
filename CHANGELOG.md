## 2.2.2 - 2026-10-06

**Fix — OpenCode can classify provider failures again.** Every error the
transport raises from a non-OK response now surfaces as an AI SDK
`APICallError` carrying the status, the URL, the headers, the full redacted
`responseBody` and the ladder's own `isRetryable` verdict
([#274](https://github.com/rashidrazak/opencode-cmd-provider/pull/274),
closes
[#273](https://github.com/rashidrazak/opencode-cmd-provider/issues/273)).
OpenCode v2 classifies a provider failure from that shape, so fatal
400/401/403/422 responses are no longer replayed (~10 attempts / ~84 s), and
a context-overflow body reaches v1's compaction recovery through the same
fields. The release also lands the catalog refreshed on 2026-10-05 to
`command-code@1.74.1` — no model membership or data change, two Deals
benchmark rows dropped — plus the npm minor/patch dependency group.

### Fixes

- **HTTP failures surface as AI SDK `APICallError`s**
  ([#274](https://github.com/rashidrazak/opencode-cmd-provider/pull/274),
  closes
  [#273](https://github.com/rashidrazak/opencode-cmd-provider/issues/273)):
  OpenCode v2's failure classifier reads `statusCode` / `responseBody` /
  `isRetryable` only off an `APICallError`; every other shape reaches it as
  an unknown failure it treats as retryable, so a fatal 400/401/403/422 was
  replayed up to ~10 times before the session showed anything, and a
  context-overflow body could never trigger compaction. Every error raised
  from a non-OK response — the classified HTTP failure, the version-gate 403
  and the plan-gate flip signal — now surfaces as an `APICallError` that
  carries the status, URL, headers, the full redacted body and the ladder's
  own replay verdict; the internal `failure` classification and the ladder's
  decisions are unchanged. Non-HTTP failures (network, timeout, truncation,
  stream events, pause/resume) stay plain, so v1 keeps leaving truncations
  alone (ADR-0023).

### Documentation

- **ADR-0023** records the host-classifier contract — which errors carry the
  `APICallError` shape, why the body is carried in full, and v1's
  retryable-text cost; `docs/TECHNICAL.md` gains the corresponding note.

### Dependencies

- The npm minor/patch group
  ([#268](https://github.com/rashidrazak/opencode-cmd-provider/pull/268)):
  `@ai-sdk/provider` 4.0.17 → 4.0.20, `@opencode-ai/plugin` 1.18.32 →
  1.18.33, `@secretlint/secretlint-rule-pattern` 13.0.5 → 13.0.6,
  `@types/node` 26.6.2 → 26.6.3, `prettier` 3.9.8 → 3.9.9, `secretlint`
  13.0.5 → 13.0.6.

### Model catalog

- **FACTS_PACKAGE_VERSION**: `1.73.4` → `1.74.1` — the refresh reads the newer
  CLI bundle's `models.md`.
- **FACTS_LAST_REFRESHED**: `2026-10-01` → `2026-10-05`
- No membership or data change: the Snapshot stays at 85 models, and the
  efforts, costs and modalities rows are byte-identical to `1.73.4` — only
  the version/date header moved. The listing-API divergence note is clean.

### Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-10-01` → `2026-10-05` — date-only;
  every entry is unchanged.

### Deals catalog

- **DEAL_LAST_REFRESHED**: `2026-10-01` → `2026-10-05`
- **The Muse Spark contributor rows lose their benchmark**: upstream dropped
  their `intelligenceIndex`, so `meta/muse-spark-1.2-contributor` and
  `meta/muse-spark-1.3-contributor` ship without a benchmark row; tiers and
  allowances are unchanged.

| Model                             | Change    | Before            | After |
| --------------------------------- | --------- | ----------------- | ----- |
| `meta/muse-spark-1.2-contributor` | benchmark | intelligence 39.6 | —     |
| `meta/muse-spark-1.3-contributor` | benchmark | intelligence 48.1 | —     |

## 2.2.1 - 2026-10-02

**Fix — OpenCode v1 starts again with the provider registered.** v2.2.0's v1
`config` hook advertised every model with an input-only `modalities` object,
but OpenCode v1's schema requires `input` and `output` together once the key is
present: a strict host rejected the whole config at `config.get` ("Missing key
at `[...].modalities.output`") and failed the TUI at startup with "1 of 5
requests failed: config.get"
([#262](https://github.com/rashidrazak/opencode-cmd-provider/pull/262), fixes
[#260](https://github.com/rashidrazak/opencode-cmd-provider/issues/260)). The
hook now emits both lists — `output: ["text"]`, matching the v2 half and
Command Code's text-only catalog — and pins the v1 entry's modality shape to
the v1 SDK type, so a dropped list is a typecheck failure instead of a user's
startup. The rest of the release lands the catalog refreshed on 2026-10-01 to
`command-code@1.73.4`: `stealth/pixel-canary`'s package row was retired (the
Snapshot drops it, and its Deals row with it), `stealth/space-bunny-alpha`
gains the `max` effort, and GLM-5.3 Flash's allowance rises to goat $60 /
pro $70.

### Fixes

- **The v1 config hook carries both modality lists**
  ([#262](https://github.com/rashidrazak/opencode-cmd-provider/pull/262),
  closes
  [#260](https://github.com/rashidrazak/opencode-cmd-provider/issues/260)):
  every v1 `config` entry now carries `input` and `output: ["text"]`, the
  shape the v1 schema requires and the v2 half already emits; the entry's
  modality type is pinned to the v1 SDK type, so a missing list fails
  `npm run typecheck`, not a user's TUI startup.

### Model catalog

- **FACTS_PACKAGE_VERSION**: `1.73.0` → `1.73.4` — the refresh reads the newer
  CLI bundle's `models.md`.
- **FACTS_LAST_REFRESHED**: `2026-09-30` → `2026-10-01`
- **The upstream `off` thinking level is normalized out of the efforts
  vocabulary** (ADR-0019): `off` means "do not request effort" and is never an
  advertised variant, so the parser drops it instead of regenerating the
  DeepSeek families' effort lists — the variant cycle and thinking metadata are
  unchanged.

| Model                       | Change  | Before                    | After                  |
| --------------------------- | ------- | ------------------------- | ---------------------- |
| `stealth/pixel-canary`      | removed | Pixel Canary · 262000 ctx | —                      |
| `stealth/space-bunny-alpha` | efforts | low, medium, high         | low, medium, high, max |

### Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-30` → `2026-10-01`

| Model                       | Change         | Before                             | After                                  |
| --------------------------- | -------------- | ---------------------------------- | -------------------------------------- |
| `stealth/pixel-canary`      | retired        | efforts model (low, medium, xhigh) | —                                      |
| `stealth/space-bunny-alpha` | classification | efforts model (low, medium, high)  | efforts model (low, medium, high, max) |

### Deals catalog

- **DEAL_LAST_REFRESHED**: `2026-09-30` → `2026-10-01`
- **GLM-5.3 Flash's allowance rises**: goat 40 → 60, pro 50 → 70.
- **`stealth/pixel-canary` leaves the Snapshot**: its `models.md` row (the
  membership authority) was retired, so the model and its Deals row drop
  together.

| Model                  | Change    | Before            | After             |
| ---------------------- | --------- | ----------------- | ----------------- |
| `stealth/pixel-canary` | removed   | opensource (free) | —                 |
| `z-ai/glm-5.3-flash`   | allowance | goat: 40, pro: 50 | goat: 60, pro: 70 |

## 2.2.0 - 2026-10-01

**Highlight — the sidebar becomes a live Rates & usage panel.** The panel that
rendered the selected model's Deals rows now carries five segments —
Tier/Status, Allowance, Rates, Other Information and live Usage — with every
published rate band shown as a two-line `in | out | cache r | w` block, and the
connected account's usage read from the billing API
([#240](https://github.com/rashidrazak/opencode-cmd-provider/pull/240),
[#247](https://github.com/rashidrazak/opencode-cmd-provider/pull/247)). On v2
the numbers come from the account the session is actually connected with: the
TUI half asks the plugin's own server half over the plugin-RPC bridge and the
key never leaves the server (ADR-0020), so a legacy CLI login or
`COMMANDCODE_API_KEY` beside the connection can no longer show another
account's usage. A `/cmd-rates-usage` dialog — also the command palette's
`Show, hide and reorder sidebar content` — shows, hides and reorders the
segments per machine
([#254](https://github.com/rashidrazak/opencode-cmd-provider/pull/254),
ADR-0022). The usage chain is one parallel wave with field-wise last-good rows:
a cold full snapshot lands in 16.3 s instead of the ~42 s sequential walk, and
a remount paints from a 30-minute session cache
([#252](https://github.com/rashidrazak/opencode-cmd-provider/pull/252)). The
feature and its slice are renamed **Deals intelligence → Rates & usage**
([#256](https://github.com/rashidrazak/opencode-cmd-provider/pull/256)) — the
persisted segment layout and the old `/cmd-deals` command reset once. The rest
of the release lands the catalog refreshed on 2026-09-30 — two new models from
`command-code` 1.73.0, the deals refresh that raises Kimi K3's allowances for
Command Code's one-week boost
([#258](https://github.com/rashidrazak/opencode-cmd-provider/pull/258)) — and
pins the `refresh:deals` output path.

### Features

- **The sidebar panel is segmented, with priced rate bands**
  ([#240](https://github.com/rashidrazak/opencode-cmd-provider/pull/240)):
  `Allowance` renders Go, GOAT, Pro, Max 10×, Max 20× and Team Pro; the legacy
  Pro and Provider rows keep their catalog data — the plan summary and the
  transport still read them — but are never panel rows. `Rates` prints each
  published band (peak/off-peak, context-window tiers) as a
  `Name: in | out | cache r | w` label over its per-million values, with
  `Peak Windows` as its own muted block; a model with no published band falls
  back to the host model cost in the same two-line shape, then `N/A`. `Other
Information` closes the panel with `Deal`, `Was`, `Now`, `Intelligence` and
  `Tok/s`. The panel resolves both the `base`/`muted` and `default`/`subdued`
  theme spellings across the supported v2.0.x line, so its foreground is never
  `undefined` on `@opencode/theme` 2.0.8+.
- **The Usage segment reads live account usage**
  ([#247](https://github.com/rashidrazak/opencode-cmd-provider/pull/247),
  closes
  [#241](https://github.com/rashidrazak/opencode-cmd-provider/issues/241)): a
  four-leg billing chain (whoami → subscriptions → credits → summary), its
  defensive parse and the sidebar rows. The segment mounts with the panel, one
  loader per host half, and makes zero requests without a credential. v1 reads
  the credential its provider record already carries; v2 registers a
  plugin-RPC port (`registerUsageRpc`) whose handler resolves the Host's
  active connection over the same seam `cmd_plan_summary` uses and runs the
  fetch itself, so the key never leaves the server and the panel renders the
  connected account's numbers or the unavailable notice — never another
  account's. Refresh is event-driven: a 5-minute throttle with a coalesced
  trailing refresh, a 30-second local countdown, one confirmation per window
  roll, a 5 → 10 → 20 → 30-minute failure backoff, last-good retention and a
  full teardown on unmount (ADR-0020).
- **Meter bars and the extra-credit balance**
  ([#249](https://github.com/rashidrazak/opencode-cmd-provider/pull/249)):
  each meter is a muted label, a 33-cell bar over the 37-character sidebar
  column (the four-character percentage field reserved), the `used / cap`
  detail and its countdown; bars colour from the host theme's tones (green
  ≤ 40%, yellow ≤ 80%, red above). `credits.purchasedCredits` parses into
  `UsageSnapshot.purchasedCredits` (floored at zero), renders as the summary's
  `Extra Credit` row and counts in `hasUsageData`, so the balance alone keeps
  the segment renderable. The summary sub-section carries tokens in/out,
  requests, spend and the purchased balance.
- **The segments show, hide and reorder per machine**
  ([#254](https://github.com/rashidrazak/opencode-cmd-provider/pull/254),
  closes [#253](https://github.com/rashidrazak/opencode-cmd-provider/issues/253);
  [#255](https://github.com/rashidrazak/opencode-cmd-provider/pull/255)): the
  `/cmd-rates-usage` dialog — the same sentence the palette entry carries,
  `Show, hide and reorder sidebar content` — drives ↑/↓ to move the cursor,
  shift+↑/↓ to move a segment, space/enter to toggle, `r` to restore and esc
  to close; changes apply live and persist per machine (v1 `api.kv`, v2
  `ctx.storage`). Every
  read normalizes — unknown or duplicate ids drop, a segment added later
  appends in default order — so a foreign value cannot crash the panel and a
  new segment cannot vanish. With every segment hidden the whole panel
  disappears; the `Deals unavailable` banner stays pinned only while a catalog
  segment shows (ADR-0022).
- **The feature and slice are renamed Rates & usage**
  ([#256](https://github.com/rashidrazak/opencode-cmd-provider/pull/256)):
  `src/deals/` → `src/rates-usage/`, with the types, the TUI plugin id
  (`commandcode.deals` → `commandcode.rates-usage`), the command id and the
  persisted layout key renamed. `/cmd-rates-usage` replaces `/cmd-deals` with
  no alias, and the layout-key change resets a saved per-machine layout once.
  "Deals" stays where it names the RSC-derived data — the Deals catalog,
  `MODEL_DEALS`, `refresh:deals`, the RSC fixtures and the `Deals unavailable`
  banner.

### Fixes

- **The usage chain is one parallel wave and keeps its last-good rows**
  ([#252](https://github.com/rashidrazak/opencode-cmd-provider/pull/252),
  closes
  [#251](https://github.com/rashidrazak/opencode-cmd-provider/issues/251)):
  measured live, the four legs ran sequentially under a 5-second budget while
  the API answers a leg in 8–18 s, so whoami, subscriptions and the summary
  were dropped on every chain. Credits, subscriptions and the summary now
  start together (whoami beside them on a cold chain) with the cached scope's
  `orgId`/`since` applied when known — the wall clock is the slowest leg, and
  the per-leg budget is 25 s. A speculative whoami-gated cold chain re-runs
  scoped when whoami names an org, keeps the unscoped wave when it says no org
  or fails, and never freezes an empty scope; the fetch merges field-wise with
  the panel's previous snapshot, so a timed-out leg keeps its rows, while
  plan/periodEnd follow the subscription slice (ADR-0011). Each landing leg
  publishes — on v2 one `progress` event over the plugin-RPC port, correlated
  by `callId` — and a session-keyed 30-minute in-memory cache seeds a
  remounting panel. A cold full snapshot measured 16.3 s (partial meters at
  15.3 s) against ~42 s for the CLI's sequential order, cached first paint
  ~79 ms; `cmd_plan_summary`'s lookup budget moves 5 s → 25 s with it.
- **`refresh:deals` writes the renamed catalog path**
  ([#257](https://github.com/rashidrazak/opencode-cmd-provider/pull/257)):
  after the rename, `DEFAULT_OUT` still pointed at `src/deals/catalog.ts`
  while every other caller passes `--out`, so the bare refresh legs (cron,
  release, the refresh skill) wrote a stray file and left the shipped catalog
  stale. The constant is pinned by a regression test.
- **The deals smoke test derives its allowance assertions from the fixture**
  ([#258](https://github.com/rashidrazak/opencode-cmd-provider/pull/258)): the
  test re-typed upstream's Kimi K3 goat/pro allowance numbers, so the first
  legitimate allowance change went red — the spec
  [#108](https://github.com/rashidrazak/opencode-cmd-provider/issues/108)
  value-pin class its own header warns against. The expected numbers now read
  back from the committed pricing-limits fixture, keeping the flow-through
  contract pinned while upstream values stay fluid.

### Documentation

- **ADR-0020** records the v2 usage bridge and why the connected account never
  falls back to the package ladder; **ADR-0022** records the segment layout,
  its persistence and the two host keymap constraints; **ADR-0004** is renamed
  to `0004-rates-usage-slice.md`. `README.md` carries the sidebar instructions
  and `/cmd-rates-usage`, `docs/TECHNICAL.md` the internals, and `CONTEXT.md`
  the new term plus the sidebar layout vocabulary.

### Dependencies

- `brace-expansion` 2.1.4 → 2.1.7 — transitive through `@opentui/solid`
  ([#248](https://github.com/rashidrazak/opencode-cmd-provider/pull/248)).

### Model catalog

## Model catalog

- **FACTS_PACKAGE_VERSION**: `1.69.0` → `1.73.0` — the refresh reads the newer
  CLI bundle's `models.md`; the table below carries what moved.
- **FACTS_LAST_REFRESHED**: `2026-09-29` → `2026-09-30`

| Model                             | Change | Before | After                       |
| --------------------------------- | ------ | ------ | --------------------------- |
| `gpt-6.1-sol`                     | added  | —      | GPT-6.1 Sol · 1050000 ctx   |
| `inclusionai/ling-3.1-flash:free` | added  | —      | Ling 3.1 Flash · 262000 ctx |

### API divergence

- Listing API matches package membership

### Pinned slug map (5)

- `claude-sonnet-5-5`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)
- `deepseek-v4-1-flash-fast`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)
- `gpt-6-1-sol`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)
- `jev`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)
- `ling-3-1-flash-free`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-29` → `2026-09-30`

| Model                             | Change | Before | After                                         |
| --------------------------------- | ------ | ------ | --------------------------------------------- |
| `gpt-6.1-sol`                     | new    | —      | efforts model (low, medium, high, xhigh, max) |
| `inclusionai/ling-3.1-flash:free` | new    | —      | efforts model (low, medium, high)             |

### Deals catalog

## Deals catalog

- **DEAL_LAST_REFRESHED**: `2026-09-29` → `2026-09-30`
- **Upstream shape change**: the docs RSC payload no longer emits
  `outputTokensPerSec` (verified against the live page: 0 occurrences, 87
  benchmark records intact), so every benchmark's `tokPerSec` field drops to
  absent.
- **Kimi K3's allowance boost**: Command Code raised Kimi K3 from
  goat $20 / pro $30 to goat $60 / pro $70 for a one-week boost through
  2026-10-07; the catalog carries the boosted values, and the next refresh
  after the promo picks the revert up.

| Model                                   | Change    | Before                         | After                      |
| --------------------------------------- | --------- | ------------------------------ | -------------------------- |
| `claude-fable-5-1`                      | benchmark | intelligence 53.4, tok/s 66.8  | intelligence 53.4, tok/s — |
| `claude-haiku-4-5-20251001`             | benchmark | intelligence 15.4, tok/s 98.4  | intelligence 15.4, tok/s — |
| `claude-opus-5`                         | benchmark | intelligence 50.8, tok/s 53.7  | intelligence 50.8, tok/s — |
| `claude-sonnet-5`                       | benchmark | intelligence 38.2, tok/s 82.8  | intelligence 38.2, tok/s — |
| `claude-sonnet-5-5`                     | benchmark | —                              | intelligence 56, tok/s —   |
| `deepseek/deepseek-v4-flash-vision-exp` | benchmark | intelligence 34.8, tok/s 228.7 | intelligence 34.8, tok/s — |
| `deepseek/deepseek-v4-pro`              | benchmark | intelligence 36, tok/s 78.6    | intelligence 36, tok/s —   |
| `deepseek/deepseek-v4.1-flash`          | benchmark | intelligence 39.5, tok/s 237.4 | intelligence 39.5, tok/s — |
| `google/gemini-3.5-flash-lite`          | benchmark | intelligence 22.2, tok/s 370   | intelligence 22.2, tok/s — |
| `google/gemini-3.8-flash`               | benchmark | intelligence 40.9, tok/s 342.8 | intelligence 40.9, tok/s — |
| `gpt-5.3-codex`                         | benchmark | intelligence 32.5, tok/s 145.5 | intelligence 32.5, tok/s — |
| `gpt-5.6-luna`                          | benchmark | intelligence 37.3, tok/s 140.7 | intelligence 37.3, tok/s — |
| `gpt-5.6-sol`                           | benchmark | intelligence 47, tok/s 63.8    | intelligence 47, tok/s —   |
| `gpt-5.6-terra`                         | benchmark | intelligence 42.1, tok/s 90.3  | intelligence 42.1, tok/s — |
| `gpt-6-astra`                           | benchmark | intelligence 52.7, tok/s 57.9  | intelligence 52.7, tok/s — |
| `gpt-6-luna`                            | benchmark | intelligence 37.3, tok/s 154.5 | intelligence 37.3, tok/s — |
| `gpt-6-sol`                             | benchmark | intelligence 47.5, tok/s 116.3 | intelligence 47.5, tok/s — |
| `gpt-6.1-sol`                           | added     | —                              | premium                    |
| `inclusionai/ling-3.1-flash:free`       | added     | —                              | opensource (free)          |
| `meta/muse-spark-1.3`                   | benchmark | intelligence 48.1, tok/s 247.5 | intelligence 48.1, tok/s — |
| `meta/muse-spark-1.3-contributor`       | benchmark | intelligence 48.1, tok/s 247.5 | intelligence 48.1, tok/s — |
| `MiniMaxAI/MiniMax-M3`                  | benchmark | intelligence 29.2, tok/s 159.3 | intelligence 29.2, tok/s — |
| `moonshotai/Kimi-K2.7-Code`             | benchmark | intelligence 25.8, tok/s 52.4  | intelligence 25.8, tok/s — |
| `moonshotai/Kimi-K3`                    | benchmark | intelligence 43.6, tok/s 37.7  | intelligence 43.6, tok/s — |
| `moonshotai/Kimi-K3`                    | allowance | goat $20 / pro $30             | goat $60 / pro $70         |
| `nvidia/nemotron-3-ultra-550b-a55b`     | benchmark | intelligence 22.9, tok/s 159.3 | intelligence 22.9, tok/s — |
| `Qwen/Qwen3.7-Plus`                     | benchmark | intelligence 25.2, tok/s 61.9  | intelligence 25.2, tok/s — |
| `Qwen/Qwen3.8-27B`                      | benchmark | intelligence 33.7, tok/s 46.5  | intelligence 33.7, tok/s — |
| `Qwen/Qwen3.8-Max-0902`                 | benchmark | intelligence 45.4, tok/s 41.6  | intelligence 45.4, tok/s — |
| `stepfun/Step-3.7-Flash`                | benchmark | intelligence 19.5, tok/s 196.7 | intelligence 19.5, tok/s — |
| `stepfun/Step-5-Preview`                | benchmark | intelligence 43.7, tok/s 71.1  | intelligence 43.7, tok/s — |
| `tencent/hy3-paid`                      | benchmark | intelligence 25.3, tok/s 92.5  | intelligence 25.3, tok/s — |
| `thinkingmachines/inkling`              | benchmark | intelligence 25, tok/s 109.2   | intelligence 25, tok/s —   |
| `thinkingmachines/inkling-small`        | benchmark | intelligence 27.8, tok/s 230.2 | intelligence 27.8, tok/s — |
| `xai/grok-4.6`                          | benchmark | intelligence 44.3, tok/s 70.3  | intelligence 44.3, tok/s — |
| `xai/grok-4.7`                          | benchmark | intelligence 46.4, tok/s 50.4  | intelligence 46.4, tok/s — |
| `xiaomi/mimo-v2.5`                      | benchmark | intelligence 25.2, tok/s 39.5  | intelligence 25.2, tok/s — |
| `xiaomi/mimo-v2.5-pro`                  | benchmark | intelligence 26, tok/s 50.4    | intelligence 26, tok/s —   |
| `xiaomi/mimo-v2.6-flash`                | benchmark | —                              | intelligence 37.9, tok/s — |
| `xiaomi/mimo-v2.6-pro`                  | benchmark | intelligence 46.3, tok/s 54.5  | intelligence 46.3, tok/s — |
| `z-ai/glm-5.3-flash`                    | benchmark | intelligence 41.8, tok/s 48.8  | intelligence 41.8, tok/s — |
| `zai-org/GLM-5.3`                       | benchmark | intelligence 44.8, tok/s 63.2  | intelligence 44.8, tok/s — |

## 2.1.11 - 2026-09-29

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-28` → `2026-09-29`

| Model                               | Change  | Before                                                | After                                             |
| ----------------------------------- | ------- | ----------------------------------------------------- | ------------------------------------------------- |
| `claude-sonnet-5-5`                 | added   | —                                                     | Claude Sonnet 5.5 · 1000000 ctx                   |
| `deepseek/deepseek-v4.1-flash-fast` | added   | —                                                     | DeepSeek V4.1 Flash Fast · 1000000 ctx            |
| `xai/grok-4.7`                      | pricing | input 1.2 / output 3.6 / cacheRead 0.3 / cacheWrite 0 | input 2 / output 6 / cacheRead 0.5 / cacheWrite 0 |

### API divergence

- Listing API matches package membership

### Pinned slug map (3)

- `claude-sonnet-5-5`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)
- `deepseek-v4-1-flash-fast`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)
- `jev`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-28` → `2026-09-29`

| Model                               | Change | Before | After                                         |
| ----------------------------------- | ------ | ------ | --------------------------------------------- |
| `claude-sonnet-5-5`                 | new    | —      | efforts model (low, medium, high, xhigh, max) |
| `deepseek/deepseek-v4.1-flash-fast` | new    | —      | efforts model (low, high, max)                |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-28` → `2026-09-29`

| Model                               | Change      | Before                                      | After                                      |
| ----------------------------------- | ----------- | ------------------------------------------- | ------------------------------------------ |
| `claude-sonnet-5-5`                 | added       | —                                           | opensource                                 |
| `deepseek/deepseek-v4.1-flash-fast` | added       | —                                           | opensource                                 |
| `xai/grok-4.7`                      | was rates   | in 2 / out 6 / cache 0.5                    | —                                          |
| `xai/grok-4.7`                      | now rates   | in 1.2 / out 3.5999999999999996 / cache 0.3 | —                                          |
| `xai/grok-4.7`                      | discount    | 40% off (ends 2026-09-27)                   | —                                          |
| `xai/grok-4.7`                      | allowance   | goat: 35, pro: 45                           | goat: 20, pro: 30                          |
| `xai/grok-4.7`                      | overContext | —                                           | in 4 / out 12 / cacheRead 1 / cacheWrite 0 |

## 2.1.10 - 2026-09-28

### Models page parser

- Upstream dropped the `Tok/s` column from the models page table: rows (and the header) are now 8 cells, `Caps` moved from index 8 to 7, and the four rate columns each shifted one left.
- `scripts/parse-models-page.mjs` moved to the 8-cell grammar; the committed page fixture was re-captured and the synthetic page fixtures in the parser, ladder, and replay tests were updated.
- `pixel-canary` pinned to `stealth/pixel-canary` (membership-backed page slug — its page evidence is no longer skipped by the pending report).

### API divergence

- Listing API matches package membership

### Pinned slug map (1)

- `jev`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)

## 2.1.9 - 2026-09-26

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-25` → `2026-09-26`

| Model                  | Change | Before | After                     |
| ---------------------- | ------ | ------ | ------------------------- |
| `stealth/pixel-canary` | added  | —      | Pixel Canary · 262000 ctx |

### API divergence

- Listing API matches package membership

### Pinned slug map (2)

- `jev`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)
- `pixel-canary`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-25` → `2026-09-26`

| Model                  | Change | Before | After                              |
| ---------------------- | ------ | ------ | ---------------------------------- |
| `stealth/pixel-canary` | new    | —      | efforts model (low, medium, xhigh) |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-25` → `2026-09-26`

| Model                  | Change | Before | After             |
| ---------------------- | ------ | ------ | ----------------- |
| `stealth/pixel-canary` | added  | —      | opensource (free) |

## 2.1.8 - 2026-09-25

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-24` → `2026-09-25`

| Model                    | Change  | Before                                                 | After                                                   |
| ------------------------ | ------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `stepfun/Step-3.5-Flash` | context | Step 3.5 Flash · 1000000 ctx                           | Step 3.5 Flash · 262000 ctx                             |
| `stepfun/Step-3.5-Flash` | pricing | input 0.1 / output 0.3 / cacheRead 0.02 / cacheWrite 0 | input 0.09 / output 0.3 / cacheRead 0.02 / cacheWrite 0 |

### API divergence

- Listing API matches package membership

### Pinned slug map (1)

- `jev`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-24` → `2026-09-25`

| Model                    | Change    | Before            | After             |
| ------------------------ | --------- | ----------------- | ----------------- |
| `xiaomi/mimo-v2.6-flash` | allowance | goat: 67, pro: 77 | goat: 20, pro: 30 |

## 2.1.7 - 2026-09-24

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-23` → `2026-09-24`

| Model                       | Change | Before | After                           |
| --------------------------- | ------ | ------ | ------------------------------- |
| `stealth/space-bunny-alpha` | added  | —      | Space Bunny Alpha · 1000000 ctx |

### API divergence

- Listing API matches package membership

### Pinned slug map (1)

- `jev`: models-page slug not in the pinned map (docs-ahead; page evidence skipped)

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-23` → `2026-09-24`

| Model                       | Change | Before | After                             |
| --------------------------- | ------ | ------ | --------------------------------- |
| `stealth/space-bunny-alpha` | new    | —      | efforts model (low, medium, high) |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-23` → `2026-09-24`

| Model                                   | Change    | Before                         | After                          |
| --------------------------------------- | --------- | ------------------------------ | ------------------------------ |
| `claude-fable-5`                        | benchmark | intelligence 49.7, tok/s 70    | intelligence 49.6, tok/s —     |
| `claude-fable-5-1`                      | benchmark | intelligence 53.4, tok/s 68.2  | intelligence 53.4, tok/s 66.8  |
| `claude-haiku-4-5-20251001`             | benchmark | intelligence 15.4, tok/s 92.1  | intelligence 15.4, tok/s 98.4  |
| `claude-opus-4-8`                       | benchmark | intelligence 42, tok/s —       | intelligence 41.8, tok/s —     |
| `claude-opus-5`                         | benchmark | intelligence 50.7, tok/s 59.6  | intelligence 50.8, tok/s 53.7  |
| `claude-opus-5-5`                       | benchmark | —                              | intelligence 57.6, tok/s —     |
| `claude-sonnet-4-6`                     | benchmark | intelligence 30.5, tok/s —     | intelligence 30.1, tok/s —     |
| `claude-sonnet-5`                       | benchmark | intelligence 38.4, tok/s 87.5  | intelligence 38.2, tok/s 82.8  |
| `deepseek/deepseek-v4-flash`            | benchmark | intelligence 34.5, tok/s 236.4 | intelligence 34.3, tok/s —     |
| `deepseek/deepseek-v4-flash-vision-exp` | benchmark | intelligence 35, tok/s 228.9   | intelligence 34.8, tok/s 228.7 |
| `deepseek/deepseek-v4-pro`              | benchmark | intelligence 36.3, tok/s 65.3  | intelligence 36, tok/s 78.6    |
| `deepseek/deepseek-v4.1-flash`          | benchmark | intelligence 39.5, tok/s 246.8 | intelligence 39.5, tok/s 237.4 |
| `google/gemini-3.1-flash-lite`          | benchmark | intelligence 16, tok/s —       | intelligence 15.6, tok/s —     |
| `google/gemini-3.5-flash`               | benchmark | intelligence 33, tok/s —       | intelligence 32.6, tok/s —     |
| `google/gemini-3.5-flash-lite`          | benchmark | intelligence 22.7, tok/s 345   | intelligence 22.2, tok/s 370   |
| `google/gemini-3.6-flash`               | benchmark | intelligence 34.3, tok/s 222.3 | intelligence 34, tok/s —       |
| `google/gemini-3.7-flash`               | benchmark | intelligence 39.4, tok/s 330.5 | intelligence 39.1, tok/s —     |
| `google/gemini-3.8-flash`               | benchmark | intelligence 41.2, tok/s 339   | intelligence 40.9, tok/s 342.8 |
| `gpt-5.3-codex`                         | benchmark | intelligence 32.5, tok/s 133.2 | intelligence 32.5, tok/s 145.5 |
| `gpt-5.4-mini`                          | benchmark | intelligence 24.6, tok/s —     | intelligence 24.1, tok/s —     |
| `gpt-5.5`                               | benchmark | intelligence 38.6, tok/s —     | intelligence 38.4, tok/s —     |
| `gpt-5.6-luna`                          | benchmark | intelligence 37.5, tok/s 120.5 | intelligence 37.3, tok/s 140.7 |
| `gpt-5.6-sol`                           | benchmark | intelligence 47.1, tok/s 69.2  | intelligence 47, tok/s 63.8    |
| `gpt-5.6-terra`                         | benchmark | intelligence 42.3, tok/s 115.5 | intelligence 42.1, tok/s 90.3  |
| `gpt-6-astra`                           | benchmark | intelligence 52.8, tok/s 64.2  | intelligence 52.7, tok/s 57.9  |
| `gpt-6-luna`                            | benchmark | —                              | intelligence 37.3, tok/s 154.5 |
| `gpt-6-sol`                             | benchmark | —                              | intelligence 47.5, tok/s 116.3 |
| `meituan/LongCat-2.0`                   | benchmark | intelligence 19.7, tok/s —     | intelligence 19.1, tok/s —     |
| `meta/muse-spark-1.1`                   | benchmark | intelligence 34.3, tok/s —     | intelligence 33.7, tok/s —     |
| `meta/muse-spark-1.2`                   | benchmark | intelligence 39.8, tok/s 241.3 | intelligence 39.6, tok/s —     |
| `meta/muse-spark-1.2-contributor`       | benchmark | intelligence 39.8, tok/s 241.3 | intelligence 39.6, tok/s —     |
| `meta/muse-spark-1.3`                   | benchmark | intelligence 48.2, tok/s 418.4 | intelligence 48.1, tok/s 247.5 |
| `meta/muse-spark-1.3-contributor`       | benchmark | intelligence 48.2, tok/s 418.4 | intelligence 48.1, tok/s 247.5 |
| `MiniMaxAI/MiniMax-M2.7`                | benchmark | intelligence 23.2, tok/s —     | intelligence 22.8, tok/s —     |
| `MiniMaxAI/MiniMax-M3`                  | benchmark | intelligence 29.6, tok/s 117.5 | intelligence 29.2, tok/s 159.3 |
| `moonshotai/Kimi-K2.6`                  | benchmark | intelligence 31.3, tok/s —     | intelligence 27, tok/s —       |
| `moonshotai/Kimi-K2.7-Code`             | benchmark | intelligence 26.3, tok/s 42.5  | intelligence 25.8, tok/s 52.4  |
| `moonshotai/Kimi-K3`                    | benchmark | intelligence 43.8, tok/s 37.2  | intelligence 43.6, tok/s 37.7  |
| `nvidia/nemotron-3-ultra-550b-a55b`     | benchmark | intelligence 23.4, tok/s 183.2 | intelligence 22.9, tok/s 159.3 |
| `Qwen/Qwen3.7-Max`                      | benchmark | intelligence 29.9, tok/s —     | intelligence 29.5, tok/s —     |
| `Qwen/Qwen3.7-Plus`                     | benchmark | intelligence 25.8, tok/s 71.6  | intelligence 25.2, tok/s 61.9  |
| `Qwen/Qwen3.8-27B`                      | benchmark | intelligence 33.9, tok/s 42.7  | intelligence 33.7, tok/s 46.5  |
| `Qwen/Qwen3.8-Max`                      | benchmark | intelligence 40.3, tok/s 41.6  | intelligence 40.2, tok/s —     |
| `Qwen/Qwen3.8-Max-0902`                 | benchmark | —                              | intelligence 45.4, tok/s 41.6  |
| `stealth/space-bunny-alpha`             | added     | —                              | opensource (free)              |
| `stepfun/Step-3.7-Flash`                | benchmark | intelligence 19.5, tok/s 125.7 | intelligence 19.5, tok/s 196.7 |
| `stepfun/Step-5-Preview`                | benchmark | —                              | intelligence 43.7, tok/s 71.1  |
| `tencent/hy3-paid`                      | benchmark | intelligence 25.8, tok/s 88    | intelligence 25.3, tok/s 92.5  |
| `thinkingmachines/inkling`              | benchmark | intelligence 25.5, tok/s 84.1  | intelligence 25, tok/s 109.2   |
| `thinkingmachines/inkling-small`        | benchmark | intelligence 26.1, tok/s 162.1 | intelligence 27.8, tok/s 230.2 |
| `xai/grok-4.5`                          | benchmark | intelligence 39.1, tok/s 58.4  | intelligence 38.8, tok/s —     |
| `xai/grok-4.6`                          | benchmark | intelligence 44.4, tok/s 71.4  | intelligence 44.3, tok/s 70.3  |
| `xai/grok-4.7`                          | benchmark | —                              | intelligence 46.4, tok/s 50.4  |
| `xiaomi/mimo-v2.5`                      | benchmark | intelligence 22.3, tok/s 46.2  | intelligence 25.2, tok/s 39.5  |
| `xiaomi/mimo-v2.5-pro`                  | benchmark | intelligence 26.4, tok/s 43.4  | intelligence 26, tok/s 50.4    |
| `xiaomi/mimo-v2.6-pro`                  | benchmark | —                              | intelligence 46.3, tok/s 54.5  |
| `z-ai/glm-5.3-flash`                    | benchmark | intelligence 41.9, tok/s 113.9 | intelligence 41.8, tok/s 48.8  |
| `zai-org/GLM-5.1`                       | benchmark | intelligence 26.4, tok/s —     | intelligence 26.1, tok/s —     |
| `zai-org/GLM-5.2`                       | benchmark | intelligence 34, tok/s 72.3    | intelligence 33.7, tok/s —     |
| `zai-org/GLM-5.3`                       | benchmark | intelligence 44.9, tok/s 60.3  | intelligence 44.8, tok/s 63.2  |

## 2.1.6 - 2026-09-23

**Highlight — the Deals surfaces stop aging wrong, and a grandfathered Pro
account stops reading as the current one.** Qwen 3.7 Max's launch deal expired
on 2026-06-22, but the sidebar and `cmd_plan_summary` both kept interpolating a
live `50% off until <endsAt>` straight from the catalog; the ended/active
reading is now made once, in `src/deals/format.ts`, so a past date renders
`50% off (ended 2026-06-22)` — the named day itself stays live, because
upstream expires at 23:59:59Z of it
([#226](https://github.com/rashidrazak/opencode-cmd-provider/pull/226)).
Separately, the docs plan table and the CLI credits map were describing two
different Pro SKUs, not disagreeing: `individual-pro` is the pre-reprice plan
kept for grandfathered subscribers and `individual-pro-v1` the current Pro, and
the alias table collapsed both onto the current row — so a legacy account was
rendered the current tier's price, pool and windows. `individual-pro` now
normalizes to a `prolegacy` plan id carrying the archived row, and renders no
per-model allowance table because the docs allowances describe the current tier
([#227](https://github.com/rashidrazak/opencode-cmd-provider/pull/227),
ADR-0011, refs
[#162](https://github.com/rashidrazak/opencode-cmd-provider/issues/162)). The
rest of the release lands the catalog refreshed on 2026-09-23 — three new
models from `command-code` 1.64.0.

### Fixes

- **An expired deal reads as ended on both Deals surfaces**
  ([#226](https://github.com/rashidrazak/opencode-cmd-provider/pull/226)): the
  sidebar and `cmd_plan_summary` share one presentation concern in
  `src/deals/format.ts`; a past ISO `endsAt` renders
  `50% off (ended 2026-06-22)`, the named day stays live, and a non-ISO value
  keeps the historic phrasing. `was`/`now` are untouched — they describe what
  is billed — and the generated catalog stays a verbatim projection of the
  captured fixture (issue
  [#90](https://github.com/rashidrazak/opencode-cmd-provider/issues/90)).
- **A legacy Pro account renders the legacy plan row**
  ([#227](https://github.com/rashidrazak/opencode-cmd-provider/pull/227),
  ADR-0011, refs
  [#162](https://github.com/rashidrazak/opencode-cmd-provider/issues/162)):
  `individual-pro` normalizes to a new `prolegacy` plan id carrying the
  archived $15/mo row ($30 credits, 5h $9 / weekly $18), `individual-pro-v1`
  keeps `pro`, and the pin lists (`cmd_plan_summary` schema,
  `COMMANDCODE_PLAN`, `docs/TECHNICAL.md`) name it. The archived row is
  hand-typed with a provenance comment because its only remaining source is
  the docs table's 2026-08-03 Wayback capture; the generate-or-gate follow-up
  from [#162](https://github.com/rashidrazak/opencode-cmd-provider/issues/162)
  stays open.
- **The models-page parser reads a struck list price in front of Free**
  ([#228](https://github.com/rashidrazak/opencode-cmd-provider/pull/228)): the
  page grew the `<s>$0.042</s>Free` cell shape on 2026-09-22 and
  `parseRateCell` threw on it, taking the live-fetch classification seam down
  with it; the shape now parses as `{ price: 0, crossed }` and the next
  refresh captures the page instead of failing on it. No runtime behavior
  changes.

### Model catalog

## Model catalog

- **FACTS_PACKAGE_VERSION**: `1.62.1` → `1.64.0` — the refresh reads the newer
  CLI bundle's `models.md`; the table below carries what moved.
- **FACTS_LAST_REFRESHED**: `2026-09-22` → `2026-09-23`

| Model             | Change | Before | After                         |
| ----------------- | ------ | ------ | ----------------------------- |
| `claude-opus-5-5` | added  | —      | Claude Opus 5.5 · 1000000 ctx |
| `gpt-6-luna`      | added  | —      | GPT-6 Luna · 1050000 ctx      |
| `gpt-6-sol`       | added  | —      | GPT-6 Sol · 1050000 ctx       |

### API divergence

- Listing API matches package membership

### Pinned slug map (1)

- `jev`: models-page slug not in the pinned map (docs-ahead; page evidence
  skipped)

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-22` → `2026-09-23`

| Model             | Change | Before | After                                         |
| ----------------- | ------ | ------ | --------------------------------------------- |
| `claude-opus-5-5` | new    | —      | efforts model (low, medium, high, xhigh, max) |
| `gpt-6-luna`      | new    | —      | efforts model (low, medium, high, xhigh, max) |
| `gpt-6-sol`       | new    | —      | efforts model (low, medium, high, xhigh, max) |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-22` → `2026-09-23`

| Model             | Change | Before | After      |
| ----------------- | ------ | ------ | ---------- |
| `claude-opus-5-5` | added  | —      | premium    |
| `gpt-6-luna`      | added  | —      | opensource |
| `gpt-6-sol`       | added  | —      | premium    |

## 2.1.5 - 2026-09-22

**Highlight — GLM-5.3 answers stream as one block again, and an effort the
model does not advertise stops being silently dropped.** Command Code's GLM-5.3
attaches a cumulative `usage` object to every chunk of the OpenAI dialect, and
the parser read any usage-bearing chunk as the turn's terminal: each token
closed and reopened the open reasoning or text part, so the Host rendered one
answer one word per line — and a fragmented tool call arrived as a truncated
call per fragment. A usage report is terminal only where OpenAI puts it, on a
trailing chunk with no choices after a `finish_reason`
([#213](https://github.com/rashidrazak/opencode-cmd-provider/pull/213) by
[@unsnow-iac](https://github.com/unsnow-iac), ADR-0018). Separately, a requested
effort outside a model's advertised vocabulary — `high` on Qwen 3.8 Max,
`medium` on GLM-5.3 — was silently dropped, leaving the provider's default in
charge of a request the user had asked to make deeper or shallower; it now snaps
to the nearest advertised level
([#219](https://github.com/rashidrazak/opencode-cmd-provider/pull/219) by
[@unsnow-iac](https://github.com/unsnow-iac), ADR-0019). The rest of the release
lands the catalog refreshed on 2026-09-22 — five new models from `command-code`
1.62.1 — and rounds the deal rates both Deals surfaces render.

### Fixes

- **A usage report is not by itself a terminal on the OpenAI dialect**
  ([#213](https://github.com/rashidrazak/opencode-cmd-provider/pull/213),
  ADR-0018): usage on a chunk that carries choices is a running report; only
  the trailing `choices: []` report is terminal on usage alone, and a chunk
  with choices ends the turn only through a `finish_reason`. The split terminal
  and the finish guards (issues
  [#171](https://github.com/rashidrazak/opencode-cmd-provider/issues/171),
  [#187](https://github.com/rashidrazak/opencode-cmd-provider/issues/187)) are
  unchanged. A stream that never sends `finish_reason` is now a
  `TruncatedStreamError` — retryable while nothing is visible — instead of a
  completed turn synthesized off the first usage report, and the same fix keeps
  a fragmented tool call one call with complete arguments.
- **An out-of-vocabulary reasoning effort snaps to the nearest advertised
  level** ([#219](https://github.com/rashidrazak/opencode-cmd-provider/pull/219),
  ADR-0019): the ladder is
  `off < minimal < low < medium < high < xhigh < max`, ties snap upward, so
  `high` on Qwen 3.8 Max reaches the wire as `xhigh`, `medium` on GLM-5.3 as
  `high`, and `low` on DeepSeek V4 Pro as `high`. `off`, non-ladder strings,
  and reasoning-without-efforts models still send nothing, and the host-visible
  variant cycle is unchanged — the snap is request-path only.
- **`cmd_plan_summary` reads as the plan check, and a pinned plan says so**
  ([#218](https://github.com/rashidrazak/opencode-cmd-provider/pull/218),
  closes [#214](https://github.com/rashidrazak/opencode-cmd-provider/issues/214),
  ADR-0017 amendment): the tool description now opens with the identity use —
  which plan and account the credential is on, and the provenance line that
  names the source — instead of the allowance tables, so an agent asking "what
  plan are we on?" reaches for the tool instead of reading a stale auth file
  (incident 2026-09-19). Passing the `plan` argument is documented as a pin —
  it skips detection and the credential lookup, claims no account, and is for
  comparing plans — and the header now marks it:
  `# Command Code plan: Go (pinned)`. An unrecognized value is not a pin and
  falls back to detection.
- **Discounted deal rates render as money**
  ([#224](https://github.com/rashidrazak/opencode-cmd-provider/pull/224),
  closes [#222](https://github.com/rashidrazak/opencode-cmd-provider/issues/222)):
  upstream computes the discount in JS (`6 × 0.6`) and ships the artifact in
  the RSC, so the sidebar showed `Now: $1.2/$3.5999999999999996 in/out` while
  `grok-4.7`'s 40% launch deal is active. A shared `formatRate` helper — a
  dependency-free leaf in `src/deals/format.ts` — now rounds every rate the
  slice renders, on both hosts and in `cmd_plan_summary`, so the two surfaces
  cannot disagree and the generated catalog stays a verbatim projection of the
  captured fixture.
- **Every Snapshot model resolves to a vendor family**
  ([#220](https://github.com/rashidrazak/opencode-cmd-provider/pull/220)):
  GLM-5.3 Flash and FlashX live under `z-ai/` while the rest of the family uses
  `zai-org/`, and only the latter had an entry, so the two Flash models left
  auto-registration with no `family` metadata; `meituan/` and `inclusionai/`
  were the last two unmapped namespaces. All Snapshot models now map. The
  `vendor.ts` header no longer claims the table cannot go stale — the values
  derive from the id namespace, but the prefix table is hand-maintained.
- **Pinned slug-map drift is a pending report, never a red cron**
  ([#216](https://github.com/rashidrazak/opencode-cmd-provider/pull/216),
  issues [#108](https://github.com/rashidrazak/opencode-cmd-provider/issues/108),
  [#132](https://github.com/rashidrazak/opencode-cmd-provider/issues/132)): the
  daily catalog-refresh went red on 2026-09-19 and 2026-09-20 because upstream
  renamed `meituan/LongCat-2.0:free` → `meituan/LongCat-2.0`; the refresh
  regenerated the catalogs correctly and then a membership assertion died
  before the PR step, every day. `slugMapPinReport` now classifies the three
  drift shapes — stale value, dangling key, docs-ahead page slug — as
  `slug map pending —` lines in the refresh log and the refresh-PR body, and
  the snapshot refresh no longer aborts on an unpinned page slug.
- **The nine unpinned models-page slugs are pinned**
  ([#223](https://github.com/rashidrazak/opencode-cmd-provider/pull/223)):
  each maps to an already-shipped Snapshot id, verified against upstream's own
  slug+id records in the committed RSC fixtures, so the models-page evidence
  rung (Context, rates, Caps, reasoning) covers them. The generated catalogs
  are byte-identical — the page evidence is redundant today — and the pending
  report is clean.

### Documentation

- **ADR-0018** records the usage-is-not-a-terminal rule with the live GLM-5.3
  wire and the failure mode of a stream that never sends `finish_reason`;
  **ADR-0019** records the effort snap, the tie-upward rule, and the CLI-parity
  note; **ADR-0017** carries a dated amendment for the pinned-plan header
  marker. `docs/TECHNICAL.md` gains the terminal rule under "Stream termination
  and retries" and the effort snap under "Reasoning support"; `README.md`
  records the `(pinned)` header.

### Dependencies

- The npm minor/patch group
  ([#217](https://github.com/rashidrazak/opencode-cmd-provider/pull/217)):
  `@ai-sdk/provider` 4.0.14 → 4.0.17, `@opencode-ai/plugin` 1.18.30 → 1.18.31,
  `@types/node` 26.5.1 → 26.6.1, `prettier` 3.9.6 → 3.9.7.

### Model catalog

## Model catalog

- **FACTS_PACKAGE_VERSION**: `1.58.1` → `1.62.1` — the refresh reads the newer
  CLI bundle's `models.md`; the table below carries what moved.
- **FACTS_LAST_REFRESHED**: `2026-09-20` → `2026-09-22`

| Model                             | Change | Before | After                                  |
| --------------------------------- | ------ | ------ | -------------------------------------- |
| `stepfun/Step-5-Preview`          | added  | —      | Step 5 Preview · 1000000 ctx           |
| `xai/grok-4.7`                    | added  | —      | Grok 4.7 · 500000 ctx                  |
| `xiaomi/mimo-v2.6-flash`          | added  | —      | MiMo V2.6 Flash · 1050000 ctx          |
| `xiaomi/mimo-v2.6-pro`            | added  | —      | MiMo V2.6 Pro · 1050000 ctx            |
| `xiaomi/mimo-v2.6-pro-ultraspeed` | added  | —      | MiMo V2.6 Pro UltraSpeed · 1050000 ctx |

### API divergence

- `gpt-6-astra`: in package membership but not served by the listing API

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-20` → `2026-09-22`

| Model                    | Change | Before | After                                    |
| ------------------------ | ------ | ------ | ---------------------------------------- |
| `stepfun/Step-5-Preview` | new    | —      | efforts model (low, medium, high)        |
| `xai/grok-4.7`           | new    | —      | efforts model (low, medium, high, xhigh) |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-20` → `2026-09-22`

| Model                             | Change | Before | After      |
| --------------------------------- | ------ | ------ | ---------- |
| `stepfun/Step-5-Preview`          | added  | —      | opensource |
| `xai/grok-4.7`                    | added  | —      | premium    |
| `xiaomi/mimo-v2.6-flash`          | added  | —      | opensource |
| `xiaomi/mimo-v2.6-pro`            | added  | —      | opensource |
| `xiaomi/mimo-v2.6-pro-ultraspeed` | added  | —      | opensource |

## 2.1.4 - 2026-09-20

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-18` → `2026-09-20`

| Model                      | Change  | Before                    | After                     |
| -------------------------- | ------- | ------------------------- | ------------------------- |
| `meituan/LongCat-2.0`      | added   | —                         | LongCat 2.0 · 1050000 ctx |
| `meituan/LongCat-2.0:free` | removed | LongCat 2.0 · 1050000 ctx | —                         |

### Removed models (1)

- `meituan/LongCat-2.0:free`: LongCat 2.0 · 1050000 ctx — package row removed, pruned from the Snapshot

### API divergence

- `gpt-6-astra`: in package membership but not served by the listing API

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-18` → `2026-09-20`

| Model                      | Change  | Before                    | After                     |
| -------------------------- | ------- | ------------------------- | ------------------------- |
| `meituan/LongCat-2.0`      | new     | —                         | reasoning-without-efforts |
| `meituan/LongCat-2.0:free` | retired | reasoning-without-efforts | —                         |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-18` → `2026-09-20`

| Model                      | Change  | Before            | After      |
| -------------------------- | ------- | ----------------- | ---------- |
| `meituan/LongCat-2.0`      | added   | —                 | opensource |
| `meituan/LongCat-2.0:free` | removed | opensource (free) | —          |

## 2.1.3 - 2026-09-18

**Highlight — `cmd_plan_summary` answers for the account you actually stream
with, and says which one that was.** The tool resolved its credential with
`COMMANDCODE_API_KEY` and the legacy Command Code auth files, which know nothing
about either Host's credential store: on a machine with more than one Command
Code account it answered for whichever account a legacy file happened to hold —
a different plan, a different subscription, and no sign that anything was wrong
([#201](https://github.com/rashidrazak/opencode-cmd-provider/issues/201)). It now
asks the Host first — v2's active connection, v1's provider record — and prints
one provenance line under the plan header naming the account it answered for and
the rung that supplied the credential, so a wrong-account answer is visible
instead of silent (ADR-0015, ADR-0017). The rest of the release replays assistant
reasoning on the OpenAI dialect: a tool-use continuation no longer shows
DeepSeek V4.x, GLM-5.3 or Qwen 3.8 Max their own previous turn with the thinking
erased.

### Features

- **The plan summary renders account identity and credential source**
  ([#205](https://github.com/rashidrazak/opencode-cmd-provider/issues/205),
  ADR-0017): a provenance line now sits under the plan header, naming the
  account and the rung — _Account: `handle` — credential: Host connection_, or
  `COMMANDCODE_API_KEY`, or the legacy file it fell back to
  (`legacy file ~/.commandcode/auth.json`), or the pin that skipped the lookup
  entirely. The account comes from the `whoami` response the plan lookup already makes: the `userName` handle, else a length-capped
  `user.id`, never an email address and never the key. A `whoami` that names no
  account renders the credential alone rather than inventing one, and a pinned
  plan still short-circuits before the credential ladder — no network, no
  identity lookup.

### Fixes

- **`cmd_plan_summary` asks the Host for the credential the session streams
  with**
  ([#201](https://github.com/rashidrazak/opencode-cmd-provider/issues/201),
  [#202](https://github.com/rashidrazak/opencode-cmd-provider/issues/202),
  [#203](https://github.com/rashidrazak/opencode-cmd-provider/issues/203),
  [#204](https://github.com/rashidrazak/opencode-cmd-provider/issues/204); fixed
  in [#206](https://github.com/rashidrazak/opencode-cmd-provider/pull/206)):
  both tool builders take an optional async `hostCredential` getter, consulted
  after an explicit `apiKey` and before `COMMANDCODE_API_KEY` and the legacy
  files. On v2 the getter reads `connection.active("commandcode")` then
  `connection.resolve()` — the value the resolver injects into the provider SDK —
  so the summary follows a `/connect` mid-session; on v1 it reads the provider
  record's resolved credential (`options.apiKey ?? key`) and derives provenance
  by matching the key against the provider's own `env` names. A Host that
  declines or throws falls through to the unchanged ladder, so a session with no
  Host credential still agrees with the transport, and the key itself is never
  rendered.
- **The provenance line resists the data it describes**
  ([#205](https://github.com/rashidrazak/opencode-cmd-provider/issues/205)): the
  legacy-file label is markdown-flattened like the account label, so a store's
  name cannot forge a table row or a line break; an empty `userName` falls back
  to `user.id` instead of starving the label; and an email-shaped `userName` is
  skipped rather than printed.
- **Assistant reasoning is replayed on the OpenAI dialect**
  ([#207](https://github.com/rashidrazak/opencode-cmd-provider/pull/207) by
  [@unsnow-iac](https://github.com/unsnow-iac), ADR-0016): the request codec
  dropped every reasoning part from assistant history, so a tool-use
  continuation showed the model its own previous turn with the thinking erased.
  DeepSeek V4.x requires the full prior `reasoning_content` on a tool-calling
  continuation (HTTP 400 without it), and GLM-5.3 and Qwen 3.8 preserve prior
  thinking for accuracy and cache hits. It now goes back as `reasoning_content`
  on the turn's assistant message — the field the stream parser reads and the
  pause-resume path already sends — gated on `isReasoningModel`, so
  non-reasoning models keep byte-identical requests. The Anthropic dialect is
  unchanged: a replayed thinking block would need a provider signature that
  history parts never carry (ADR-0014).
- **A reasoning turn without tool calls stays schema-valid**
  ([#207](https://github.com/rashidrazak/opencode-cmd-provider/pull/207)): a turn
  whose only tool call was unpaired and filtered out still emitted
  `{ reasoning_content, content: null }` with no `tool_calls`, and
  `content: null` is only valid alongside `tool_calls` — so an interrupted turn
  could 400 a request that previously omitted it. The turn is dropped whole
  again unless it has text to carry; reasoning plus text replays both on a
  string-content message.

### Documentation

- **ADR-0015** records where each Host keeps the credential it streams with, why
  the legacy-file ladder answered for another account, and the four rules that
  travel with the new first rung; **ADR-0017** records the provenance line and
  its email guard; **ADR-0016** records the OpenAI dialect's reasoning replay and
  states why the Anthropic dialect stays out of it. `README.md` says what the
  summary now prints, and `docs/TECHNICAL.md` carries both changes.

### Model catalog

## Model catalog

- **FACTS_PACKAGE_VERSION**: `1.56.0` → `1.56.2` — the refresh reads the newer
  CLI bundle's `models.md`; the table below carries what moved.
- **FACTS_LAST_REFRESHED**: `2026-09-18` → `2026-09-18`

| Model                 | Change | Before | After                        |
| --------------------- | ------ | ------ | ---------------------------- |
| `z-ai/glm-5.3-flashx` | added  | —      | GLM-5.3 FlashX · 1000000 ctx |

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-18` → `2026-09-18`

| Model                 | Change | Before | After                          |
| --------------------- | ------ | ------ | ------------------------------ |
| `z-ai/glm-5.3-flashx` | new    | —      | efforts model (low, high, max) |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-18` → `2026-09-18`

| Model                 | Change | Before | After      |
| --------------------- | ------ | ------ | ---------- |
| `z-ai/glm-5.3-flashx` | added  | —      | opensource |

## 2.1.2 - 2026-09-18

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-17` → `2026-09-18`

| Model                     | Change | Before | After                             |
| ------------------------- | ------ | ------ | --------------------------------- |
| `Qwen/Qwen3.8-Omni-Flash` | added  | —      | Qwen 3.8 Omni Flash · 1000000 ctx |

### API divergence

- `gpt-6-astra`: in package membership but not served by the listing API

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-17` → `2026-09-18`

| Model                     | Change | Before | After                              |
| ------------------------- | ------ | ------ | ---------------------------------- |
| `Qwen/Qwen3.8-Omni-Flash` | new    | —      | efforts model (low, medium, xhigh) |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-17` → `2026-09-18`

| Model                     | Change | Before | After      |
| ------------------------- | ------ | ------ | ---------- |
| `Qwen/Qwen3.8-Omni-Flash` | added  | —      | opensource |

## 2.1.1 - 2026-09-17

**Highlight — v2 installs load again.** OpenCode 2.0.4 replaced the v2 plugin
context's `catalog` transform with the separate `provider` and `model`
transforms, so the plugin died at load on 2.0.4 with
`TypeError: undefined is not an object (evaluating 'ctx.catalog.transform')`:
no provider, no models, no `/connect`. Reported in
[#181](https://github.com/rashidrazak/opencode-cmd-provider/issues/181) by
[@gmag11](https://github.com/gmag11) and fixed in
[#182](https://github.com/rashidrazak/opencode-cmd-provider/pull/182) by
[@thecountrox](https://github.com/thecountrox), who re-derived the context from
`@opencode/plugin@2.0.5` and moved auto-registration onto
`ctx.provider.transform` and `ctx.model.transform`. Thanks to both.

The rest of the release completes the pause-resume parity sweep in
[#184](https://github.com/rashidrazak/opencode-cmd-provider/issues/184) and
[#191](https://github.com/rashidrazak/opencode-cmd-provider/issues/191): a
paused Provider API turn now resumes with the whole assistant turn the provider
paused on — text, tool calls and reasoning — instead of re-sending the prompt
without it, a pause carrying a block this build cannot represent fails loudly
rather than continuing a turn that never contained the block, and the finish
vocabulary is complete, so a stop reason the wire can actually send no longer
ends the turn as an error.

### Compatibility

- **OpenCode 2.0.4 or newer is required on the v2 host.** The v2 half
  registers through the `provider` and `model` transforms introduced in 2.0.4
  (see the highlight above); 2.0.3 and below expose the older `catalog`
  transform instead, so the v2 half cannot load there and neither can the fixes
  in this release that ride on it. OpenCode v1 (1.18.x) is unaffected.

### Features

- **Anthropic redacted thinking streams as a reasoning part**
  ([#193](https://github.com/rashidrazak/opencode-cmd-provider/issues/193)):
  the parser dropped `redacted_thinking` as an unmodelled block, so a paused
  turn's continuation could not see it. It now streams as a reasoning part
  carrying no text, with its encrypted payload on the start part in
  `providerMetadata.anthropic.redactedData` — the shape the AI SDK's own
  Anthropic provider emits — and closes with a matching end on the stop event
  and on `closeStream()`.

### Fixes

- **v2 auto-registration runs the transforms the 2.0.4 host exposes**
  ([#182](https://github.com/rashidrazak/opencode-cmd-provider/pull/182) by
  [@thecountrox](https://github.com/thecountrox), reported in
  [#181](https://github.com/rashidrazak/opencode-cmd-provider/issues/181)):
  `setup()` called `ctx.catalog.transform`, which OpenCode 2.0.4 no longer
  exposes, so the plugin died at load before registering anything — no
  provider, no models, no `/connect`. Registration now runs as a
  `ctx.provider.transform` pass (provider gap-fill, Snapshot source models,
  deals enrichment), with the first-run default in a `ctx.model.transform`
  pass: the same three capabilities, carried by the API the host actually has.
  The integration, tool and `aisdk` hook paths are unchanged, as is the v1
  `server()` half.
- **v2 Deals enrichment gap-fills the vendor family for every model**
  ([#182](https://github.com/rashidrazak/opencode-cmd-provider/pull/182)): the
  `family` fill had landed inside the branch that only runs for models with a
  Deals entry, so v2 would have dropped the vendor family on a model with no
  Deals record (the [#132](https://github.com/rashidrazak/opencode-cmd-provider/issues/132)
  pending state, or an empty catalog) while v1 kept it. The fill now decides
  before the branch and applies in whichever update runs; a declared `family`
  is still never overwritten.
- **A paused turn is continued with the paused assistant turn**
  ([#188](https://github.com/rashidrazak/opencode-cmd-provider/issues/188)):
  the Provider API resumes a pause by re-sending the request with the paused
  assistant turn appended, and the transport now does that. The parts the
  paused response emitted become the dialect's assistant message (text content
  for OpenAI, a text block for Anthropic) rather than the turn being replayed
  from the prompt alone. The legacy transport is untouched and still re-POSTs
  the same body byte for byte.
- **The continuation carries tool calls and reasoning, not just text**
  ([#189](https://github.com/rashidrazak/opencode-cmd-provider/issues/189)):
  tool calls resume with their ids, names and arguments, so the tool results
  the host sends next line up with the ids the resumed request carried, and
  Anthropic thinking blocks resume with the signature they were streamed with
  — captured from the `signature_delta` event and carried on the block's
  `reasoning-end` part in `providerMetadata.anthropic.signature`. The shapes
  that still cannot be represented are refused by name: unsigned thinking, a
  tool call with no id or name, arguments that are not JSON, and any part the
  builder does not model.
- **A pause that reported no usage is continued, not failed**
  ([#190](https://github.com/rashidrazak/opencode-cmd-provider/issues/190)):
  a paused response whose finish never carried usage was killed as a truncated
  stream before the pause rule ran. The [#171](https://github.com/rashidrazak/opencode-cmd-provider/issues/171)
  truncation rule is about a turn that _ended_, and a pause has not ended, so
  it is continued; the unpriced segment contributes nothing to the reported sum
  rather than counting as zero. A non-pause finish with no usage still fails and
  replays as before.
- **A turn paused twice carries every segment**
  ([#191](https://github.com/rashidrazak/opencode-cmd-provider/issues/191)):
  the continuation request is rebuilt from the prompt, so a second continuation
  dropped the first segment the consumer had already read. The transport now
  accumulates every part the turn has emitted and hands the whole turn to the
  request builder, so a twice-paused turn continues as one assistant message. A
  replay still cannot double-count: it only follows an attempt that emitted
  nothing.
- **A pause carrying a block this build cannot carry is refused**
  ([#192](https://github.com/rashidrazak/opencode-cmd-provider/issues/192)):
  the continuation is rebuilt from the parts the response emitted, so a block
  the parser never modelled was invisible to it and continuing resumed a turn
  that never contained the block. The Anthropic parser now reports the
  content-block types it does not model, and such a pause fails with a
  `resume-unsupported` error naming the type before any continuation request is
  sent. A turn that merely _ends_ with the same block is untouched.
- **A paused turn's redacted thinking is resumed verbatim**
  ([#194](https://github.com/rashidrazak/opencode-cmd-provider/issues/194)): the
  resume builder reads `anthropic.signature` and `anthropic.redactedData` off
  the reasoning parts — both are read wherever they appear, since the AI SDK's
  Anthropic provider puts the payload on the block's start while this transport
  puts a signature on its end — and a redacted block goes back as
  `{ type: "redacted_thinking", data }`, in stream order. The OpenAI dialect has
  no field for an encrypted payload, so it refuses one instead of resuming
  without it.
- **Every paused segment's reasoning blocks stay apart**: blocks were keyed by
  part id and every response names its blocks from the same counters, so a turn
  paused twice collided on `redacted-0` / `thinking-0` and the later payload or
  signature overwrote the earlier one. Blocks are now delimited by their start
  and end parts, so a reused id opens a new block — both payloads, both
  signatures and the stream order survive. Text blocks close the same way,
  which also stops text merging across whatever streamed between two of them.
  A redacted block with no payload is no longer marked as modelled (it has
  nothing to replay, so it falls through to the refusal above), and a block
  whose start carried no type is reported as `untyped` rather than inventing
  the name `unknown`.
- **Every stop reason the wire can send is mapped**
  ([#186](https://github.com/rashidrazak/opencode-cmd-provider/issues/186)): a
  turn ending with a reason the mapper did not know was reported to the host as
  `unified: "other"`, which v2 coerces to `unknown` and fails as a retryable
  incomplete stream. The mapper now knows the vocabulary the wire produces,
  matched case-insensitively the way upstream's normaliser matches: the OpenAI
  spellings (`tool_calls`, `content_filter`), the length family (including
  `model_context_window_exceeded`), Anthropic's `refusal`, and `function_call` /
  `max_turn_requests` / `cancelled`. Anything unrecognised completes the turn,
  as upstream does, so `other` is no longer reachable for a turn that ended.
  `refusal` and `content_filter` complete the turn too rather than mapping to
  the AI SDK's `content-filter`: the model's refusal is the answer the user is
  meant to read (ADR-0013).
- **The legacy finish-event guards are mirrored**
  ([#187](https://github.com/rashidrazak/opencode-cmd-provider/issues/187)): two
  guards upstream's legacy consume loop carries were missing here, both about
  the terminal's two reason fields. A finish reporting `other` with no raw
  reason is upstream's truncation condition, so it is raised as a classified,
  retryable truncation instead of being completed, and a reason matching
  `network` / `connection` / `upstream` + `error` (any separator or case) is a
  connection that died mid-stream, so it surfaces as a retryable transport
  failure naming the reason. `other` **with** a raw reason is still an ending.
  Both replay only while the consumer has seen nothing, and surface as the error
  part after the budget instead of failing v2 as an unknown finish reason.

### Model catalog

- **FACTS_PACKAGE_VERSION**: `1.54.1` → `1.55.0` — upstream shipped `1.54.2` and
  `1.55.0` after 2.1.0, and both carry an unchanged `models.md` table and
  modality table, so the Snapshot is identical: 70 models, 44 efforts, 70 costs,
  50 modalities. Only the pinned package and its source URLs move.

## 2.1.0 - 2026-09-16

Feature: Claude turns through the Provider API reuse a cached system prefix, and
a paused turn now continues instead of ending the response. The rest is parity
and repair work against `command-code@1.54.0`
([#169](https://github.com/rashidrazak/opencode-cmd-provider/issues/169)): the
stream lifecycle, the retry ladder, the plan-gate fallback, and the legacy wire
format now behave the way the live provider does.

### Features

- **Claude prompt caching on the Provider API path**
  ([#177](https://github.com/rashidrazak/opencode-cmd-provider/issues/177)):
  `/provider/v1/messages` sent the system prompt as a flat string and never a
  cache breakpoint, so every turn re-billed the whole prefix as fresh input.
  `buildAnthropicBody` now emits one ephemeral `cache_control` breakpoint on the
  `system` prefix, mirroring the official CLI's `toWireSystem()`. Measured live
  on a ~7k-token prefix: a cold turn wrote 7142 tokens and a byte-identical warm
  turn read them back for 13 fresh tokens (~99.8% reuse). The legacy
  `/alpha/generate` body is untouched, and conversation-history caching stays
  out of scope.
- **`pause_turn` continues the turn instead of reporting it finished**
  ([#172](https://github.com/rashidrazak/opencode-cmd-provider/issues/172)): a
  paused response passed through as an unknown `other` reason, so v1 called the
  turn completed and v2 rejected it as a retryable incomplete stream. The
  transport now detects the pause on the finish part, re-POSTs the same body
  (bounded at five continuations), appends the continuation's parts to the same
  stream, folds its usage with `addAiSdkUsage`, and never emits the pause itself.

### Fixes

- **A truncated stream fails instead of fabricating a finish**
  ([#170](https://github.com/rashidrazak/opencode-cmd-provider/issues/170)): a
  body that closed cleanly with no terminal event was reported as a successful
  `stop` with zeroed usage, so a proxy or CDN truncation looked like a complete
  answer. The read loop now raises `TruncatedStreamError` (upstream's wording,
  502 attached, distinguishable `name`), and the synthetic finish is gone: open
  parts close and the stream ends with the redacted error part.
- **Failures are classified before retrying, with a short ladder on by default**
  ([#171](https://github.com/rashidrazak/opencode-cmd-provider/issues/171)): the
  transport did zero retries unless `maxRetries` was set, and then replayed every
  failure it could reach — 400/401/403/404/422 included — while never replaying
  the failure the server itself flags as retryable. Only transient kinds are
  replayed now (network failures, 408/429/5xx, and the server's own retryable
  error events); permanent answers, version gates, and a turn that already
  streamed text are not. A `Retry-After` above the cap no longer replays the cap
  error it just raised.
- **The Provider API plan-gate 403 flips to the legacy transport again**
  ([#175](https://github.com/rashidrazak/opencode-cmd-provider/issues/175),
  restoring the [#56](https://github.com/rashidrazak/opencode-cmd-provider/issues/56)
  safety net): the
  live gate answers the Anthropic `permission_error` envelope with no
  `error.code`, which none of the three hardcoded literals matched, so a Go-plan
  Claude request surfaced a single error part instead of reaching the on-demand
  credits the legacy path serves. The matcher reads the plan phrasing when the
  code is absent, and checks the version gate first so a version 403 is never
  misread as a plan flip.
- **Anthropic usage is mapped cache-exclusive**
  ([#178](https://github.com/rashidrazak/opencode-cmd-provider/issues/178)):
  Anthropic reports `input_tokens` excluding the cached prefix, so the shared
  cache-inclusive arithmetic — the OpenAI-side shape fixed in
  [#158](https://github.com/rashidrazak/opencode-cmd-provider/issues/158) —
  turned a 7155-token cached Claude prompt into
  `total 13, noCache 0` — a prompt 550× smaller than the real one, and the wrong
  cost with it. Each provider now pins its own mapper: the OpenAI shape stays
  cache-inclusive, Anthropic becomes cache-exclusive.
- **The bare `message_stop` no longer zeroes every Claude turn**
  ([#174](https://github.com/rashidrazak/opencode-cmd-provider/issues/174)): the Provider
  API sends usage and the real `stop_reason` on `message_delta` and then closes
  with a bare `message_stop`, which the parser mapped to a second, zeroed finish
  — so every Claude turn reported `{total: 0}` and `$0` cost, and a real
  `max_tokens` stop was masked as `stop`.
- **Reasoning parts keep the id they opened with**
  ([#71](https://github.com/rashidrazak/opencode-cmd-provider/issues/71)): the
  Anthropic parser re-derived the part id from the block index for deltas and
  stops, so a gateway that labels its thinking blocks left a reasoning part
  unfilled and sent deltas for a part it never opened — the `reasoning part <id>
not found` failure from
  [#69](https://github.com/rashidrazak/opencode-cmd-provider/issues/69). Block
  state now carries the chosen id, so start, delta and stop agree.
- **Every part a stream opened is closed**
  ([#72](https://github.com/rashidrazak/opencode-cmd-provider/issues/72)): a
  stream that failed mid-generation — an error event, an abort, a body that
  stopped early, a read error that survived the retry budget — left a
  `reasoning-start` or `text-start` with no matching end. Parsers expose an
  idempotent `closeStream()`, which the transport calls before the error part on
  mapper errors, aborts and read failures.
- **The legacy wire format tracks the shipped CLI**
  ([#173](https://github.com/rashidrazak/opencode-cmd-provider/issues/173)): the
  legacy request carried a version header frozen at `1.15.1`, an inert
  `x-co-flag`, and a forced `temperature: 0.3` that ignored the host's own knob.
  The reported version is now `FACTS_PACKAGE_VERSION` — the command-code build
  the Snapshot was refreshed from, `1.54.0`, comfortably above the `0.18.10`
  floor the gate last recorded — the host's `temperature` is forwarded on every
  transport, and a version-gate 403 stays fatal with a message that names
  `opencode-cmd-provider` and quotes the server's minimum.
- **`/connect` waits for you, and offers a pasted key**
  ([#145](https://github.com/rashidrazak/opencode-cmd-provider/issues/145),
  ADR-0012): the browser flow capped its callback at 15 seconds and closed the
  callback server on expiry, so any sign-in slower than that — page load, login,
  org pick, approve, transfer — posted the key to a closed port. The budget is
  five minutes now (under OpenChamber's own 15-minute budget for the route), the
  timer is cleared on both exits so a successful login no longer holds the event
  loop open, and a **Command Code API key** method joins the provider list for
  hosts where the browser cannot reach OpenCode's loopback callback at all.

### Dependencies

- The npm minor/patch group (8 updates,
  [#157](https://github.com/rashidrazak/opencode-cmd-provider/pull/157)) and the
  GitHub Actions group
  ([#156](https://github.com/rashidrazak/opencode-cmd-provider/pull/156)) are
  current.
- `solid-js` and `zod` are held at the exact versions upstream pins (`1.9.12`,
  `4.1.8`), with `tests/dependency-pins.test.ts` gating drift.

### Chores

- The dead local cost calculation is gone
  ([#176](https://github.com/rashidrazak/opencode-cmd-provider/issues/176)):
  `calculateCommandCodeCost` and the internal `src/provider/cost.ts` module were
  never read — displayed cost comes from the advertised rates plus the usage the
  transport forwards, so the pass was dead arithmetic. No public surface
  changes: `cost.ts` was never reachable through the package's exports map.

## 2.0.0 - 2026-09-15

### Compatibility

- **OpenCode v1 and v2 are both fully supported.** One install serves either
  line: auto-registration of `provider.commandcode` and every model, the
  credential (browser `/connect` on v1; `COMMANDCODE_API_KEY` or a pasted key on
  v2), the `cmd_plan_summary` tool, and provider streaming. This release closes
  the last gap — the `Command Code` sidebar on v2 — so both lines now show the
  same session panel (see Deals intelligence below).

### Fixes

- **`cmd_plan_summary` no longer reports the wrong plan.** `GET /alpha/whoami`
  stopped returning `planId`/`plan`, so plan resolution always fell through to
  its default and every account was shown Go's credits, windows and deal table
  regardless of what it had purchased
  ([#159](https://github.com/rashidrazak/opencode-cmd-provider/issues/159)).
  Plan identity now comes from the billing endpoints the official CLI uses —
  `GET /alpha/billing/subscriptions`, org-scoped via the whoami org id and
  status-gated to `active`/`trialing`/`past_due`, with `credits.planId` as
  fallback — and an unresolved plan renders `# Command Code plan: unknown` with
  the override instructions instead of a guess, because a wrong answer presented
  as a detected fact is worse than no answer. Transport selection no longer
  consults the network at all: it reads an explicit pin only (per-call
  `providerOptions.plan` → the model's `plan` option → `COMMANDCODE_PLAN`), so
  no request is made to route (ADR-0011).
- **Cache reads are read from the OpenAI nested usage detail.**
  `extractUsageTokens` read only top-level cache fields
  (`cache_read_input_tokens`, `cacheReadTokens`, `cacheRead`), so every
  OpenAI-shape model served by `/provider/v1/chat/completions` reported
  `cacheRead: 0` even when upstream reported a prefix-cache hit in
  `usage.prompt_tokens_details.cached_tokens`. `usageToAiSdk` then derived
  `noCache` from the cache-inclusive prompt total, billing the whole prompt as
  fresh input — a 52000-input / 50000-cached turn was reported at 5.8×–12.7× the
  true cost on the shipped rates, and the displayed cache-hit rate read 0% on
  sessions that were ~96% cache reads
  ([#158](https://github.com/rashidrazak/opencode-cmd-provider/issues/158)). The
  `cacheRead` chain now also covers the DeepSeek top-level alias
  (`prompt_cache_hit_tokens`), with the explicit top-level fields still ahead of
  both, so existing precedence is unchanged.

### Deals intelligence

- **The `Command Code` sidebar is back on OpenCode v2.** `dist/tui.js` only
  implemented the v1 TUI contract (`{ id, tui(api) }` with the snake_case
  `sidebar_content` slot), and the v2 TUI host rejects any plugin module whose
  default export lacks `setup()` ("Invalid V2 TUI plugin module"). v2 loaded the
  module and dropped it, so the sidebar silently disappeared while v1 kept
  working and no test noticed. The default export now carries both halves
  (ADR-0010): v1 registers `sidebar_content` off `options.cmd`, v2 claims the
  dot-separated `"sidebar.content"` path with `ui.slot` and reads the same Deals
  payload from `settings.cmd`. `src/plugin/v2-tui-types.ts` mirrors the v2 TUI
  context, and `tests/tui-deals-panel.test.ts` plus `tests/contract.test.ts` pin
  both contracts against the built bundle.
- **Deals catalog refresh — 2026-09-15.** Upstream re-scaled its intelligence
  index: 59 of 70 models moved, all downward (mean −5.4, range −1.9 to −8.1),
  while the coding index held steady (68 of 70 unchanged). Model membership,
  pricing, tiers and the GOAT/Pro allowances are unchanged, so only the
  sidebar's `Intelligence` and `Tok/s` rows move.

### Documentation

- **`README.md` is now a first-time-user guide**: what the plugin does, which
  OpenCode version you are on, separate install sections for v1 and v2, how to
  connect, how to use it, updating, uninstalling, and troubleshooting — with no
  implementation detail. Everything technical moved to
  [`docs/TECHNICAL.md`](docs/TECHNICAL.md): host/entry-point contracts, install
  mechanics and caching, generated catalogs and the refresh pipeline, Deals
  intelligence internals, environment overrides, development and the e2e gates,
  maintainer troubleshooting, and the ADR index.

## 1.7.6 - 2026-09-14

### Compatibility

- **OpenCode v2 support.** The plugin's default export now carries both host
  halves — `server()` for v1 and `setup(context)` for v2 — so a v2 install gets
  provider auto-registration, all Snapshot models, the credential methods, and
  `cmd_plan_summary`. Noted after the fact: this shipped in 1.7.6 without a
  release note, and the TUI sidebar followed in the next release.

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-11` → `2026-09-14`

| Model                                   | Change      | Before                                                                                                                                               | After                                                                                                                                             |
| --------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepseek/deepseek-v4-flash-vision-exp` | peakOffPeak | peak in 0.44 / out 1.32 / cacheRead 0.014 / cacheWrite 0 · off-peak in 0.22 / out 0.66 / cacheRead 0.007 / cacheWrite 0 (01–04 & 06–10 UTC, Mon–Fri) | peak in 0.3 / out 1.2 / cacheRead 0.006 / cacheWrite 0 · off-peak in 0.15 / out 0.6 / cacheRead 0.003 / cacheWrite 0 (01–04 & 06–10 UTC, Mon–Fri) |

## 1.7.5 - 2026-09-12

Fix: the runtime provider is pinned to the plugin's own version
([#152](https://github.com/rashidrazak/opencode-cmd-provider/issues/152),
reported in [#149](https://github.com/rashidrazak/opencode-cmd-provider/issues/149)).

- `provider.commandcode.npm` is now registered as
  `opencode-cmd-provider@<version>` — the exact version of the installed
  plugin — instead of the bare package name. OpenCode's package cache is keyed
  by the exact specifier and never refreshed, so the bare name let the runtime
  provider sit at a different release than the plugin that registered it.
- A user-declared `provider.commandcode.npm` still wins, and a plugin that
  cannot read its own `package.json` falls back to the bare name rather than
  failing to load.
- Updating still requires clearing the package cache (see the README):
  OpenCode never refreshes an existing install, and this change does not
  address that (upstream:
  [anomalyco/opencode#48514](https://github.com/anomalyco/opencode/issues/48514)).

## 1.7.4 - 2026-09-11

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-10` → `2026-09-11`

| Model                                   | Change  | Before                                                    | After                                                    |
| --------------------------------------- | ------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `deepseek/deepseek-v4-flash-vision-exp` | pricing | input 0.22 / output 0.66 / cacheRead 0.007 / cacheWrite 0 | input 0.15 / output 0.6 / cacheRead 0.003 / cacheWrite 0 |

### API divergence

- `gpt-6-astra`: in package membership but not served by the listing API

## 1.7.3 - 2026-09-10

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-09` → `2026-09-10`

| Model                          | Change  | Before                                                    | After                                                    |
| ------------------------------ | ------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `deepseek/deepseek-v4-flash`   | pricing | input 0.22 / output 0.66 / cacheRead 0.007 / cacheWrite 0 | input 0.15 / output 0.6 / cacheRead 0.003 / cacheWrite 0 |
| `deepseek/deepseek-v4.1-flash` | added   | —                                                         | DeepSeek V4.1 Flash · 1000000 ctx                        |

### API divergence

- `gpt-6-astra`: in package membership but not served by the listing API

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-09` → `2026-09-10`

| Model                          | Change | Before | After                          |
| ------------------------------ | ------ | ------ | ------------------------------ |
| `deepseek/deepseek-v4.1-flash` | new    | —      | efforts model (low, high, max) |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-09` → `2026-09-10`

| Model                          | Change      | Before                                                                                                                                               | After                                                                                                                                             |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepseek/deepseek-v4-flash`   | peakOffPeak | peak in 0.44 / out 1.32 / cacheRead 0.014 / cacheWrite 0 · off-peak in 0.22 / out 0.66 / cacheRead 0.007 / cacheWrite 0 (01–04 & 06–10 UTC, Mon–Fri) | peak in 0.3 / out 1.2 / cacheRead 0.006 / cacheWrite 0 · off-peak in 0.15 / out 0.6 / cacheRead 0.003 / cacheWrite 0 (01–04 & 06–10 UTC, Mon–Fri) |
| `deepseek/deepseek-v4.1-flash` | added       | —                                                                                                                                                    | opensource                                                                                                                                        |

## 1.7.2 - 2026-09-09

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-08` → `2026-09-09`

| Model                                   | Change  | Before | After                             |
| --------------------------------------- | ------- | ------ | --------------------------------- |
| `inclusionai/ling-3.0-flash-sante:free` | added   | —      | Ling 3.0 Flash Sante · 262000 ctx |
| `MiniMaxAI/MiniMax-M3`                  | efforts | —      | low, medium, high                 |

### API divergence

- `gpt-6-astra`: in package membership but not served by the listing API

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-08` → `2026-09-09`

| Model                                   | Change         | Before                    | After                             |
| --------------------------------------- | -------------- | ------------------------- | --------------------------------- |
| `inclusionai/ling-3.0-flash-sante:free` | new            | —                         | reasoning-without-efforts         |
| `MiniMaxAI/MiniMax-M3`                  | classification | reasoning-without-efforts | efforts model (low, medium, high) |

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-08` → `2026-09-09`

| Model                                   | Change    | Before                         | After                          |
| --------------------------------------- | --------- | ------------------------------ | ------------------------------ |
| `claude-fable-5`                        | benchmark | intelligence 62.1, tok/s 67.8  | intelligence 53.2, tok/s 62.2  |
| `claude-fable-5-1`                      | benchmark | —                              | intelligence 56.8, tok/s 67.6  |
| `claude-haiku-4-5-20251001`             | benchmark | intelligence 24.1, tok/s 103.9 | intelligence 17.4, tok/s 91.3  |
| `claude-opus-4-7`                       | benchmark | intelligence 55, tok/s —       | intelligence 44.3, tok/s —     |
| `claude-opus-4-8`                       | benchmark | intelligence 57.3, tok/s —     | intelligence 47.8, tok/s —     |
| `claude-opus-5`                         | benchmark | intelligence 63.1, tok/s 55.5  | intelligence 54.1, tok/s 51.6  |
| `claude-sonnet-4-6`                     | benchmark | intelligence 48.4, tok/s —     | intelligence 38.5, tok/s —     |
| `claude-sonnet-5`                       | benchmark | intelligence 55.3, tok/s 89.6  | intelligence 45.1, tok/s 80    |
| `deepseek/deepseek-v4-flash`            | benchmark | intelligence 51.8, tok/s 129   | intelligence 40.8, tok/s 117.7 |
| `deepseek/deepseek-v4-flash-vision-exp` | benchmark | —                              | intelligence 40.7, tok/s 119.5 |
| `deepseek/deepseek-v4-pro`              | benchmark | intelligence 53.2, tok/s 61    | intelligence 42.1, tok/s 62.1  |
| `google/gemini-3.1-flash-lite`          | benchmark | intelligence 25.6, tok/s —     | intelligence 19.3, tok/s —     |
| `google/gemini-3.5-flash`               | benchmark | intelligence 52, tok/s —       | intelligence 39.7, tok/s —     |
| `google/gemini-3.5-flash-lite`          | benchmark | intelligence 37.4, tok/s 368.8 | intelligence 27.6, tok/s 338.6 |
| `google/gemini-3.6-flash`               | benchmark | intelligence 51.6, tok/s 197.3 | intelligence 40.3, tok/s 188.5 |
| `google/gemini-3.7-flash`               | benchmark | intelligence 56, tok/s 365.9   | intelligence 45.2, tok/s 324.6 |
| `google/gemini-3.8-flash`               | benchmark | —                              | intelligence 47.1, tok/s 355.8 |
| `gpt-5.3-codex`                         | benchmark | intelligence 45.5, tok/s 121.4 | intelligence 36.9, tok/s 143.1 |
| `gpt-5.4`                               | benchmark | intelligence 53.1, tok/s —     | intelligence 42.8, tok/s —     |
| `gpt-5.4-mini`                          | benchmark | intelligence 40.9, tok/s —     | intelligence 31.9, tok/s —     |
| `gpt-5.5`                               | benchmark | intelligence 56.3, tok/s —     | intelligence 45.6, tok/s —     |
| `gpt-5.6-luna`                          | benchmark | intelligence 52.3, tok/s 124.1 | intelligence 43.4, tok/s 116.7 |
| `gpt-5.6-sol`                           | benchmark | intelligence 60.9, tok/s 69.6  | intelligence 51.3, tok/s 73.4  |
| `gpt-5.6-terra`                         | benchmark | intelligence 56.6, tok/s 112.8 | intelligence 46.8, tok/s 121.2 |
| `gpt-6-astra`                           | benchmark | —                              | intelligence 54.7, tok/s 63.4  |
| `inclusionai/ling-3.0-flash-sante:free` | added     | —                              | opensource (free)              |
| `meituan/LongCat-2.0:free`              | benchmark | —                              | intelligence 25.8, tok/s 49.2  |
| `meta/muse-spark-1.1`                   | benchmark | intelligence 53.2, tok/s —     | intelligence 41.2, tok/s —     |
| `meta/muse-spark-1.2`                   | benchmark | intelligence 56.8, tok/s —     | intelligence 46.8, tok/s 262   |
| `meta/muse-spark-1.2-contributor`       | benchmark | intelligence 56.8, tok/s —     | intelligence 46.8, tok/s 262   |
| `meta/muse-spark-1.3`                   | benchmark | —                              | intelligence 53, tok/s 221     |
| `meta/muse-spark-1.3-contributor`       | benchmark | —                              | intelligence 53, tok/s 221     |
| `MiniMaxAI/MiniMax-M2.5`                | benchmark | intelligence 34.5, tok/s —     | intelligence 26.8, tok/s —     |
| `MiniMaxAI/MiniMax-M2.7`                | benchmark | intelligence 38.9, tok/s —     | intelligence 30.1, tok/s —     |
| `MiniMaxAI/MiniMax-M3`                  | benchmark | intelligence 45.4, tok/s 111.3 | intelligence 35.7, tok/s 95.7  |
| `moonshotai/Kimi-K2.5`                  | benchmark | intelligence 36, tok/s —       | intelligence 27.6, tok/s —     |
| `moonshotai/Kimi-K2.6`                  | benchmark | intelligence 45.1, tok/s —     | intelligence 35.8, tok/s —     |
| `moonshotai/Kimi-K2.7-Code`             | benchmark | intelligence 43, tok/s 39.5    | intelligence 32.7, tok/s 65.7  |
| `moonshotai/Kimi-K3`                    | benchmark | intelligence 59.7, tok/s 38.4  | intelligence 50.2, tok/s 42.2  |
| `nvidia/nemotron-3-ultra-550b-a55b`     | benchmark | intelligence 38.3, tok/s 174.2 | intelligence 29.3, tok/s 157.9 |
| `Qwen/Qwen3.6-Max-Preview`              | benchmark | intelligence 41.1, tok/s —     | intelligence 32.9, tok/s —     |
| `Qwen/Qwen3.6-Plus`                     | benchmark | intelligence 40.5, tok/s —     | intelligence 31.5, tok/s —     |
| `Qwen/Qwen3.7-Max`                      | benchmark | intelligence 46.7, tok/s —     | intelligence 36.6, tok/s —     |
| `Qwen/Qwen3.7-Plus`                     | benchmark | intelligence 39.4, tok/s 55.5  | intelligence 31.9, tok/s 55.2  |
| `Qwen/Qwen3.8-27B`                      | benchmark | intelligence 52, tok/s 50.5    | intelligence 41.4, tok/s 46.1  |
| `Qwen/Qwen3.8-Max`                      | benchmark | intelligence 58.1, tok/s 23.6  | intelligence 46.9, tok/s 38.1  |
| `stepfun/Step-3.5-Flash`                | benchmark | intelligence 26.5, tok/s —     | intelligence 19.5, tok/s —     |
| `stepfun/Step-3.7-Flash`                | benchmark | intelligence 30.9, tok/s 94.1  | intelligence 22.9, tok/s 86.9  |
| `tencent/hy3-paid`                      | benchmark | intelligence 42.2, tok/s 69.1  | intelligence 32.4, tok/s 99.2  |
| `thinkingmachines/inkling`              | benchmark | intelligence 42.3, tok/s 50.6  | intelligence 32.2, tok/s 65.1  |
| `thinkingmachines/inkling-small`        | benchmark | intelligence 41.2, tok/s 115.5 | intelligence 32.2, tok/s 132.8 |
| `xai/grok-4.5`                          | benchmark | intelligence 55.8, tok/s 48.7  | intelligence 45.5, tok/s 52.6  |
| `xai/grok-4.6`                          | benchmark | intelligence 60.9, tok/s 60.8  | intelligence 50.6, tok/s 57.2  |
| `xiaomi/mimo-v2.5`                      | benchmark | intelligence 38, tok/s 64.1    | intelligence 28.2, tok/s 61.4  |
| `xiaomi/mimo-v2.5-pro`                  | benchmark | intelligence 42.9, tok/s 43.1  | intelligence 32.6, tok/s 40.7  |
| `z-ai/glm-5.3-flash`                    | benchmark | intelligence 57.5, tok/s 41.8  | intelligence 46.2, tok/s 58.7  |
| `zai-org/GLM-5`                         | benchmark | intelligence 40.6, tok/s —     | intelligence 32.4, tok/s —     |
| `zai-org/GLM-5.1`                       | benchmark | intelligence 41, tok/s —       | intelligence 31.9, tok/s —     |
| `zai-org/GLM-5.2`                       | benchmark | intelligence 52.6, tok/s 68.9  | intelligence 42.1, tok/s 68.3  |
| `zai-org/GLM-5.3`                       | benchmark | intelligence 59.5, tok/s 80.6  | intelligence 48.6, tok/s 74.5  |

## 1.7.1 - 2026-09-08

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-06` → `2026-09-08`

| Model                                   | Change      | Before                                                                                                                                      | After                                                                                                                                                |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepseek/deepseek-v4-flash`            | peakOffPeak | peak in 0.44 / out 1.32 / cacheRead 0.014 / cacheWrite 0 · off-peak in 0.22 / out 0.66 / cacheRead 0.007 / cacheWrite 0 (01–04 & 06–10 UTC) | peak in 0.44 / out 1.32 / cacheRead 0.014 / cacheWrite 0 · off-peak in 0.22 / out 0.66 / cacheRead 0.007 / cacheWrite 0 (01–04 & 06–10 UTC, Mon–Fri) |
| `deepseek/deepseek-v4-flash-vision-exp` | peakOffPeak | peak in 0.44 / out 1.32 / cacheRead 0.014 / cacheWrite 0 · off-peak in 0.22 / out 0.66 / cacheRead 0.007 / cacheWrite 0 (01–04 & 06–10 UTC) | peak in 0.44 / out 1.32 / cacheRead 0.014 / cacheWrite 0 · off-peak in 0.22 / out 0.66 / cacheRead 0.007 / cacheWrite 0 (01–04 & 06–10 UTC, Mon–Fri) |
| `deepseek/deepseek-v4-pro`              | peakOffPeak | peak in 1.32 / out 3.96 / cacheRead 0.044 / cacheWrite 0 · off-peak in 0.66 / out 1.98 / cacheRead 0.022 / cacheWrite 0 (01–04 & 06–10 UTC) | peak in 1.32 / out 3.96 / cacheRead 0.044 / cacheWrite 0 · off-peak in 0.66 / out 1.98 / cacheRead 0.022 / cacheWrite 0 (01–04 & 06–10 UTC, Mon–Fri) |

## 1.7.0 - 2026-09-06

### Model catalog: models.md-primary with enrichment that never blocks shipping

The Model catalog's membership authority flipped: the npm `command-code`
package's bundled models.md table is now the sole authority — every row
ships in the Snapshot on the next refresh, even when the provider listing
API lags (day-1 models like `gpt-6-astra` appear immediately). The listing
API is demoted to a pure divergence reporter (annotate-only, zero gating
power, zero field writes), and every other source — RSC slug records, the
CLI bundle, the Command Code models page — is enrichment that fills gaps
but never decides membership, never wins a ship-bar field, and never gates
the refresh (see ADR-0008 and the rewritten glossary in `CONTEXT.md`).

- **Ship-bar parsing** — `scripts/parse-facts.mjs` converts coarse Context
  tokens through a pinned decimal table; a missing Context cell ships as
  `null` (pending, resolved by the fallback ladder), a missing price cell
  ships cost-less (never zero-filled, missing never reads as free), and
  unparseable cells fail loudly. `facts.ts` is now a re-export shim over
  the snapshot rows, keeping the consumer contract stable.
- **Enrichment fallback ladders** — context resolves models.md → RSC
  `contextWindow` → CLI bundle → carried-forward last-known-good (each
  step annotated, provenance recorded on the row); costs resolve models
  page index → model detail page → RSC rates (never carried forward, so a
  model going free is never billed at its old rate); modalities fall back
  CLI bundle → models page Caps Vision bit → text-only. Total absence of
  context or cost is a loud failure (unshippable ship-bar row) — one of
  the two surviving loud failure classes.
- **Sparse classification** — reasoning derives any-true-wins across
  models.md efforts, the RSC `reasoning` flag, and the models page Caps
  Reasoning bit; models with no evidence anywhere ship in a visible
  pending bucket and behave as non-reasoning until evidence arrives.
- **Models page index** — `scripts/parse-models-page.mjs` parses display
  rates, Context strings, and Caps bits from the Command Code models page
  (shape-strict rows, pinned Caps labels, footnote/banded-pricing notes),
  with a pinned 68-entry slug-to-id join map and a re-captured
  `tests/fixtures/models-page.html`.
- **Richer refresh diffs** — a package-table row removal prunes the
  Snapshot immediately with a loud Removed-models section; the Model
  catalog diff gains five enrichment subsections (pending enrichment per
  model, carried-forward context, cost-fallback provenance, API
  divergence, banded-pricing notes); identical catalogs still
  short-circuit to No changes.
- **Catalog refresh** — snapshot refreshed to `command-code@1.49.1` (68
  models); classification 68 entries, deals 71 entries, coverage gate OK.
- **Fixes** — facts rows filtered to snapshot ids (an ahead-of-API
  models.md row broke the cron's stale-entry check); RSC fixture
  assertions tolerate docs-ahead-of-API records.

### Follow-ups

- Open issues carried forward: #136 (reasoning text rendered as normal
  output), #102 (TUI/server init via npm package name), #90 (expired-deal
  filtering).

## 1.6.5 - 2026-09-04

Automated catalog refresh.

## 1.6.4 - 2026-09-03

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-02` → `2026-09-03`

| Model                             | Change  | Before | After                    |
| --------------------------------- | ------- | ------ | ------------------------ |
| `meta/muse-spark-1.1`             | efforts | —      | low, medium, high, xhigh |
| `meta/muse-spark-1.2`             | efforts | —      | low, medium, high, xhigh |
| `meta/muse-spark-1.2-contributor` | efforts | —      | low, medium, high, xhigh |
| `meta/muse-spark-1.3`             | efforts | —      | low, medium, high, xhigh |
| `meta/muse-spark-1.3-contributor` | efforts | —      | low, medium, high, xhigh |

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-02` → `2026-09-03`

| Model                             | Change         | Before                    | After                                    |
| --------------------------------- | -------------- | ------------------------- | ---------------------------------------- |
| `meta/muse-spark-1.1`             | classification | reasoning-without-efforts | efforts model (low, medium, high, xhigh) |
| `meta/muse-spark-1.2`             | classification | reasoning-without-efforts | efforts model (low, medium, high, xhigh) |
| `meta/muse-spark-1.2-contributor` | classification | reasoning-without-efforts | efforts model (low, medium, high, xhigh) |
| `meta/muse-spark-1.3`             | classification | reasoning-without-efforts | efforts model (low, medium, high, xhigh) |
| `meta/muse-spark-1.3-contributor` | classification | reasoning-without-efforts | efforts model (low, medium, high, xhigh) |

## 1.6.3 - 2026-09-02

### Model catalog

## Model catalog

- **FACTS_LAST_REFRESHED**: `2026-09-01` → `2026-09-01`

No changes.

### Reasoning classification

## Reasoning classification

- **CLASSIFICATION_LAST_REFRESHED**: `` → `2026-09-02`

_first refresh — no classification data on the before side._

### Deals intelligence

## Deals intelligence

- **DEAL_LAST_REFRESHED**: `2026-09-01` → `2026-09-01`

No changes.

### Full changeset

The generated-catalog diff above is only the data layer (the new classification module — first refresh). This PR carries the whole derived-classification implementation (#109–#116): the shared RSC record source (scripts/rsc-source.mjs), the classification generator in the refresh ladder, the derived runtime (src/provider/reasoning.ts), the semantic diff sections + classificationChanged boolean, the meaningful-change drift detection (date-only churn opens no PR), ADR-0006/0007 + glossary + docs, and the auto-release workflow. npm test green on the head commit; per-ticket summary in the commit trail.

### Maintainer actions before merge (ADR-0007)

1. Add the RELEASE_PUSH_TOKEN secret (fine-grained PAT, this repo only, Contents: Read and write) so the tag push triggers the release pipeline — a default-token push does not start other workflows.
2. Branch protection is currently off, so the bot push lands freely; when you enable it, add a bypass for the pushing identity (ruleset bypass list).

_Opened from `catalog-refresh/2026-09-02` so merging exercises the new merge-to-release path: the auto-release workflow cuts `chore(release): 1.6.3` + tags v1.6.3, and release.yml publishes._

## 1.6.2 - 2026-09-01

Patch release. Make the daily catalog-refresh cron self-sustainable against
upstream data changes (refs issue #89) and ship the 2026-09-01 catalog
refresh.

- **Self-sustainable cron tests** — the daily catalog-refresh cron has been
  failing every day since 2026-08-28 because its shape-pinning tests pinned
  upstream-managed data (deal pcts, benchmark throughput, plan allowances,
  effort-classification lists). Any legitimate upstream change — a deal
  expiring, a benchmark value moving, a free variant being retired — failed
  `npm test` and blocked the refresh PR until a human updated the pins.
  This release separates **shape** from **value** in those tests, so the
  cron can land upstream changes without manual intervention:
  - `tests/refresh-deals.test.ts`: the five real-RSC `modelDealEntry`
    value pins (Gemini 3.7 Flash, Qwen 3.6 Plus, MiniMax M3, DeepSeek V4
    Flash, Laguna) are replaced with nine synthetic-record tests that own
    every value they assert. A companion test exercises the "deal ended"
    case the cron hit on 2026-08-31. The end-to-end real-RSC smoke test
    still runs the parser over every per-plan slug record to catch
    shape/contract regressions, but no longer pins values.
  - `tests/refresh-deals-rsc.test.ts`: the "emitted catalog has parity
    with the shipped catalog" test asserts structural fields (discount
    exists, benchmark exists, allowance has both goat/pro keys,
    peakOffPeak exists) instead of exact MiniMax / Kimi values. Value
    semantics now live in the synthetic `modelDealEntry` tests.
  - `tests/catalog-metadata.test.ts`: `EFFORTS_MODELS` is now derived
    from the auto-generated `MODEL_EFFORTS` (the npm package's
    `models.md` is the source of truth for which models expose effort
    levels), so a new efforts model — like `deepseek/deepseek-v4-flash-fast`
    added 2026-08-31 — lands in `MODEL_EFFORTS` on the next refresh and
    the reasoning-classification test follows automatically. The
    "exactly once" gate becomes a "no model is in both `MODEL_EFFORTS`
    and `REASONING_MODELS`" invariant (a real misclassification signal)
    plus an advisory check that `isReasoningModel` agrees with the
    union and respects `NON_REASONING_MODELS`.
  - `tests/plugin-models.test.ts`: the "free variants get a `(free)`
    suffix" test pins on `poolside/laguna-s-2.1-free` (still in the
    snapshot) instead of the MiniMax name-collision pair retired
    from upstream.
  - `src/provider/reasoning.ts`: drop `minimax/minimax-m3-free` from
    `REASONING_MODELS` — the variant was retired from upstream's
    `models.md` alongside the free model itself, so the entry was stale.
- **Catalog refresh — 2026-09-01** — snapshot + capability facts +
  RSC fixtures refreshed to current upstream values (see PR #105).
- **Issue #89** — the broader question of how to lock down shape-pinning
  value pins remains open; this release is the cron-side half of that
  fix. The deals-value-pin half is still tracked in #89.

## 1.6.1 - 2026-08-29

Patch release. Catalog refresh to `command-code@1.38.1`, one catalog
classification re-pin, and two CI fixes for the daily catalog-refresh cron.

- **Catalog refresh** — snapshot + capability facts + RSC fixtures refreshed
  to `command-code@1.38.1` (was 1.37.0). Net: 30 → 31 effort entries;
  `tencent/hy4-preview` is the new row (Efforts column now lists
  `low, medium, high`, was empty in 1.37.0). The 62 cost rows are unchanged.
  The deals catalog is unaffected (the new model already had its RSC
  availability + deal info in 1.37.0 fixtures). A follow-up 2026-08-29 cron
  re-captured the RSC fixtures and refreshed `src/catalog/facts.ts` to
  upstream's new values.
- **Catalog classification** — `tencent/hy4-preview` re-pinned to
  `EFFORTS_MODELS` in `src/catalog/facts.ts`; the prior
  `REASONING_MODELS` classification was a labelling error in 1.6.0 (upstream
  advertises it as an effort-controlled model, not a reasoning model). The
  matching unit-test pin was updated in lockstep.
- **CI: catalog-refresh heredoc** — `realpath` the relative `.ts` path
  before the `npx tsx -e` heredoc in `.github/workflows/catalog-refresh.yml`.
  The `after` loop passed a bare-relative path (e.g. `src/catalog/snapshot.ts`)
  to the heredoc, which Node's ESM resolver parsed as a package name and
  rejected with `ERR_MODULE_NOT_FOUND`. The `before` loop was unaffected
  because it used `/tmp/...` absolute paths. Locked down with
  `tests/catalog-refresh-extract.test.ts`.
- **CI: catalog-refresh push** — force-push the `catalog-refresh/${date}`
  branch in `.github/workflows/catalog-refresh.yml`. Two consecutive cron
  runs on the same day land sibling commits on `main`'s HEAD; `git push -u`
  then rejects as non-fast-forward, leaving the cron stuck. `-fu` handles
  both the partial-failure rerun and the fresh-branch case; the branch is
  owned only by this workflow, so there's no clobber risk. The
  `Open PR` step's `gh pr list --head X` already copes correctly with a
  force-pushed tip. Locked down with
  `tests/catalog-refresh-push.test.ts`.
- **Test fix for the push test** — `tests/catalog-refresh-push.test.ts`'s
  verification `git ls-remote` previously ran from the outer project
  CWD, so it resolved `origin` to GitHub rather than the test's local
  bare remote. It passed only on the day the matching
  `catalog-refresh/${date}` branch happened to exist on GitHub. Now
  passes `-C repo.work` so the `origin` resolution is scoped to the
  test fixture.

## 1.6.0 - 2026-08-28

### Deals pipeline: RSC-primary + daily catalog refresh cron

The deals catalog is no longer scraped from HTML tables — it is generated from
the Command Code docs site's React Server Components (RSC) stream (the docs
pages fetched with an `rsc: 1` header; see ADR-0005). The HTML live fetch and
HTML fixtures are gone; `scripts/parse-docs.mjs` keeps its parsers as a
documented air-gapped fallback.

- **RSC parser** — `scripts/parse-rsc.mjs` with committed fixtures
  (`tests/fixtures/rsc-{pricing-limits,goat,pro}.txt`), shape-pinning unit
  tests, a slug-id→snapshot-id alias map, and the shared depth-state-machine
  extracted to `scripts/json-stream.mjs`.
- **Tier overrides** — `scripts/tier-overrides.mjs` pins the 7 known Command
  Code tier-categorization disagreements to `opensource` so TUI badges stay
  stable.
- **Daily cron** — `.github/workflows/catalog-refresh.yml` (06:00 UTC +
  `workflow_dispatch`) regenerates snapshot/facts/fixtures/deals, builds,
  tests, and opens a `chore: catalog refresh` PR (body via
  `scripts/diff-catalog.mjs`) only when upstream moved; silent exit when
  nothing drifted.
- **Fixture lockstep** — `npm run refresh` now re-captures the RSC fixtures
  from the live docs pages (`scripts/capture-rsc-fixtures.mjs`) before
  regenerating the deals catalog, so fixtures, catalog, and tests stay
  consistent. Standalone `refresh:deals` falls back to fixtures on 5xx/network
  and fails loudly on 4xx.
- **Catalog refresh** — deals/snapshot/facts refreshed to
  `command-code@1.37.0` (new: `tencent/hy4-preview`, classified
  reasoning-capable without explicit efforts); benchmark pins updated to
  upstream's new values (Gemini 3.7 Flash, MiniMax M3).
- **Fixes** — live RSC URLs corrected (the `/docs/rsc/*` draft routes 404 on
  the real site); the cron now builds before testing (the pack contract test
  needs `dist/` in a fresh checkout); 4xx RSC responses fail loudly instead of
  silently falling back to fixtures.
- **Follow-ups** — open decisions tracked in issues #89 (shape-pinning value
  pins) and #90 (expired-deal filtering).

## 1.5.2 - 2026-08-28

Chore: catalog refresh to `command-code@1.36.0`, with a deals-coverage gate
fix for name-colliding free variants.

- Added `z-ai/glm-5.3-flash` (GLM-5.3 Flash) and `Qwen/Qwen3.8-Flash` with
  deals records; removed `stealth/ox-alpha` (dropped from the upstream
  catalog).
- MiniMax free variants (`minimax/minimax-m3-free`,
  `minimax/minimax-m2.7-free`) now append `(free)` to their picker display
  name — upstream renamed them to share the paid display name — derived
  data-driven from the zero-cost table, with updated deal allowance pricing
  for `deepseek/deepseek-v4-flash-vision-exp`.
- The deals-coverage gate now iterates every snapshot entry by id, so free
  variants whose display names collide with paid siblings are actually
  coverage-checked (a fixture that silently dropped them previously passed
  with exit 0 and emitted a partial deals catalog); a shared
  `scripts/snapshot-index.mjs` parser replaced the duplicated regex parsing.

### Fixes

- **Deals-coverage gate**: `check-deals-coverage.mjs` and the
  `missingDealsModels` check in `refresh-deals.mjs` iterated a first-wins
  name→id map, so MiniMax free variants — whose snapshot display names
  collide with their paid siblings — were never actually checked. Both gates
  now iterate by id, with the name fallback applying only to unambiguous
  names; records that resolve to no snapshot id are skipped instead of
  collapsing under `undefined`.
- Catalog refresh to `command-code@1.33.0` added the MiniMax free variants;
  the `1.36.0` refresh added GLM-5.3 Flash and Qwen 3.8 Flash, dropped Ox
  Alpha, and extended `src/plugin/models.ts` with the zero-cost `(free)`
  suffix. The extended pricing import now fits the print width again
  (`format:check` passes).

### Chores

- New `tests/deals-coverage.test.ts` regression cases: removed free variants
  now fail the gate; deals free flag ⇔ facts zero-cost table consistency;
  negative suffix test (absent cost entry must not get `(free)`).
- README documents the `(free)` suffix and its zero-cost derivation.

## 1.5.1 - 2026-08-24

Fix: provider parsers now synthesize the full reasoning and text lifecycle —
`reasoning-start`/`reasoning-end` and `text-start`/`text-end` — for both
OpenAI-style and Anthropic-style streams, so AI SDK consumers see balanced
section boundaries instead of missing or duplicated end events.

### Fixes

- **OpenAI-style streams** now emit `reasoning-start` before the first
  reasoning delta and `reasoning-end` before text, tool calls, or finish; the
  same for `text-start`/`text-end`. Reasoning and text sections use stable ids
  from the first chunk (instead of per-chunk ids), and unfinished sections are
  closed when the stream finishes.
- **Anthropic-style streams** now recognize `thinking` blocks and emit
  `reasoning-start`/`reasoning-delta`/`reasoning-end` for them. `content_block_stop`
  closes each block with the correct end event per its type (`text-end`,
  `reasoning-end`, or `tool-input-end` + a single `tool-call`), replacing the
  previous "emit both text-end and tool-input-end" pair that left consumers to
  ignore the spurious one.
- New `tests/stream.test.ts` cases cover the OpenAI reasoning→text ordering,
  reasoning-only finishes, and the Anthropic thinking-block lifecycle;
  `tests/provider-parity.test.ts` accepts `text-start` as the first text part.

## 1.5.0 - 2026-08-23

Feature: the `[CMD] ` display-name prefix for auto-registered models is now
configurable via `provider.commandcode.options.display_prefix`.

### Features

- **Configurable display-name prefix** (issue #60): a string value replaces the
  default `[CMD] ` prefix, and an empty string disables it entirely. The option
  is read-only at resolution time — nothing is persisted into the user's config
  (unlike `npm`/`name`/`env`/`options.baseURL`, which are filled when unset).
- Non-string values fall back to the default `[CMD] ` prefix.
- Declared model entries are never renamed — the prefix applies only to models
  auto-registered from the bundled snapshot.

### Chores

- New `tests/plugin-models.test.ts` cases: `resolveDisplayPrefix` fallback,
  prefix override (`"CC/"`), empty string disabling the prefix (with non-name
  metadata unaffected), and declared models keeping their names regardless of
  the setting.

## 1.4.0 - 2026-08-23

Feature: after a successful `/connect`, the credential is mirrored under
`command-code` in OpenCode's auth store and to `~/.commandcode/auth.json`
(official CLI layout), so ecosystem consumers such as OpenChamber's Usage
page find the key without manual setup.

### Features

- **Credential mirroring** (issue #64): `/connect` now writes the credential
  under `command-code` in OpenCode's auth store — refreshed on every
  successful re-auth so the mirror stays in sync — and to
  `~/.commandcode/auth.json` in the official CLI layout, which is only
  written when it does not already hold a different credential, so an
  official CLI login is never clobbered. Writes are atomic; new auth files
  get owner-only permissions and existing file modes are preserved.
- Mirroring is best-effort: failures are swallowed and never fail `/connect`
  itself, and `mirror: false` opts out (used by the oauth tests). Users who
  authenticate via `COMMANDCODE_API_KEY` alone are unaffected.
- Existing users re-run `/connect` once (or copy the entry manually) to pick
  the mirror up.

### Chores

- New `tests/auth-mirror.test.ts` suite: preserves unrelated auth-store
  entries, owner-only permissions on create, stale-entry refresh on re-auth,
  no-clobber of a differing CLI credential, idempotent no-op, blank-key
  guard, and the end-to-end `/connect` flow including `mirror: false` —
  wired into `test:unit`.
- Docs: README notes the mirror locations and that mirroring is best-effort.

## 1.3.0 - 2026-08-23

Feature: dual-transport Provider API — non-Go plans now use the documented
`/provider/v1/*` endpoints with self-healing fallback to the legacy transport.

### Features

- **Provider API routing** (issues #51, #53): non-Go plans (goat, pro, max,
  max20, teampro, provider aliases) route through the documented Provider API —
  `claude-*` models to `POST /provider/v1/messages` (Anthropic shape), everything
  else to `POST /provider/v1/chat/completions` (OpenAI shape) — with retry,
  timeout, abort, and redaction parity with the legacy transport. Go /
  individual-go sessions stay byte-for-byte on the legacy `POST /alpha/generate`
  wire format, proven by golden byte-parity tests.
- **Session-cached plan resolution** (issue #54): transport is chosen per model
  instance from the shared plan-resolution seam — explicit override →
  `COMMANDCODE_PLAN` env → cached `GET /alpha/whoami` → default Provider API.
  Only a resolved `go` selects the legacy transport; next session after a plan
  upgrade auto-switches.
- **Self-healing upgrade flip** (issue #56): if a plan-detection miss sends a
  true Go user to the Provider API, a documented `403 upgrade_required` pins the
  session to the legacy transport and retries the same call once there — no
  second Provider API hit, no double-counted usage.
- **ZDR passthrough** (issue #57): `CMD_ZDR=1` sends `x-cmd-zdr: 1` on every
  Provider API request; the documented `422 cmd_zdr_no_providers` flows through
  the existing error/redaction pipeline. The legacy transport never sends it.
- **Transport hardening** (issue #58): the finish part now waits for a trailing
  OpenAI usage-only chunk so cost reflects real token counts; non-image file
  parts are rejected with a clear role-aware error instead of silently
  base64-encoding; stateful SSE parsers complete tool calls whose arguments
  arrive across multiple events.

### Fixes

- Restored the "Command Code" TUI sidebar section for Ox Alpha and DeepSeek V4
  Flash Vision (exp): the deals-coverage gate now fails loudly when scraped
  records lack a snapshot model, and the fixtures were refreshed to cover every
  model (issue #61).

### Chores

- Added the `refresh` project skill documenting the offline catalog refresh
  (`npm run refresh` from `tests/fixtures/*.html`).
- New test suites: provider transport, parity, upgrade-fallback, ZDR, and
  deals coverage — all wired into `test:unit`.

## 1.2.2 - 2026-08-22

Chore: catalog refresh to `command-code@1.32.1`.

- Added `deepseek/deepseek-v4-flash-vision-exp` (DeepSeek V4 Flash Vision (exp)):
  1M context, text+image input, reasoning efforts `high`/`max`, $0.22/$0.66 per
  1M input/output tokens.
- Added reasoning efforts for `stealth/ox-alpha` (`low`, `high`, `max`).
- Deals catalog unchanged (56 entries).

## 1.2.1 - 2026-08-21

Fix: `/connect` no longer lists Command Code — the plugin failed to load.

- The `cmd_plan_summary` tool runtime-imported `@opencode-ai/plugin`, an
  optional peer dependency that `opencode plugin <pkg>` installs in
  `.opencode/`, not next to the plugin. That import threw `ERR_MODULE_NOT_FOUND`
  at load, silently killing the whole server plugin — no auto-registration and
  no `/connect` entry (Command Code vanished from the provider list).
- The tool now builds its Zod args from a direct `zod` dependency instead of
  `@opencode-ai/plugin`'s `tool()` helper, so the server bundle has zero
  runtime imports of optional peers.
- Added a contract test that scans the built `dist/` and fails on any runtime
  `@opencode-ai/*` import, so this class of regression can't ship again.

## 1.2.0 - 2026-08-21

Feature: Deals intelligence — per-model pricing/allowance data in a sidebar panel and a plan-summary tool, delivered zero-step.

### Features

- New Deals catalog (`src/deals/catalog.ts`): tier, benchmarks, deal discounts (`was`/`now` rates), peak/off-peak windows, and GOAT/Pro monthly allowances for every model, scraped from the Command Code docs.
- New `cmd_plan_summary` tool (plan-aware allowances and deal rates) and a TUI sidebar "Command Code" section for the selected model.
- Zero-step delivery: the package exports a `./tui` target (`dist/tui.js`), and `opencode plugin opencode-cmd-provider` writes both `opencode.json(c)` and `tui.json` from one command — no hand-written `tui.json` (fixes #39).
- Deals intelligence is an excisable slice (`src/deals/`); deleting it plus two lines in the plugin entry leaves Core (models, auth, streaming) unchanged.
- Visible degradation: when the Deals catalog is empty (scraping mitigated), the sidebar shows a "Deals unavailable" banner with placeholder rows and the tool reports no bundled data — Core is unaffected.
- `refresh:deals` no longer blocks a release: it falls back to fixtures or an empty catalog with a warning, and the Deals gate in the release workflow is non-blocking.

### Fixes

- Streaming usage now reports cache-inclusive input token totals (the AI SDK convention). OpenChamber showed context usage as low as ~0.1% instead of ~5% because the converter reported only non-cached input; `inputTokens.total` now includes cache read/write tokens (issue #36).

### Chores

- Catalog refresh to `command-code@1.31.0`, adding the free reasoning model `stealth/ox-alpha` (Ox Alpha).
- Docs: corrected the install command (`opencode plugin`, no `add`), simplified the README Install section, and added build/test/architecture guidance to `AGENTS.md`.

## 1.1.1 - 2026-08-20

Fix: generate image-input modalities from the Command Code CLI catalog.

- `MODEL_INPUT_MODALITIES` now comes from `inputModalities` fields in the
  parsed `command-code` CLI bundle instead of a hand-maintained table.
- The release refresh validates that every API snapshot model is represented
  in the CLI bundle and fails loudly on unsupported or conflicting modality
  data.
- Added AST parser and offline coverage for reordered fields, duplicate model
  entries, malformed bundles, and text-only fallback behavior.
- Docs: the release skill and facts-sync spec now describe the modality
  refresh and the new release-gate failure mode.
- Thanks to @ericpastorm for #31, which auto-syncs the input-modality table
  from the CLI catalog.

## 1.1.0 - 2026-08-20

Feature: complete capability metadata for every catalog model, with automatic sync of reasoning and pricing facts at release time.

- Every auto-registered model now advertises tool calls, reasoning (efforts or reasoning-capable classification), image input, and cost — no more blank CAPABILITIES, blank MODALITIES, or $0.00 rows (fixes #22).
- Reasoning efforts and per-1M-token rates are generated from the command-code package's bundled `models.md` at snapshot-refresh time (`src/catalog/facts.ts`); the release pipeline now fails loudly if the committed facts drifted (ADR 0003).
- Corrected real pricing drift: `deepseek-v4-pro`/`flash` rates were stale, and the expired `gpt-5.6-terra`/`luna` discounts are gone. Context-tier pricing was removed — Command Code publishes flat rates only.
- Added vision entries for `Qwen/Qwen3.8-27B` and `google/gemini-3.7-flash`, and reasoning efforts for `zai-org/GLM-5.3`, `Qwen/Qwen3.8-27B`, `google/gemini-3.7-flash`, and `xai/grok-4.6`.

## 1.0.2 - 2026-08-19

Chore: refresh the bundled model catalog snapshot after the live catalog drifted.

- Added `Qwen/Qwen3.8-27B` (262144 context) to the bundled snapshot — the release pipeline's stale-snapshot gate would otherwise fail the next tag push (ADR 0003).

## 1.0.1 - 2026-08-16

Chore: harden the release flow so a tag push can no longer publish from an unmerged tree or rewrite tags.

- The release pipeline now refuses to run unless the tag's commit is an ancestor of `origin/main` — a tag pushed before the version bump lands on main fails with an explicit error instead of publishing (ADR 0003).
- A stale catalog snapshot now fails the run with remediation instructions instead of committing on the tag's tree, force-pushing main, and re-pointing the tag.
- The release skill ritual was updated: the bump and CHANGELOG entry land on main via PR before tagging; the tag push is all that triggers the pipeline.

## 1.0.0 - 2026-08-16

First stable release: API and behavior locked in, shipping now runs through a tag-driven pipeline.

- Tag-driven release pipeline: pushing `vX.Y.Z` asserts the tag matches `package.json`, refreshes the bundled model-catalog snapshot (committing it and re-triggering itself if stale), builds, runs the full test suite, publishes to npm via OIDC trusted publishing with provenance, and creates the GitHub Release from the CHANGELOG section (ADR 0002).
- Added the `release` skill documenting the pre-tag ritual and post-push verification; removed the run-map skill and the wayfinder-loop script.
- Docs: spell the product name as OpenCode everywhere, list Command Code plans, credit pi-commandcode-provider, and note provenance requires a public repository.
- The e2e test now uses the inherited PATH instead of a hardcoded home directory.

## 0.1.3 - 2026-08-16

Feature: zero-config install via auto-registration from a bundled model snapshot.

- The plugin now bundles a snapshot of the Command Code model catalog (`src/catalog/snapshot.ts`, 55 models) and auto-registers the `commandcode` provider — npm, name, `env`, and every model — during its `config` hook. Installing the plugin is enough: all Command Code models appear in `/models` with the `[CMD]` display-name prefix, no `provider.commandcode` block or `models` map required. No network access is ever needed at runtime.
- Declared config wins: provider-level keys are filled only when unset, declared models are never modified or removed, models that left the catalog stay usable, and `whitelist`/`blacklist` still filter auto-registered models.
- The snapshot is regenerated from the live catalog at every release via `npm run refresh:snapshot` (`scripts/refresh-snapshot.mjs`); newly published models appear after a plugin update.
- Deleted the now-dead network machinery: live catalog fetch and cache (`loadCommandCodeModels`, cache file), the `provider.models` hook, `catalogToOpenCodeModels`, and the `COMMANDCODE_MODELS_*` env vars.
- `COMMANDCODE_API_BASE` now actually overrides the runtime API base (injected as `options.baseURL` when the user declares no `baseURL` of their own).

## 0.1.2 - 2026-08-15

Fix: tool-call history round-trip and reasoning effort. Live probes against the Command Code API with OpenCode confirmed the AI SDK v3 shapes differ from what the converters expected:

- Assistant tool-call parts carry arguments under `input`, not `args`/`arguments` — the converter read the legacy fields, so every prior tool call was re-sent with empty `{}` arguments, corrupting multi-turn context.
- Tool-result outputs use the v3 `{ type: "text" | "error-text" | "json" | "content", ... }` shapes — `resultText` stringified the wrapper, double-encoding results in history. Replaced with `unwrapToolResult`.
- `reasoning_effort` was silently dropped: OpenCode passes `providerOptions` namespaced per provider (`{ commandcode: { reasoningEffort } }`), but the model read the top-level keys. Added `resolveProviderReasoning` (namespaced + top-level fallback) so the configured thinking level actually reaches the API.

Also: remove duplicated README disclaimer; bump `@ai-sdk/provider` to 4.x and `@types/node` to 26.x.

## 0.1.1 - 2026-08-15

Fix: emit `text-start`/`text-end` and `reasoning-start`/`reasoning-end` stream parts. The live Command Code API sends start/end events with ids; the AI SDK's streamText consumer requires them before deltas, so reasoning-capable models (e.g. `deepseek/deepseek-v4-flash`) failed with "reasoning part <id> not found".

## 0.1.0 - 2026-08-15

Initial release: Command Code provider + plugin for OpenCode. Published to npm as `opencode-cmd-provider@0.1.0` (`latest`), tagged `v0.1.0`.

- `createCommandCode(options)` AI SDK provider (LanguageModelV3) + `default` V1 OpenCode plugin module in one package.
- `/connect` browser auth flow, `COMMANDCODE_API_KEY` env var, and legacy auth file support (`~/.commandcode/auth.json`, `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json`).
- Model catalog fetch, parse, and cache with offline fallback; pricing/cost display; image input; reasoning effort.
- Config-declared `models` map required under `provider.commandcode` until `commandcode` lands in OpenCode's models.dev catalog.
