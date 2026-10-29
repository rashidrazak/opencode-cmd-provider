# opencode-cmd-provider

[![CI](https://github.com/rashidrazak/opencode-cmd-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/rashidrazak/opencode-cmd-provider/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-cmd-provider)](https://www.npmjs.com/package/opencode-cmd-provider)

Use your [Command Code](https://commandcode.ai) plan inside
[OpenCode](https://opencode.ai).

This plugin connects OpenCode to Command Code and adds every Command Code model
to the model picker, so you can use your Go, GOAT, Pro, Max 10×, Max 20×,
Provider, Team, or Enterprise plan from OpenCode. It also adds the **Rates &
usage** panel — a **Command Code** section in the session sidebar — with your
plan's allowances, benchmarks, current deals, and live usage.

<!-- Absolute URL so the image also renders on npmjs.com (docs/ is not published to npm). -->

![OpenCode running a Command Code model, with the Rates & usage panel in the sidebar](https://raw.githubusercontent.com/rashidrazak/opencode-cmd-provider/main/docs/images/opencode.png)

> **Disclaimer:** This is an unofficial, community-maintained integration. It is
> not affiliated with, endorsed by, or supported by Command Code. You need your
> own Command Code account, and Command Code's terms, availability, and pricing
> apply.

## Before you start

- **OpenCode** installed — [opencode.ai](https://opencode.ai).
- **A Command Code account and API key** — [commandcode.ai](https://commandcode.ai).

Not sure which OpenCode version you have? Run:

```sh
opencode --version
```

- Prints `1.x` → follow **[Install on OpenCode v1](#install-on-opencode-v1)**.
- Prints `2.x` → follow **[Install on OpenCode v2](#install-on-opencode-v2)**.

## Install on OpenCode v1

```sh
opencode plugin opencode-cmd-provider
```

Run it inside the project where you want the plugin, or add `--global` to make
it available in every project:

```sh
opencode plugin opencode-cmd-provider --global
```

That one command adds the plugin to your OpenCode configuration, registers
Command Code and all of its models, and adds the sidebar section. **Restart
OpenCode** when it finishes.

## Install on OpenCode v2

OpenCode v2 uses a different command — note the `add`:

```sh
opencode plugin add opencode-cmd-provider
```

This adds the plugin to your global OpenCode configuration, so it works in every
project, registers Command Code and all of its models, and adds the sidebar
section. **Restart OpenCode** when it finishes.

If an install command fails on your machine, you can add the plugin to your
configuration by hand — see
[Installation mechanics](docs/TECHNICAL.md#installation-mechanics-and-caching) in
the technical reference.

## Connect your Command Code account

### OpenCode v1: sign in from the browser

In OpenCode, run:

```txt
/connect
```

Select **Command Code** in the provider list, then pick how to sign in:

- **Command Code** — the browser flow. Finish the sign-in in your browser; the
  key is stored by OpenCode and reused from then on. Take your time: the plugin
  waits up to five minutes for the browser to hand the key back, so there is no
  rush picking an organization or approving access.
- **Command Code API key** — paste the key the Command Code studio shows you.
  Use this when the browser cannot reach OpenCode's `localhost` callback, for
  example when OpenCode runs on a remote host.

### OpenCode v2: use your API key

OpenCode v2 has no browser sign-in for Command Code. Set your API key before
starting OpenCode:

```sh
export COMMANDCODE_API_KEY="user_..."
```

Or run `/connect` inside OpenCode and paste the key when asked.

### Already signed in with the Command Code CLI?

If you ran `cmd login`, OpenCode reuses that login automatically, so you may not
need to connect at all. The plugin reads it from `~/.commandcode/auth.json`.

This does not cover `COMMAND_CODE_API_KEY`, the variable the Command Code CLI
documents for CI and headless use. This plugin reads `COMMANDCODE_API_KEY`
instead. Set that one, or run `/connect`.

## Start using it

1. Pick a model: run `/models` and choose any entry starting with `[CMD]`,
   for example `[CMD] Claude Sonnet 5`.
2. Start chatting. Your Command Code plan handles the requests.

Prefer the command line? Run a single prompt without the interactive interface:

```sh
opencode run --model commandcode/claude-sonnet-5 "hello"
```

## What you get

### The Rates & usage panel

While a session uses a `[CMD]` model, the sidebar shows the **Rates & usage**
panel (titled **Command Code**) for that model:

- **Tier and status** of the model
- **Allowance** — the monthly allowance on each plan
- **Rates** — input, output and cache rates per million tokens, including
  peak/off-peak and context-window bands where Command Code publishes them
- **Other Information** — benchmark scores, current deals and `was`/`now` rates
- **Usage** — your live 5-hour, weekly and monthly usage, and this cycle's
  requests, tokens and spend, refreshed as you work

To show, hide or reorder segments, type `/cmd-rates-usage` in the prompt (or
run **Show, hide and reorder sidebar content** from the command palette,
`ctrl+p`). Toggle the sidebar with `ctrl+x b`.

### Plan and deal summaries

Ask OpenCode something like _"Which Command Code plan am I on?"_ or _"How many
requests does my Command Code plan cover this month?"_ and it uses the built-in
`cmd_plan_summary` tool: the plan and account the current credential resolves
to (or the plan you pinned), its allowances and the current deals, turned into
an estimate. The summary says which credential and account it answered for.

To force a plan instead of detecting it, add it to the question (for example
`plan=pro`) or set `COMMANDCODE_PLAN=pro` before starting OpenCode. A pinned
plan is marked `(pinned)` in the summary.

### Everyday details

- **Reasoning models** show their effort levels in OpenCode, so you can pick how
  hard the model should think.
- **Vision models** accept image input; text-only models will tell you instead of
  silently ignoring the image.
- **Costs** shown in OpenCode are estimates from Command Code's published
  pricing, and some models show `$0` because no price is published for them.
  Check the current
  [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits)
  before relying on the numbers.
- **Transient failures are retried.** A dropped connection or a temporary server
  error is replayed a couple of times before OpenCode sees a failure, so a blip
  does not end your turn. Permanent answers — a usage-window limit, a rejected
  request — come straight back as errors, and a turn that already streamed text
  is never replayed.

### Your data

The plugin talks only to Command Code: your prompts, the background model-list
refresh, and the usage lookups for the sidebar panel. It sends nothing anywhere
else. To ask Command Code for zero data retention, set `CMD_ZDR=1` before
starting OpenCode, as you would for the Command Code CLI.

## Keep it up to date

A new release only reaches you after OpenCode refreshes its cached copy of the
plugin.

**OpenCode v2:**

```sh
opencode plugin update
```

**OpenCode v1:** delete the cached copy and restart OpenCode:

```sh
rm -rf ~/.cache/opencode/packages/opencode-cmd-provider*
```

The first start after an update takes a little longer because the plugin is
downloaded again. You never need to sign in again.

New Command Code models usually appear on their own: the plugin refreshes its
model list in the background each time OpenCode starts, so a model launched
after your installed version was published reaches `/models` on the next start.
If one is still missing, the background refresh may be blocked by your network
or disabled via `COMMANDCODE_DISABLE_CATALOG_SYNC`; updating the plugin is then
the fix.

## Uninstall

**OpenCode v2:**

```sh
opencode plugin remove opencode-cmd-provider
```

**OpenCode v1:** remove `opencode-cmd-provider` from the plugin list in your
`opencode.json` (and from `tui.json` if it is listed there).

Then remove the cached copies to free the space — the plugin package
(`npm` on v2, `packages` on v1) and the plugin's saved model list:

```sh
rm -rf ~/.cache/opencode/npm/opencode-cmd-provider* ~/.cache/opencode/packages/opencode-cmd-provider* ~/.cache/opencode-cmd-provider
```

The provider and models this plugin registered disappear with it.

## Troubleshooting

| What you see                                       | What to try                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `[CMD]` models in `/models`                     | Check that your API key is set (or that `/connect` succeeded), restart OpenCode, and update the plugin if your install is old.                             |
| Some Command Code models in `/models` lack `[CMD]` | Update the plugin. On OpenCode v2, older versions kept models.dev's own names for the models it also lists.                                                |
| The sidebar has no **Command Code** section        | Make sure the session uses a `[CMD]` model, and press `ctrl+x b` — the sidebar may be hidden.                                                              |
| Browser sign-in fails (v1)                         | Run `/connect` again and pick **Command Code API key** to paste one, or set `COMMANDCODE_API_KEY` and restart OpenCode.                                    |
| `HTTP 404` on every request                        | Check `provider.commandcode.options.baseURL`. Set it to `https://api.commandcode.ai` — the plugin appends `/provider/v1/…` itself — or remove it.          |
| `Your API key has expired`, but the key works      | A `401` now names the credential it used. If it says `legacy file ~/.commandcode/auth.json`, that login is stale — reconnect or set `COMMANDCODE_API_KEY`. |
| A model shows `$0` cost                            | No published price for that model, so the estimate is `0`. See [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits).               |
| `Command Code rejected this plugin as out of date` | Command Code refuses the version your install reports. Update the plugin — see [Keep it up to date](#keep-it-up-to-date).                                  |
| Something else                                     | See the [technical reference](docs/TECHNICAL.md#troubleshooting) or [open an issue](https://github.com/rashidrazak/opencode-cmd-provider/issues).          |

## Learn more

- **[Technical reference](docs/TECHNICAL.md)** — how the plugin works, where the
  model and deals data comes from, and the decisions behind it. Most useful
  sections: [Environment variables](docs/TECHNICAL.md#environment-variables),
  [Installation mechanics and caching](docs/TECHNICAL.md#installation-mechanics-and-caching),
  and [Troubleshooting](docs/TECHNICAL.md#troubleshooting).
- **[CHANGELOG.md](CHANGELOG.md)** — what changed in each release.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[RELEASE.md](RELEASE.md)** — for
  contributors and maintainers.

## Credits

Inspired by [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider).

## License

MIT
