---
name: release
description: Cut a release of opencode-cmd-provider — bump the version, write the CHANGELOG entry, refresh the catalog snapshot, tag, and verify the pipeline's publish. Use when the user says "cut a release", "release", "bump to X", "tag vX.Y.Z", "publish to npm", or asks to ship a version. Not for editing the workflows or ADRs (plain code work) — for the release ritual itself.
---

# Release

A **Release** is a versioned publication: a git tag `vX.Y.Z` matching
`package.json`, a GitHub Release, and an npm publish (see `CONTEXT.md`,
ADRs 0002 and 0003). The pipeline owns the mechanics; this skill is the
pre-tag ritual and post-push verification.

## Version choice

- `patch` for fixes and chores, `minor` for features, `major` for breaking
  changes.
- Prereleases: `X.Y.Z-beta.N` — the pipeline publishes them with `--tag beta`,
  never touching `latest`.

## Pre-tag steps (all manual, in order)

1. **Bump** `package.json` — it is the single source of truth for the version.
2. **CHANGELOG.md** — add a `## X.Y.Z - YYYY-MM-DD` section (promote
   `## Unreleased` when it exists). This exact section becomes the GitHub
   Release body; without it the pipeline falls back to generated notes.
3. **Commit** — conventional style: `chore(release): X.Y.Z`.
4. **Land on main** — main is protected (required `test` check, PR review), so
   open a PR and merge it. The pipeline refuses tags whose commit is not on
   main; the tag must point at a commit that contains the bump.
5. **Tag**: `git tag vX.Y.Z && git push origin vX.Y.Z` — the tag push triggers
   `release.yml`. Push the tag only; main is already up to date.

The catalog snapshot and capability facts are **not** your job: the pipeline
refreshes both and fails loudly if the live catalog drifted (see ADR 0003).
The gate ignores the date-stamp-only `FACTS_LAST_REFRESHED` line
(`-I 'FACTS_LAST_REFRESHED'`), so a same-day tag passes as long as the data is
fresh. Running `npm run refresh:snapshot` locally beforehand is optional — do
it if you want the diff visible before tagging.

## What the pipeline does (no action needed)

Asserts the tag's commit is on `origin/main` → asserts tag ==
`v<package.json.version>` → build + full test suite → refreshes the catalog
snapshot and fails with instructions if it drifted (never moving the tag or
pushing to main itself) → OIDC npm publish (trusted publishing, provenance
automatic) → GitHub Release from the CHANGELOG section. Provenance requires
the repository to be public.

## Verify after push

1. `gh run list --limit 3` — find the Release run for the tag; watch with
   `gh run watch <run-id> --exit-status --interval 15`.
2. `npm view opencode-cmd-provider@<version> dist-tags.latest` — must be the
   new version.
3. `gh release view vX.Y.Z` — exists, with the changelog as its body.
4. Provenance: `curl -s https://registry.npmjs.org/-/npm/v1/attestations/opencode-cmd-provider@<version>`
   returns attestations (only from a public repository).

## Failure recovery

- **A stale snapshot fails the run** — nothing shipped. Refresh locally
  (`npm run refresh:snapshot`), commit `src/catalog/snapshot.ts` and
  `src/catalog/facts.ts`, land them on main via PR, then re-tag.
- **Publish fails** — nothing shipped (npm rejects before writing) → fix, then
  `gh run rerun <run-id>`.
- **Workflow file changes** — if a fix touches `.github/workflows/release.yml`,
  rerunning is not enough: the run executes the workflow from the tag's tree.
  Move the tag (`git push origin :refs/tags/vX.Y.Z`, re-tag at the fixed
  commit, push) so a fresh run uses the new file.
- **Pre-publish failure** (tests, build, snapshot guard) — fix on main via PR,
  re-tag at the new commit; the old tag's run cannot be salvaged by rerun if
  the tag commit itself is at fault.
