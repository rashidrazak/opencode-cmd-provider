---
name: release
description: Cut a release of opencode-cmd-provider — bump the version, write the CHANGELOG entry, refresh the catalog snapshot, tag, and verify the pipeline's publish. Use when the user says "cut a release", "release", "bump to X", "tag vX.Y.Z", "publish to npm", or asks to ship a version. Not for editing the workflows or ADRs (plain code work) — for the release ritual itself.
---

# Release

A **Release** is a versioned publication: a git tag `vX.Y.Z` matching
`package.json`, a GitHub Release, and an npm publish (see `CONTEXT.md`,
ADR 0002). The pipeline owns the mechanics; this skill is the pre-tag ritual
and post-push verification.

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
4. **Tag and push**: `git tag vX.Y.Z && git push origin main --tags` — the tag
   push triggers `release.yml`.

The catalog snapshot is **not** your job: the pipeline refreshes it and fixes
the tag if the live catalog drifted (see ADR 0002). Running
`npm run refresh:snapshot` locally beforehand is optional — do it if you want
the diff visible before tagging.

## What the pipeline does (no action needed)

Asserts tag == `v<package.json.version>` → refreshes the catalog snapshot; if
stale, commits it, moves the tag, and re-triggers itself (that run fails with
an explanatory error; the re-triggered run publishes) → build + full test
suite → OIDC npm publish (trusted publishing, provenance automatic) → GitHub
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

- **A stale snapshot produces a failed run + a re-triggered run** — that's
  normal: the first run committed the snapshot and moved the tag; the second
  run publishes. Verify with the second run's status.
- **Publish fails** — nothing shipped (npm rejects before writing) → fix, then
  `gh run rerun <run-id>`.
- **Workflow file changes** — if a fix touches `.github/workflows/release.yml`,
  rerunning is not enough: the run executes the workflow from the tag's tree.
  Move the tag (`git push origin :refs/tags/vX.Y.Z`, re-tag at the fixed
  commit, push) so a fresh run uses the new file.
- **Pre-publish failure** (tests, build, snapshot guard) — fix on main, rerun;
  no tag movement unless the workflow changed.