# opencode-cmd-provider

[![CI](https://github.com/rashidrazak/opencode-cmd-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/rashidrazak/opencode-cmd-provider/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-cmd-provider)](https://www.npmjs.com/package/opencode-cmd-provider)

Use your [Command Code](https://commandcode.ai) plan inside
[OpenCode](https://opencode.ai).

This plugin connects OpenCode to Command Code and adds every Command Code model
to the model picker, so you can use your Go, GOAT, Pro, Max 10×, Max 20×,
Provider, Team, or Enterprise plan from OpenCode. It also adds a **Command
Code** section to the session sidebar with your plan's allowances, benchmarks,
and current deals.

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

- Prints `1.18.x` (or lower) → follow **[Install on OpenCode v1](#install-on-opencode-v1)**.
- Prints `2.0.x` → follow **[Install on OpenCode v2](#install-on-opencode-v2)**.

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

OpenCode reuses an existing Command Code CLI login automatically, so you may not
need to connect at all.

## Start using it

1. Pick a model: run `/models` and choose any entry starting with `[CMD]`,
   for example `[CMD] Claude Sonnet 5`.
2. Start chatting. Your Command Code plan handles the requests.

Prefer the command line? Run a single prompt without the interactive interface:

```sh
opencode run --model commandcode/claude-sonnet-5 "hello"
```

## What you get

### The Command Code sidebar

While a session uses a `[CMD]` model, the sidebar shows a **Command Code**
section for that model:

- your plan tier and monthly allowances
- benchmark scores (intelligence, tokens/second)
- current deals and `was`/`now` rates
- peak / off-peak windows

Toggle the sidebar with `ctrl+x b`. Switch to a model that isn't from Command
Code and the section disappears — there is nothing to show for other providers.

### Plan and deal summaries

Ask OpenCode something like _"How many requests does my Command Code plan cover
this month?"_ and it uses the built-in `cmd_plan_summary` tool: your plan's
allowances and the current deals, turned into an estimate. If you want to force
a plan, add it to the question (for example `plan=pro`).

The summary always says where the credential came from — your OpenCode
connection, `COMMANDCODE_API_KEY`, a legacy Command Code auth file, or the plan
you pinned — and names the account it answered for when the API reports one. So
an answer that came from a different account than the one you signed in with is
visible instead of silent.

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

New Command Code models come with plugin updates, so if a model is missing from
`/models`, updating is the fix.

## Uninstall

**OpenCode v2:**

```sh
opencode plugin remove opencode-cmd-provider
```

**OpenCode v1:** remove `opencode-cmd-provider` from the plugin list in your
`opencode.json` (and from `tui.json` if it is listed there).

Then remove the cached copy to free the space:

```sh
rm -rf ~/.cache/opencode/packages/opencode-cmd-provider*
```

The provider and models this plugin registered disappear with it; there is
nothing else to clean up.

## Troubleshooting

| What you see                                       | What to try                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `[CMD]` models in `/models`                     | Check that your API key is set (or that `/connect` succeeded), restart OpenCode, and update the plugin if your install is old.                    |
| The sidebar has no **Command Code** section        | Make sure the session uses a `[CMD]` model, and press `ctrl+x b` — the sidebar may be hidden.                                                     |
| Browser sign-in fails (v1)                         | Run `/connect` again and pick **Command Code API key** to paste one, or set `COMMANDCODE_API_KEY` and restart OpenCode.                           |
| A model shows `$0` cost                            | No published price for that model, so the estimate is `0`. See [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits).      |
| `Command Code rejected this plugin as out of date` | Command Code refuses the version your install reports. Update the plugin — see [Keep it up to date](#keep-it-up-to-date).                         |
| Something else                                     | See the [technical reference](docs/TECHNICAL.md#troubleshooting) or [open an issue](https://github.com/rashidrazak/opencode-cmd-provider/issues). |

## Learn more

- **[Technical reference](docs/TECHNICAL.md)** — how the plugin works, where the
  model and deals data comes from, and the decisions behind it. Jump straight to
  a section:
  - [Hosts and entry points](docs/TECHNICAL.md#hosts-and-entry-points) — which OpenCode processes load the plugin and what each one registers
  - [Installation mechanics and caching](docs/TECHNICAL.md#installation-mechanics-and-caching) — where an install lands, how updates work, and why nothing updates by itself
  - [Model discovery and offline behaviour](docs/TECHNICAL.md#model-discovery-and-offline-behaviour) — bundled model lists, the `[CMD]` name prefix, and mixing in your own model entries
  - [Generated catalogs](docs/TECHNICAL.md#generated-catalogs) — the model, capability, and deals data files and how they are refreshed
  - [Deals intelligence](docs/TECHNICAL.md#deals-intelligence) — where allowances, benchmarks, and deals come from, and what happens when they are unavailable
  - [Reasoning support](docs/TECHNICAL.md#reasoning-support) — how thinking-effort levels reach the model
  - [Image input](docs/TECHNICAL.md#image-input) — which models accept images
  - [Claude prompt caching](docs/TECHNICAL.md#claude-prompt-caching) — how repeated Claude turns reuse a cached prefix instead of re-billing it
  - [Pricing display](docs/TECHNICAL.md#pricing-display) — why some models show `$0` in OpenCode
  - [Environment variables](docs/TECHNICAL.md#environment-variables) — credentials, plan pinning, and test/mock overrides
  - [Development and testing](docs/TECHNICAL.md#development-and-testing) — build, test, and end-to-end commands
  - [Troubleshooting](docs/TECHNICAL.md#troubleshooting) — deeper fixes when the table above is not enough
  - [Design records](docs/TECHNICAL.md#design-records) — every design decision, one line each
- **[CHANGELOG.md](CHANGELOG.md)** — what changed in each release.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[RELEASE.md](RELEASE.md)** — for
  contributors and maintainers.

## Credits

Inspired by [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider).

## License

MIT
