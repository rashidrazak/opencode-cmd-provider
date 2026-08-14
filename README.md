# opencode-cmd-provider

[![CI](https://github.com/rashidrazak/opencode-cmd-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/rashidrazak/opencode-cmd-provider/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-cmd-provider)](https://www.npmjs.com/package/opencode-cmd-provider)

A provider and plugin for [opencode](https://opencode.ai) that connects to the [Command Code](https://commandcode.ai) Provider API.

> **Disclaimer:** This is an unofficial, community-maintained integration. It is not affiliated with, endorsed by, or supported by Command Code. You need your own Command Code account and API key or subscription. Command Code's terms, availability, and pricing apply.

## Install

Add the package to your opencode configuration:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cmd-provider"],
  "provider": {
    "commandcode": {
      "npm": "opencode-cmd-provider",
      "name": "Command Code",
      "options": { "baseURL": "https://api.commandcode.ai" },
      "models": {
        "claude-sonnet-5": {
          "name": "Claude Sonnet 5",
          "limit": { "context": 200000, "output": 65536 },
        },
        "deepseek/deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash",
        },
      },
    },
  },
}
```

> **The `models` map is required, and each key must be the model's full Command
> Code catalog ID.** opencode only fires a provider's `models` discovery hook for
> providers already in its [models.dev](https://models.dev) catalog, and
> `commandcode` is not in that catalog yet — so you must declare the models you
> want. The keys are passed straight to the Command Code API, so use the exact
> catalog IDs (some are prefixed, e.g. `deepseek/deepseek-v4-flash`,
> `google/gemini-3.5-flash`, `xai/grok-4.5`). List the current catalog from the
> terminal with `opencode run --model commandcode/... "hi"` after connecting, or
> hit `https://api.commandcode.ai/provider/v1/models`. An unprefixed or wrong ID
> fails with a `403 Model/provider not recognized` error. When `commandcode`
> lands in the models.dev catalog, this map becomes optional and discovery works
> via the plugin's `provider.models` hook.

Start or reload opencode, then authenticate:

```txt
/connect
```

Select **Command Code**, complete the browser flow, and pick a model with `/models`.

## Authentication

### Browser login

Run `/connect` in opencode and select **Command Code**. The browser flow stores the returned credential in opencode's auth store.

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

Model availability changes over time and is refreshed from the Command Code catalog when opencode loads.

### Reasoning support

Reasoning metadata is enriched only for models whose Command Code effort support is known. Supported levels are sent as the documented `reasoning_effort` request field; `off`, unsupported levels, and newly discovered models without metadata do not add reasoning fields to the request. No prompt instructions are injected.

Reasoning blocks from completed assistant turns are not replayed to Command Code in later requests; only the user-visible text and completed tool calls are sent back as history. This prevents prior private reasoning traces from interfering with reasoning on follow-up turns.

## Model discovery and offline behavior

The provider fetches the current model catalog from:

```txt
https://api.commandcode.ai/provider/v1/models
```

The last successful catalog is cached at `<data-dir>/commandcode-models.json`, where `<data-dir>` is opencode's XDG data directory (default `~/.local/share/opencode`).

If the endpoint is temporarily unavailable, the provider uses the cached catalog. On a first offline start without a cache, opencode still starts cleanly, but Command Code models remain unavailable until the connection is restored.

The following environment variables are intended for tests, local mocks, and compatible API endpoints:

| Variable                        | Purpose                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `COMMANDCODE_API_BASE`          | Override the Command Code API base URL                                                         |
| `COMMANDCODE_MODELS_URL`        | Override the model catalog endpoint                                                            |
| `COMMANDCODE_MODELS_CACHE`      | Override the model cache file path                                                             |
| `COMMANDCODE_MODELS_TIMEOUT_MS` | Catalog fetch timeout (defaults to 10 seconds; invalid or non-positive values use the default) |

## Image input

Image input is advertised only for models marked with the `image` input modality in the Command Code model catalog. The capability snapshot follows the current official CLI catalog; unknown models default to text-only until their upstream metadata is reviewed.

For vision-capable models, image blocks from user messages and tool results are forwarded in Command Code's data-URL wire format. Text-only models reject image content before making a network request instead of silently dropping it.

## Pricing display

The Command Code Provider API does not currently include prices in its model catalog. This provider keeps a static table for models with known prices so opencode can display estimated request costs.

Models missing from that table display zero cost in opencode. This does **not** mean Command Code will bill the request at zero. Check the current [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) before relying on the displayed value.

## Update and remove

Update the installed package, or remove it from the `plugin` array and the `provider.commandcode` block in your `opencode.json`. The npm package is cached under opencode's plugin cache (`~/.cache/opencode/packages/`); remove the cached directory to fully uninstall.

## Development

Build, then run the full suite:

```sh
npm install
npm run build
npm test
npm run format:check
```

The headless end-to-end test runs the real opencode CLI against a mock Command Code server through the built package:

```sh
npm run build && npm run test:e2e
```

`scripts/opencode-fixture.mjs` writes a throwaway `opencode.json` wiring the local build to the mock endpoints. `test:e2e` is a local dev gate (it needs the real `opencode` binary on PATH) and is excluded from `npm test`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and tests. See [RELEASE.md](RELEASE.md) for the release process.

## License

MIT
