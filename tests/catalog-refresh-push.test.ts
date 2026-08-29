// tests/catalog-refresh-push.test.ts — seam: the `Push branch` step in
// `.github/workflows/catalog-refresh.yml`.
//
// Run 33245295616 of the catalog-refresh cron failed at `Push branch`
// with `non-fast-forward` because the previous run (33244771701) had
// already pushed `catalog-refresh/2026-08-29` with a sibling commit
// (both runs sit on the same `main` HEAD, so the local commit is not
// a descendant of the remote tip). The workflow's `git push -u`
// rejected the push, the `Open PR` step was skipped, and the cron
// was stuck. The fix is to force-push (`git push -fu`), which the
// `Open PR` step already handles correctly (it does `gh pr list`
// first, and either creates a new PR or updates an existing one —
// both paths work with a force-pushed tip).
//
// The seam this test locks down: when the cron is re-run after a
// partial failure (a previous run that pushed the branch but failed
// later), the push must succeed. We exercise this against a local
// bare repository that stands in for `origin` — the workflow's
// exact `git push -fu origin "${branch}"` command, run twice in
// sequence with different sibling commits on the same base. If
// anyone reverts the `-f` flag (e.g. back to `git push -u`), the
// second invocation rejects and this test fails.

import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { assert, run } from "./harness.js"

const exec = promisify(execFile)

interface Repo {
  /** Local "remote" (bare). */
  remote: string
  /** Working clone with two test branches on the same base. */
  work: string
  /** Cleanup. */
  cleanup: () => Promise<void>
}

async function setupRepos(): Promise<Repo> {
  const base = await mkdtemp(join(tmpdir(), "cc-cron-push-"))
  const remote = join(base, "remote.git")
  const work = join(base, "work")
  await exec("git", ["init", "--bare", "-q", remote])
  await exec("git", ["init", "-q", "-b", "main", work])
  // Author identity so commits don't fail in CI's bare env.
  await exec("git", ["-C", work, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", work, "config", "user.name", "Test"])
  await exec("git", ["-C", work, "config", "commit.gpgsign", "false"])
  await exec("git", ["-C", work, "remote", "add", "origin", remote])
  // Seed an initial commit on main and push it (this is the
  // `origin/main` HEAD the cron's two runs will both branch from).
  await exec("git", ["-C", work, "commit", "--allow-empty", "-q", "-m", "seed main"])
  await exec("git", ["-C", work, "push", "-q", "origin", "main"])
  return {
    remote,
    work,
    cleanup: async () => await rm(base, { recursive: true, force: true }),
  }
}

async function commitAndPushFromBase(
  repo: Repo,
  branch: string,
  message: string,
  force: boolean,
): Promise<void> {
  // Each invocation: create a new branch off the current `main`
  // tip (mimicking a fresh cron run that re-checks-out the same
  // main HEAD) and push it. With `force: false` this is exactly
  // the workflow's pre-fix `git push -u origin "${branch}"`; with
  // `force: true` it's the post-fix `git push -fu origin "${branch}"`.
  //
  // We force-delete any pre-existing local branch (the cron starts
  // from a clean `actions/checkout@v4` so the local branch is
  // always fresh; in the test fixture it can persist between
  // invocations of `commitAndPushFromBase`).
  await exec("git", ["-C", repo.work, "checkout", "-q", "main"])
  await exec("git", ["-C", repo.work, "branch", "-q", "-D", branch]).catch(() => {
    // Branch didn't exist — first push.
  })
  await exec("git", ["-C", repo.work, "checkout", "-q", "-b", branch])
  await exec("git", ["-C", repo.work, "commit", "--allow-empty", "-q", "-m", message])
  const pushArgs = ["push", "-q"]
  if (force) pushArgs.push("-f")
  pushArgs.push("-u", "origin", branch)
  await exec("git", ["-C", repo.work, ...pushArgs])
}

run([
  [
    "push: re-run with the same branch name and a sibling commit succeeds with the cron's -fu (post-fix)",
    async () => {
      // This is the post-fix behaviour: the cron's `git push -fu`
      // handles a re-run where the remote branch already has a
      // sibling commit from a previous run. We exercise the exact
      // `-fu` flag pattern, twice in sequence, and assert both
      // pushes succeed.
      const repo = await setupRepos()
      try {
        // First "cron run" — branch is fresh, push succeeds.
        await commitAndPushFromBase(repo, "catalog-refresh/2026-08-29", "first-run commit", true)
        // Second "cron run" — same branch name, new sibling
        // commit. Pre-fix this would fail with non-fast-forward;
        // post-fix (-fu) it succeeds.
        await commitAndPushFromBase(
          repo,
          "catalog-refresh/2026-08-29",
          "second-run commit (re-run after partial failure)",
          true,
        )
        // The remote tip should now be the second commit, not the
        // first. Verify by listing the remote ref.
        const { stdout } = await exec("git", [
          "ls-remote",
          "origin",
          "refs/heads/catalog-refresh/2026-08-29",
        ])
        assert(
          /^[0-9a-f]{40}\s+refs\/heads\/catalog-refresh\/2026-08-29$/.test(stdout.trim()),
          `remote ref must point at catalog-refresh/2026-08-29 — got ${stdout.trim()}`,
        )
      } finally {
        await repo.cleanup()
      }
    },
  ],
  [
    "push: re-run WITHOUT the cron's -fu (pre-fix) is rejected with non-fast-forward (documents the bug)",
    async () => {
      // This case documents the *original* failure mode: a
      // re-run with the pre-fix `git push -u` (no `-f`) cannot
      // fast-forward a sibling commit and is rejected. We assert
      // it fails so a future regression that drops the `-f` is
      // caught: the previous test must keep passing; if anyone
      // removes the `-f`, this test still fails as expected (and
      // the previous test would also fail in CI).
      const repo = await setupRepos()
      try {
        await commitAndPushFromBase(repo, "catalog-refresh/2026-08-29", "first-run commit", false)
        let rejected = false
        try {
          await commitAndPushFromBase(
            repo,
            "catalog-refresh/2026-08-29",
            "second-run commit",
            false,
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // The exact git message varies slightly across versions
          // ("! [rejected] ... (non-fast-forward)" / "fetch first"
          // / "tip of your current branch is behind") — match on
          // the stable substring `non-fast-forward`, which git has
          // emitted for this scenario since at least 2.20.
          assert(
            /non-fast-forward/.test(msg),
            `expected non-fast-forward rejection — got: ${msg.slice(0, 300)}`,
          )
          rejected = true
        }
        assert(rejected, "pre-fix push (no -f) must be rejected on a re-run with a sibling commit")
      } finally {
        await repo.cleanup()
      }
    },
  ],
])
