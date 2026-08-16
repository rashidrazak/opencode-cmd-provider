# Tag-driven releases via GitHub Actions

Status: accepted

Releases are cut by pushing a `vX.Y.Z` tag: a GitHub Actions workflow asserts the tag matches `package.json`, runs the full suite and build, regenerates the catalog snapshot and — if the live catalog drifted — commits the refresh, moves the tag to it, and re-triggers itself; otherwise it publishes to npm via OIDC trusted publishing (provenance automatic, `beta` dist-tag for prereleases) and creates the GitHub Release from the CHANGELOG section.

`package.json` stays the single source of truth for the version, and a human stays in control of what ships: version bump and CHANGELOG entry happen before tagging; snapshot refresh does not, because a stale model catalog is the one failure mode that tests and builds cannot catch — the code would be perfect while the shipped snapshot silently lags the live catalog. So the pipeline refreshes it itself, and a stale snapshot can neither ship nor be forgotten. We rejected automated versioning (semantic-release, changesets, workflow_dispatch bumping) — machinery with no benefit at this project's one-maintainer scale.

Consequences: releasing requires only the bump, CHANGELOG entry, and tag by hand; when the snapshot is stale the workflow commits it, moves the tag, and re-runs (the moved tag's run is the one that publishes; the failed run explains itself in its error). Provenance requires a public source repository — the first trusted-publishing release (0.1.3, published while the repo was still private) shipped without an attestation; later releases carry one automatically.
