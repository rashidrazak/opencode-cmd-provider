# Contributing

Thanks for helping improve `opencode-cmd-provider`.

This is an unofficial Command Code provider and plugin for opencode. Keep changes small, tested, and easy to review.

## Development setup

```sh
npm install
npm run build
npm test
```

Useful commands:

```sh
npm run typecheck
npm run format:check
npm run test:unit
npm run test:integration
npm run test:contract
npm run test:e2e
```

Before opening a PR, run:

```sh
npm run build
npm test
npm run format:check
git diff --check
```

For release and npm smoke-test steps, see [RELEASE.md](RELEASE.md).

## End-to-end test

`test:e2e` runs the real opencode CLI against a mock Command Code server through the built package. It requires `opencode` on `PATH` and is excluded from `npm test`:

```sh
npm run build && npm run test:e2e
```

The e2e verifies the plugin loads and auto-registers the Command Code models — the fixture declares no provider and no models, so discovery proves auto-registration — then attempts a headless `opencode run`. If the headless run hangs before sending a request against a local/mock baseURL — an upstream opencode bug (see the test file for issue links) — the test logs the blocker and skips gracefully.

## Pull request guidelines

- Keep PRs focused on one problem or feature.
- Add or update tests for behavior changes.
- Update `README.md`, `CHANGELOG.md`, or `RELEASE.md` when user-facing behavior changes.
- Avoid broad refactors unless the PR is specifically about refactoring.
- Do not include API keys, tokens, real auth files, `.env` files, or other secrets.
- Prefer documented/public Command Code API behavior. If compatibility with CLI behavior is needed, document why.
- Make sure npm package contents still make sense when `package.json` `files` changes.

## Commit message rules

Use Angular-style Conventional Commits.

Format:

```txt
<type>(<scope>): <subject>
```

Examples:

```txt
feat(auth): support Command Code CLI auth files
fix(core): cap max tokens by selected model
docs(release): document npm smoke testing
test(stream): cover reasoning start events
chore(release): publish 0.1.1
```

### Types

Use one of these types:

- `feat`: a new user-facing feature
- `fix`: a bug fix
- `docs`: documentation-only changes
- `style`: formatting-only changes, no behavior change
- `refactor`: code restructuring without behavior change
- `perf`: performance improvement
- `test`: adding or changing tests
- `build`: package, dependency, or build-system changes
- `ci`: CI workflow changes
- `chore`: maintenance that does not fit another type
- `revert`: revert a previous commit

### Scopes

Use a short lowercase scope. Prefer existing project areas:

- `auth`
- `oauth`
- `core`
- `models`
- `stream`
- `tests`
- `docs`
- `release`
- `deps`
- `ci`

A scope is strongly recommended. If no scope fits, choose the closest project area instead of omitting it.

### Subject line

- Use imperative mood: `fix(auth): read oauth credentials`, not `fixed` or `fixes`.
- Keep it concise.
- Start lowercase after the colon.
- Do not end with a period.

### Body and footers

Use a body when the reason is not obvious:

```txt
fix(core): cap max tokens by selected model

Command Code can return models with lower output limits than the provider-wide cap.
Clamp defaults to the selected model so requests do not exceed upstream limits.
```

Breaking changes must be marked with `!` or a `BREAKING CHANGE:` footer:

```txt
feat(api)!: switch to provider api endpoints

BREAKING CHANGE: removes support for the legacy internal generate endpoint.
```
