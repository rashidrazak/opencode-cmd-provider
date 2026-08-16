# Tag-driven releases via GitHub Actions

Status: accepted

Releases are cut by pushing a `vX.Y.Z` tag: a GitHub Actions workflow asserts the tag matches `package.json`, runs the full suite and build, regenerates the catalog snapshot and **fails if it drifted**, publishes to npm via OIDC trusted publishing (provenance automatic, `beta` dist-tag for prereleases), and creates the GitHub Release from the CHANGELOG section.

`package.json` stays the single source of truth for the version, and a human stays in control of what ships: version bump, CHANGELOG entry, and snapshot refresh happen before tagging. We rejected automated versioning (semantic-release, changesets, workflow_dispatch bumping) — machinery with no benefit at this project's one-maintainer scale. The snapshot-freshness guard exists because a stale model catalog is the one failure mode that tests and builds cannot catch: the code would be perfect while the shipped snapshot silently lags the live catalog.

Consequences: releasing requires the pre-tag steps to be done by hand; the workflow refuses stale snapshots rather than publishing them. Provenance requires a public source repository — the first trusted-publishing release (0.1.3, published while the repo was still private) shipped without an attestation; later releases carry one automatically.
