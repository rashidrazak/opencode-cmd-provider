# opencode-cmd-provider

[![CI](https://github.com/rashidrazak/opencode-cmd-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/rashidrazak/opencode-cmd-provider/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-cmd-provider)](https://www.npmjs.com/package/opencode-cmd-provider)

A provider and plugin for [OpenCode](https://opencode.ai) that connects to the [Command Code](https://commandcode.ai) Provider API. This enables you to use ALL Command Code plans — Go, GOAT, Pro, Max 10×, Max 20×, Provider, Team, and Enterprise — with OpenCode.

> **Disclaimer:** This is an unofficial, community-maintained integration. It is not affiliated with, endorsed by, or supported by Command Code. You need your own Command Code account and API key or subscription. Command Code's terms, availability, and pricing apply.

## Install

```sh
opencode plugin opencode-cmd-provider
```

Update an existing install:

```sh
opencode plugin opencode-cmd-provider --force
```

Install globally (available in every project):

```sh
opencode plugin opencode-cmd-provider --global
```

Manual config also works:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cmd-provider"],
}
```

Then authenticate:

```txt
/connect
```

Select **Command Code**, complete the browser flow, and pick a model with `/models`.

## Authentication

### Browser login

Run `/connect` in OpenCode and select **Command Code**. The browser flow stores the returned credential in OpenCode's auth store.

The credential is also mirrored under `command-code` in OpenCode's auth store and to `~/.commandcode/auth.json` (official CLI layout, only written when that file does not already hold a different credential). Ecosystem consumers such as OpenChamber's Usage page read those locations. Mirroring is best-effort; if it fails, `/connect` still succeeds.

If automatic transfer from the browser fails, copy the API key shown by Command Code and export it as `COMMANDCODE_API_KEY` (see below).

### Environment variable

```sh
export COMMANDCODE_API_KEY="user_..."
```

### Legacy auth files

The provider also reads existing credentials from:

- `~/.commandcode/auth.json`
- `~/.omp/agent/auth.json`
- `~/.pi/agent/auth.json`

Supported examples:

```json
{
  "apiKey": "user_..."
}
```

```json
{
  "command-code": {
    "type": "api",
    "key": "user_..."
  }
}
```

```json
{
  "commandcode": "user_..."
}
```

## Usage

Pick a model with `/models`, or run non-interactively:

```sh
opencode run --model commandcode/claude-sonnet-5 "hello"
```

## Deals intelligence

Every Command Code model ships with deal/allowance/benchmark intelligence
(bundled in `src/deals/catalog.ts`), extracted from the Command Code docs'
React Server Components (RSC) stream — the structured payload the docs site
serves for `rsc: 1` requests (see ADR-0005). It surfaces in two places:

- **Sidebar** — in a session, the OpenCode sidebar (`ctrl+x b`) shows a
  `Command Code` section for the selected model: tier, GOAT/Pro allowance,
  benchmark (intelligence, tok/s), deal discounts (`was`/`now` rates), and
  peak/off-peak windows.
- **`cmd_plan_summary` tool** — plan-aware allowances and deal rates, to
  estimate monthly requests.

Delivery is zero-step: the package exports both a `server` and a `tui` target
(`exports["./tui"]` → `dist/tui.js`), and `opencode plugin
opencode-cmd-provider` writes both `opencode.json(c)` and `tui.json` from one
spec. The sidebar is a TUI plugin loaded from `tui.json` — which is why
installs made before the `./tui` export only wrote the server target and never
showed a sidebar. Re-run with `--force` to add `tui.json`.

When the Deals catalog is empty (the upstream fetch failed or the RSC shape
changed), the feature degrades visibly rather than silently: the sidebar shows
a `Deals unavailable` banner with placeholder rows, and `cmd_plan_summary`
reports that no deal data is bundled. Core (models, auth, streaming) is
unaffected.

## Model discovery and offline behavior

The plugin ships two bundled catalogs and auto-registers every model into
OpenCode's config at startup, with the `[CMD]` display-name prefix (e.g.
`[CMD] Claude Sonnet 5`) so they aren't confused with same-named models from
other providers. Free-tier variants that share an upstream display name with a
paid model (e.g. the MiniMax M3 free tier) get a `(free)` suffix —
`[CMD] MiniMax M3 (free)` — so the two are distinguishable in the model
picker. The suffix is derived from the bundled pricing table: a model is
labeled free only when the catalog carries an explicit zero-cost entry. Model
availability changes when the package is updated. You can still declare your
own `provider.commandcode` entry; your declarations always win and the
snapshot fills in only what's missing (`whitelist`/`blacklist` on a declared
entry filter the auto-registered models too).

The `[CMD] ` display-name prefix is configurable through the declared
provider entry's options:

```jsonc
{
  "provider": {
    "commandcode": {
      "options": {
        "display_prefix": "", // default "[CMD] "; empty string disables
      },
    },
  },
}
```

Declared model entries are never renamed; the prefix applies to
auto-registered models only.

- Snapshot — `src/catalog/snapshot.ts` (model ids, names, context lengths) plus
  `src/catalog/facts.ts` (reasoning efforts, per-1M-token rates, input
  modalities). Regenerated from the live catalog via `npm run refresh:snapshot`.
- Classification — `src/catalog/classification.ts` (per-model reasoning
  capability, derived from the `reasoning` flag on the docs' RSC slug
  records; ADR-0006). Regenerated via `npm run refresh:classification`; the
  runtime derives its reasoning metadata from this module, so upstream
  classification changes land as data, never as hand edits.
- Deals — `src/deals/catalog.ts` (per-model tier, benchmarks, deal
  discounts, `was`/`now` rates, peak/off-peak windows, and GOAT/Pro monthly
  allowances for every model). Extracted from the Command Code docs' RSC
  stream (the `pricing-limits`, `plans/goat`, `plans/pro` pages fetched with
  an `rsc: 1` header; fixtures in `tests/fixtures/rsc-*.txt`) via
  `npm run refresh:deals`. Standalone live runs fall back to the committed
  fixtures on 5xx/network failure and fail loudly on 4xx; add
  `-- --fixtures` to regenerate offline from the committed fixtures.

Run `npm run refresh` to regenerate everything at once: the snapshot and
facts come from the live Command Code catalog, the RSC fixtures are
re-captured from the live docs pages (`npm run refresh:fixtures`), and the
classification module and deals catalog are regenerated from the fresh
fixtures — so fixtures, catalogs, and tests stay in lockstep. A daily GitHub
Actions cron
(`.github/workflows/catalog-refresh.yml`, 06:00 UTC, also manually
triggerable via `workflow_dispatch`) runs the same pipeline: when upstream
moved it opens a `chore: catalog refresh` PR whose body is the human-readable
diff from `scripts/diff-catalog.mjs` — model catalog, reasoning
classification (flips, new reasoning models, retirements, active overrides),
and deals sections; when nothing meaningful drifted it exits silently (a
run whose only change is the refreshed-date stamps opens no PR).

Auto-registration adds no network latency to OpenCode startup — the snapshot is
bundled, and the plugin never contacts the Command Code API to list models. The
plugin works fully offline; model availability never depends on the catalog
endpoint being reachable.

The following environment variables are intended for tests, local mocks, and
compatible API endpoints:

| Variable                      | Purpose                                    |
| ----------------------------- | ------------------------------------------ |
| `COMMANDCODE_API_BASE`        | Override the Command Code API base URL     |
| `COMMANDCODE_FACTS_URL`       | Override the bundled `models.md` URL       |
| `COMMANDCODE_MODALITIES_URL`  | Override the CLI bundle URL                |
| `COMMANDCODE_RSC_PRICING_URL` | Override the `pricing-limits` RSC page URL |
| `COMMANDCODE_RSC_GOAT_URL`    | Override the `plans/goat` RSC page URL     |
| `COMMANDCODE_RSC_PRO_URL`     | Override the `plans/pro` RSC page URL      |

### Reasoning support

Reasoning metadata is derived from the generated catalogs (ADR-0006): models
upstream flags as reasoning-capable advertise `reasoning: true`
automatically — with explicit effort variants when the generated facts list
effort levels, and without variants otherwise. Supported levels are sent as
the documented `reasoning_effort` request field; `off`, unsupported levels,
and newly discovered models without metadata do not add reasoning fields to
the request. No prompt instructions are injected.

Reasoning blocks from completed assistant turns are not replayed to Command Code in later requests; only the user-visible text and completed tool calls are sent back as history. This prevents prior private reasoning traces from interfering with reasoning on follow-up turns.

## Image input

Image input is advertised only for models marked with the `image` input modality in the Command Code CLI bundle. The release-time refresh generates this map into `src/catalog/facts.ts`; unknown models default to text-only until their upstream metadata is reviewed.

For vision-capable models, image blocks from user messages and tool results are forwarded in Command Code's data-URL wire format. Text-only models reject image content before making a network request instead of silently dropping it.

## Pricing display

The Command Code Provider API does not currently include prices in its model catalog. This provider generates a table from the bundled `models.md` catalog so OpenCode can display estimated request costs.

Models missing from that table display zero cost in OpenCode. This does **not** mean Command Code will bill the request at zero. Check the current [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) before relying on the displayed value.

## Update and remove

Update the installed package, or remove it from the `plugin` array in your `opencode.json` (the auto-registered `provider.commandcode` entry is injected by the plugin, so there is no config block to remove). The npm package is cached under OpenCode's plugin cache (`~/.cache/opencode/packages/`); remove the cached directory to fully uninstall.

## Development

Build, then run the full suite:

```sh
npm install
npm run build
npm test
npm run format:check
```

`npm run build` needs [bun](https://bun.sh) on PATH — it compiles `src/deals/tui.tsx` with the solid transform (`scripts/build-tui.ts`), so the TUI panel's JSX props are reactive and the sidebar repaints on mid-session model switches.

The headless end-to-end test runs the real OpenCode CLI against a mock Command Code server through the built package:

```sh
npm run build && npm run test:e2e
```

`scripts/opencode-fixture.mjs` writes a throwaway `opencode.json` wiring only the local build as a plugin — no declared provider or models — so `opencode models` proves auto-registration against a real opencode binary. `test:e2e` is a local dev gate (it needs the real `opencode` binary on PATH) and is excluded from `npm test`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and tests. See [RELEASE.md](RELEASE.md) for the release process.

## Credits

Inspired by [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider).

## License

MIT
