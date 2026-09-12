# Security Policy

`opencode-cmd-provider` is an unofficial, community-maintained provider and
plugin for [OpenCode](https://opencode.ai). It is not affiliated with, endorsed
by, or supported by Command Code.

## Supported versions

Only the latest published release receives security fixes. OpenCode caches the
plugin package per version and reuses it on every startup, so an older version
keeps running until it is reinstalled:

```sh
rm -rf ~/.cache/opencode/packages/opencode-cmd-provider*
```

Then restart OpenCode. This removes the plugin and its version-pinned runtime
provider together.

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
form on the **Security** tab of this repository.

If that form is not available, open an issue that asks for a private channel and
contains **no** details — no reproduction steps, no affected paths, and above all
no credentials.

Please include the affected version, the impact, reproduction steps, and any
suggested fix. Never paste a live API key into a report — a redacted placeholder
or the first few characters are enough to identify which credential is involved.

There is no bug bounty. This is a volunteer project: reports are handled on a
best-effort basis, and you will get an acknowledgement when yours is triaged.

## Scope

In scope:

- credential resolution and handling (`src/provider/auth-key.ts`,
  `src/plugin/auth.ts`, `src/plugin/auth-mirror.ts`);
- credential redaction of surfaced error text (`src/provider/redact.ts`);
- the auto-registered `provider.commandcode` config injected at load
  (`src/plugin/models.ts`);
- the build and release pipeline (`.github/workflows/`, `scripts/`).

Out of scope — report these where they belong instead:

- the Command Code API, service, account, or billing behaviour (Command Code
  support);
- OpenCode itself and its plugin loader (upstream `anomalyco/opencode`);
- vulnerabilities in third-party dependencies, unless you can show they are
  reachable through this plugin.

## How credentials are handled

- The API key is resolved per request, in precedence order: the credential
  OpenCode passes from `/connect` or config, then the `COMMANDCODE_API_KEY`
  environment variable, then the legacy auth files `~/.commandcode/auth.json`,
  `~/.omp/agent/auth.json`, and `~/.pi/agent/auth.json`.
- `/connect` mirrors the credential to `~/.commandcode/auth.json` (the official
  CLI layout) so ecosystem consumers can read it. The mirror is best-effort and
  is skipped when that file already holds a different credential; an existing
  file's mode is preserved.
- Error text surfaced to OpenCode passes through `redactCommandCodeErrorText`,
  which replaces credential-shaped strings before they can reach logs or the UI.
- No credential is bundled into the published package. Nothing in this
  repository — including tests, fixtures, and docs — may contain a real key,
  token, or auth file; see [CONTRIBUTING.md](CONTRIBUTING.md).
