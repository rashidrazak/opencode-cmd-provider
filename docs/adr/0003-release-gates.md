# Release gates: tagged commit on main, stale snapshot fails loudly

Status: accepted

Supersedes the "re-triggering snapshot refresh" behavior of [ADR 0002](0002-tag-driven-releases.md). The trigger stays: pushing a `vX.Y.Z` tag starts the release pipeline. Two gates now decide whether it may publish.

The tag's commit must be an ancestor of `origin/main`, and the tag must match `package.json` (existing guard). The first gate exists because the pipeline runs on the tag's tree, not on main: without it, tagging an unmerged or stale commit publishes a version whose source never reached main — the version bump and CHANGELOG entry ship while `main` still carries the old version, and the published artifact is not reproducible from the branch. Pushing a tag while the bump is still in review, or tagging an old commit, fails with an explicit error instead of releasing.

A stale catalog snapshot now fails the run loudly instead of self-healing: the previous mechanism committed the snapshot on top of the tag's tree, force-pushed `main`, moved the tag, and re-triggered itself. That is unsafe twice over — the snapshot commit can be based on a tree that is not on main, and moving the tag re-points the release at a tree that was never the published one; additionally, the branch protection rule (required `test` status check) rejects the workflow's push to `main` anyway, so the path could not run. The release run now refreshes the snapshot in place, and if it drifted, fails with instructions to refresh locally, commit, and land the change on main before re-tagging. Consequences: a stale snapshot can neither ship nor be forgotten — the same guarantee as before, delivered by a loud failure instead of a silent tag move. The ritual becomes: bump + CHANGELOG, land on main via PR, then tag.

## Amendment: capability facts gate (2026-08-19)

The refresh step now also regenerates `src/catalog/facts.ts` (reasoning efforts + per-1M-token rates from `models.md`, plus input modalities from the command-code CLI bundle). The stale gate covers both `snapshot.ts` and `facts.ts`: drift in either fails the run with the same local-refresh-and-commit instructions, so stale facts can neither ship nor be forgotten. The refresh additionally fails if an API snapshot model is absent from the CLI modality catalog. Generated catalog files are excluded from Prettier (`.prettierignore`); the gate compares byte-for-byte against the generator output. See `docs/superpowers/specs/2026-08-19-facts-sync-design.md`.
