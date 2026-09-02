# Release Process

This project uses npm semver releases.

Recommended flow:

- publish prereleases with the `next` dist-tag
- smoke-test the npm package directly in OpenCode
- publish stable releases with the `latest` dist-tag
- commit the release on a branch, open a PR, and merge after CI passes
- tag the stable release on `main` after merge
- comment on the related PR or issue after shipping

## Prerelease flow

Use `next` for beta/alpha/manual validation builds.

```sh
npm run refresh
npm version prepatch --preid next --no-git-tag-version
npm test
npm run format:check
npm pack --dry-run
npm publish --tag next --access public
```

`npm run refresh` regenerates everything at once: `src/catalog/snapshot.ts`
from the live Command Code catalog and `src/catalog/facts.ts` from the CLI
package's `models.md` plus `dist/cli.mjs` input-modality fields, then
re-captures the RSC fixtures (`tests/fixtures/rsc-*.txt`) from the live docs
pages and regenerates `src/catalog/classification.ts` (ADR-0006) and
`src/deals/catalog.ts` from them (see ADR-0005). The
release therefore ships the current model list, reasoning/cost facts, vision
metadata, derived reasoning classification, and deal/allowance/benchmark
intelligence; commit the updated
generated files and fixtures with the release. The refresh fails if an API
model is missing from the CLI modality catalog, if the bundle structure
changes in a way the parser cannot verify, if the coverage gate finds a
snapshot model with no RSC record, or if the RSC records are missing the
`reasoning` flag the classification derives from (a 4xx from the docs site
also fails loudly; 5xx/network falls back to the committed fixtures).

If npm asks for browser or OTP auth, run the publish command manually and complete the npm prompt.

Verify the registry state:

```sh
npm view opencode-cmd-provider@next version dist-tags --json
```

Expected:

- `next` points to the prerelease version
- `latest` still points to the previous stable version

## Test the npm package in OpenCode

Always test from npm, not the local checkout.

### 1. Model discovery smoke test

Build a fixture config that points OpenCode at the published package and the mock endpoints, then verify the model is discovered:

```sh
npm run build
npm run test:e2e
```

The e2e writes a throwaway `opencode.json` via `scripts/opencode-fixture.mjs` (plugin only — no declared provider or models) and runs `opencode models` against the built package. Expected: `ok - plugin auto-registers commandcode/claude-sonnet-5 with no declared config`.

### 2. Manual `/connect` + run test with isolated OpenCode config

Use temporary OpenCode config and data directories so the test does not touch your real OpenCode auth:

```sh
export HOME="$(mktemp -d)"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.data"
export XDG_CACHE_HOME="$HOME/.cache"
```

Then, with a `plugin` entry pointing at the published package (the provider block is auto-registered):

```txt
/connect
```

Complete the browser auth flow, then send:

```txt
Reply exactly: manual-npm-ok
```

Expected:

- login succeeds
- the model replies exactly `manual-npm-ok`

### 3. Post-login non-interactive test

Using the same exported temp variables from above:

```sh
opencode run --model commandcode/claude-sonnet-5 "Reply exactly: manual-npm-ok"
```

Expected:

```txt
manual-npm-ok
```

### 4. Cleanup isolated OpenCode config

Only run this if these variables were created by the test above:

```sh
unset HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
```

## Stable release flow

After the `next` package is verified, set the intended stable version:

```sh
npm version 0.1.1 --no-git-tag-version
```

Replace `0.1.1` with the intended stable version.

Update `CHANGELOG.md`, then run checks:

```sh
npm test
npm run format:check
npm pack --dry-run
git diff --check
```

Commit on a release branch and open a PR:

```sh
git checkout -b release/0.1.1
git add .
git commit -m "Release 0.1.1"
git push origin release/0.1.1
gh pr create --title "chore(release): publish 0.1.1" --base main
```

If `main` is branch-protected, the release must go through a PR with passing CI.

Once CI passes, approve and merge:

```sh
gh pr review <number> --approve
gh pr merge <number> --squash --delete-branch
```

After merge, pull `main` and tag locally:

```sh
git checkout main
git pull origin main
git tag -a v0.1.1 -m "Release 0.1.1"
git push origin v0.1.1
```

Publishing runs through the tag-driven GitHub Actions pipeline
(`.github/workflows/release.yml`, ADR-0002): pushing a `vX.Y.Z` tag whose
commit is on `main` and whose version matches `package.json` runs the build,
full suite, and stale-catalog gates, then publishes to npm via OIDC trusted
publishing and creates the GitHub Release from the CHANGELOG section. If npm
asks for browser or OTP auth in a local publish, complete the npm prompt
locally.

Verify npm:

```sh
npm view opencode-cmd-provider version dist-tags --json
npm view opencode-cmd-provider@0.1.1 version --json
```

Expected:

- `latest` points to the stable version
- the stable version exists on npm

## Catalog-refresh auto-release (merge = publish)

Merging a **Catalog refresh PR** (a `catalog-refresh/*` branch) cuts its own
patch release automatically (`.github/workflows/auto-release.yml`,
ADR-0007): the workflow patch-bumps the version, syncs the lockfile via npm,
prepends a `## X.Y.Z - date` CHANGELOG section authored from the merged PR
body's semantic sections (Model catalog / Reasoning classification / Deals
intelligence), commits `chore(release): X.Y.Z` as the bot on `main`, and
tags `vX.Y.Z` — which triggers the unchanged release pipeline. One publish
path; no manual ritual.

Rails:

- add the `skip-release` label to the refresh PR to suppress the release for
  that refresh (e.g. bundling it with a larger manual release);
- the release is skipped entirely when a `vX.Y.Z` tag for the computed
  version already exists;
- pushing the bot commit to `main` relies on the `main-hard-rules` ruleset
  bypass (the required-`test` ruleset) for the pushing identity —
  `main-review`'s bypass already covers the review requirement (ADR-0007).
  If merging a refresh PR stops producing `chore(release)` commits, check
  that bypass first;
- a tag push with the default `GITHUB_TOKEN` does not start the release
  pipeline (GitHub's recursive-event rule): provide the `RELEASE_PUSH_TOKEN`
  secret (fine-grained PAT or GitHub App token, this repo only,
  `contents: write`) so the tag push triggers `release.yml` — without it the
  commit and tag land but the pipeline must be started manually (ADR-0007).

Feature releases (and any manual release) keep the tag-driven ritual above.

## GitHub follow-up

Comment on the related PR and issue after publishing and pushing:

```sh
gh pr comment <number> --body "Shipped in \`opencode-cmd-provider@0.1.1\` / tag \`v0.1.1\`."

gh issue comment <number> --body "Shipped in \`opencode-cmd-provider@0.1.1\` / tag \`v0.1.1\`."
```

Only comment on PRs or issues actually included in the release.
