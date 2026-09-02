# ADR-0007: Auto-release — merging a Catalog refresh PR is the tag ceremony

Status: accepted

The tag-driven release ritual (ADR-0002) required the maintainer to hand-perform
the pre-tag steps — version bump, lockfile sync, CHANGELOG entry, tag — after
every merged catalog-refresh PR. That meant the published npm package kept its
old bundled catalog until the ritual was performed: the "prices accurate within
a day" story only ever applied to `main`, not to what users have installed.

The decision: **merging a meaningful Catalog refresh PR is the release
ceremony**. A small workflow (`.github/workflows/auto-release.yml`) fires on
merged PRs from `catalog-refresh/*` head branches and performs **only the
pre-tag ritual**: patch-bumps the version, syncs the lockfile via npm
(`npm version --no-git-tag-version` + `npm install --package-lock-only` — never
hand-editing the lockfile), prepends a `## X.Y.Z - date` CHANGELOG section
authored from the merged PR body's semantic sections
(`scripts/release-notes.mjs`), commits `chore(release): X.Y.Z` as the bot on
main, and tags `vX.Y.Z` on that commit. The existing tag-driven pipeline then
does everything else — build, full suite, stale-catalog gates, npm publish via
OIDC trusted publishing, GitHub Release from the CHANGELOG section — unchanged.
**One publish path** (ADR-0002 intact): the automation performs the pre-tag
ritual only; nothing here publishes by itself.

## Safety rails

- **Trigger filter.** Fires only on `pull_request` `closed` events where the
  PR is merged and the head branch starts with `catalog-refresh/` — the same
  branches the catalog-refresh cron creates (same-repo branches, so the
  closed event runs in the base repo context).
- **Label opt-out.** A `skip-release` label on the merged PR suppresses the
  release for that refresh (bundling a refresh with a larger manual release).
- **Tag-existence skip.** When a `vX.Y.Z` tag for the computed version
  already exists, the run skips entirely — no commit, no tag, loud warning —
  so a race with a manual release can never double-publish or mis-tag.
- **Concurrency-serialized.** One auto-release run at a time.
- **No full-suite re-run at bump time.** The PR's required green CI covered
  the identical tree; the bump commit touches only version metadata and the
  CHANGELOG. The tag-triggered pipeline re-runs the full suite anyway.

## Trust model

The branch-protection bypass that enables merge-to-publish is safe under
explicitly documented conditions. This section records them so future changes
are judged against them rather than rediscovered.

- **The bypass is actor-scoped to the workflow bot identity, never to
  humans.** Human review and the required `test` check on main are unchanged
  for every person.
- **Contributors are not collaborators.** Contributing grants no persistent
  role; fork PRs run with a read-only token and cannot push, dispatch, or
  merge. The auto-release fires only for merged PRs from catalog-refresh
  branches, and only the maintainer can merge into protected main.
- **The publish path funnels exclusively through the maintainer's merge.**
  A write collaborator could manually dispatch the catalog-refresh workflow,
  but that only opens a PR; release begins at merge.
- **Untrusted input handling.** The merged PR body is upstream-derived data.
  It is passed as a file (env → `pr-body.md` → `scripts/release-notes.mjs`
  reading it as data), never interpolated into run scripts; the version and
  tag are computed locally from `package.json`, never parsed from the PR.
- **Vetted `contents: write` workflows** (re-verify whenever workflows
  change): the catalog-refresh workflow (pushes `catalog-refresh/*` branches
  only), the tag-driven release workflow, and this auto-release workflow
  (bump commit + tag). The bypass is actor-scoped, not path-scoped — GitHub
  cannot express "bot may only push version metadata" — so **any new
  workflow that pushes to main is an ADR-level decision** and must be added
  to this vetted set explicitly.
- **Pre-existing residual risk, unchanged by this design:** a compromised
  upstream npm package could poison catalog data at refresh time regardless
  of the bypass; the detection layer is PR review of the generated diffs
  plus the release pipeline's full suite and stale-catalog gates.

## Repo-settings prerequisite

`main` is protected by two **rulesets** (note: classic branch protection is
*not* configured — the legacy "branch protection" API reports "Branch not
protected"; rulesets are the active mechanism, verified 2026-09-02):

- **`main-review`** — requires a pull request with 1 approving review and
  resolved threads. Its bypass list already contains the maintainer identity
  (mode: always), which is what lets the auto-release's authenticated push
  through the review requirement.
- **`main-hard-rules`** — requires the `test` status check (strict),
  forbids non-fast-forward pushes and deletion. Its bypass list is **empty**.

The auto-release's bump commit does not carry a `test` status at push time
(it changes only version metadata and the CHANGELOG, and the status check
runs on PR heads, not on workflow pushes), so **`main-hard-rules` rejects
the push** until the pushing identity is added to that ruleset's bypass
list (Settings → Rules → Rulesets → `main-hard-rules` → Bypass list → the
identity matching the push credential's actor — the maintainer user for a
PAT, the App for an App token). This is an actor-scoped exemption exactly
as the trust model above requires; human pushes to `main` remain
review-gated for everyone else. Rejected alternative: a bot-opened release
PR needing one more human approval — it defeats "merge = publish".

## Workflow-trigger prerequisite

A push made with the default `GITHUB_TOKEN` does **not** start other workflow
runs (GitHub's recursive-event rule) — including the tag-driven release
pipeline. The tag push therefore uses the `RELEASE_PUSH_TOKEN` secret when
the maintainer has provided one: a fine-grained PAT or GitHub App token
restricted to **this repository only**, `contents: write`, held as a repo
secret and consumed only by the push step of this vetted workflow. Without
that secret the bump commit and tag still land, but `release.yml` must be
started manually (re-tag or dispatch) — a loud, visible shortfall rather
than a second publish path. Adding the secret is part of the rollout, and
the token joins the vetted-credential set enumerated in the trust model
above; any change to how the push is authenticated is an ADR-level
decision.
