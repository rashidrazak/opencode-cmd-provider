# Release Process

This project uses npm semver releases.

Recommended flow:

- publish prereleases with the `next` dist-tag
- smoke-test the npm package directly in opencode
- publish stable releases with the `latest` dist-tag
- commit the release on a branch, open a PR, and merge after CI passes
- tag the stable release on `main` after merge
- comment on the related PR or issue after shipping

## Prerelease flow

Use `next` for beta/alpha/manual validation builds.

```sh
npm run refresh:snapshot
npm version prepatch --preid next --no-git-tag-version
npm test
npm run format:check
npm pack --dry-run
npm publish --tag next --access public
```

`npm run refresh:snapshot` regenerates `src/catalog/snapshot.ts` from the live
Command Code catalog so the release ships the current model list; commit the
updated snapshot with the release.

If npm asks for browser or OTP auth, run the publish command manually and complete the npm prompt.

Verify the registry state:

```sh
npm view opencode-cmd-provider@next version dist-tags --json
```

Expected:

- `next` points to the prerelease version
- `latest` still points to the previous stable version

## Test the npm package in opencode

Always test from npm, not the local checkout.

### 1. Model discovery smoke test

Build a fixture config that points opencode at the published package and the mock endpoints, then verify the model is discovered:

```sh
npm run build
npm run test:e2e
```

The e2e writes a throwaway `opencode.json` via `scripts/opencode-fixture.mjs` (plugin only — no declared provider or models) and runs `opencode models` against the built package. Expected: `ok - plugin auto-registers commandcode/claude-sonnet-5 with no declared config`.

### 2. Manual `/connect` + run test with isolated opencode config

Use temporary opencode config and data directories so the test does not touch your real opencode auth:

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

### 4. Cleanup isolated opencode config

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

Publish stable locally:

```sh
npm publish --tag latest --access public
```

Publishing is intentionally manual/local; there is no GitHub Actions publish workflow. If npm asks for browser or OTP auth, complete the npm prompt locally.

Verify npm:

```sh
npm view opencode-cmd-provider version dist-tags --json
npm view opencode-cmd-provider@0.1.1 version --json
```

Expected:

- `latest` points to the stable version
- the stable version exists on npm

## GitHub follow-up

Comment on the related PR and issue after publishing and pushing:

```sh
gh pr comment <number> --body "Shipped in \`opencode-cmd-provider@0.1.1\` / tag \`v0.1.1\`."

gh issue comment <number> --body "Shipped in \`opencode-cmd-provider@0.1.1\` / tag \`v0.1.1\`."
```

Only comment on PRs or issues actually included in the release.
