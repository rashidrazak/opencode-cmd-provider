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
2. **Sync `package-lock.json`** — `package-lock.json` mirrors `package.json`'s
   `version` field at the top of the file and inside the root `packages.""`
   entry. A pure version bump in `package.json` does **not** touch the
   lockfile on its own. Run `npm install --package-lock-only --no-audit --no-fund`
   to refresh the lockfile's `version` lines to match (no dependency
   resolution, no `node_modules` changes). **Never hand-edit `package-lock.json`** —
   let npm write it. Include the regenerated lockfile in the release commit
   alongside the `package.json` bump so the two stay in lockstep (this is
   how the 1.6.0 release commit looked).
3. **CHANGELOG.md** — add a `## X.Y.Z - YYYY-MM-DD` section (promote
   `## Unreleased` when it exists). This exact section becomes the GitHub
   Release body; without it the pipeline falls back to generated notes.
4. **Commit** — conventional style: `chore(release): X.Y.Z`. The commit
   should include `package.json`, `package-lock.json`, and `CHANGELOG.md`.
   If the lockfile sync was missed, amend the commit (force-push the
   release branch) before the PR merges — once the PR lands, the tag
   has to be moved instead.
5. **Land on main** — main is protected (required `test` check, PR review), so
   open a PR and merge it. The pipeline refuses tags whose commit is not on
   main; the tag must point at a commit that contains the bump.
6. **Tag**: `git tag vX.Y.Z && git push origin vX.Y.Z` — the tag push triggers
   `release.yml`. Push the tag only; main is already up to date.

Catalog freshness (`snapshot.ts` / `facts.ts` / `deals.ts`) is a **gate, not an auto-fix**:
the pipeline regenerates each catalog and fails loudly if any drifted — it never
moves the tag or pushes to `main` itself (see ADR 0003). Date-stamp lines are
ignored (`-I 'FACTS_LAST_REFRESHED'` / `-I 'DEAL_LAST_REFRESHED'`), so a
same-day tag passes as long as the data is fresh. Running `npm run refresh`
(both catalogs at once, offline from `tests/fixtures/*.html`) or the individual
`npm run refresh:snapshot` / `npm run refresh:deals` (add `-- --fixtures` for
offline) locally beforehand is optional — do it if you want the diff visible
before tagging. `npm run build` needs `bun` on PATH (TUI solid transform).

## What the pipeline does (no action needed)

Asserts the tag's commit is on `origin/main` → asserts tag ==
`v<package.json.version>` → build + full test suite (`bun` required) →
refreshes the catalog snapshot + capability facts (including input modalities
from the CLI bundle) + deals catalog (tier/benchmarks/deals from docs) and fails
with instructions if any drifted (never moving the tag or pushing to main
itself) → OIDC npm publish (trusted publishing, provenance automatic) → GitHub
Release from the CHANGELOG section. Provenance requires the repository to be
public.

## Verify after push

1. `gh run list --limit 3` — find the Release run for the tag; watch with
   `gh run watch <run-id> --exit-status --interval 15`.
2. `npm view opencode-cmd-provider@<version> dist-tags.latest` — must be the
   new version.
3. `gh release view vX.Y.Z` — exists, with the changelog as its body.
4. Provenance: `curl -s https://registry.npmjs.org/-/npm/v1/attestations/opencode-cmd-provider@<version>`
   returns attestations (only from a public repository).

## Failure recovery

- **A stale catalog fails the run** — nothing shipped. Refresh locally
  (`npm run refresh` for both, or `npm run refresh:snapshot` /
  `npm run refresh:deals -- --fixtures`), commit the changed
  `src/catalog/{snapshot,facts,deals}.ts` (and `tests/fixtures/*.html` if you
  re-captured docs pages), land on main via PR, then re-tag.
- **The refresh cannot generate facts** ("CLI modality catalog is missing API
  models" or "could not parse ... cli.mjs") — nothing shipped. Unlike a stale
  snapshot, this cannot be fixed by refreshing locally: `npm run
refresh:snapshot` fails the same way. It means the API catalog lists a model
  the CLI bundle does not carry yet (upstream timing), or the bundle shape
  changed and `scripts/parse-modalities.mjs` needs updating. Resolve that on
  main via PR, then re-tag.
- **Publish fails** — nothing shipped (npm rejects before writing) → fix, then
  `gh run rerun <run-id>`.
- **Workflow file changes** — if a fix touches `.github/workflows/release.yml`,
  rerunning is not enough: the run executes the workflow from the tag's tree.
  Move the tag (`git push origin :refs/tags/vX.Y.Z`, re-tag at the fixed
  commit, push) so a fresh run uses the new file.
- **Pre-publish failure** (tests, build, snapshot guard) — fix on main via PR,
  re-tag at the new commit; the old tag's run cannot be salvaged by rerun if
  the tag commit itself is at fault.
