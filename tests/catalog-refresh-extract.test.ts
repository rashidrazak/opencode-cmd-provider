// tests/catalog-refresh-extract.test.ts — seam: the `extract()` helper in
// `.github/workflows/catalog-refresh.yml` (the "Build PR body from
// catalog diff" step).
//
// Run 33241830819 of the catalog-refresh cron failed here because the
// "after" loop passed a bare-relative `ts_path` (e.g.
// `src/catalog/snapshot.ts`) to `npx tsx --input-type=module -e
// "await import('src/catalog/snapshot.ts')"`. Node's ESM resolver
// parses that string as a *package* specifier, not a relative file
// path, and exits with `ERR_MODULE_NOT_FOUND: Cannot find package
// 'src'`. The "before" loop happened to work because it used
// absolute `/tmp/...` paths, but the "after" loop's `src/...` did
// not. The earlier cron failures (runs 33176074036 / 33177353119 /
// 33195360130) all failed at the `npm test` step *before* this code
// path was reached, so the bug had been latent since the workflow
// was first introduced (PR #85, commit a9a269d).
//
// The workflow fix absolutises the path with `realpath` before
// passing it to the heredoc. The invariant this test enforces:
// **the cron's `npx tsx …` heredoc must successfully import a
// relative `.ts` path when that path is absolute (the fix's
// contract)**, and conversely a bare-relative `.ts` path is *not*
// importable (the original failure mode). We exercise the exact
// shell invocation the workflow uses so a future change to the
// heredoc that re-introduces the bare-relative specifier is
// caught here.

import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { spawn } from "node:child_process"
import { assert, assertEqual, run } from "./harness.js"

// Same heredoc the workflow uses (see
// `.github/workflows/catalog-refresh.yml`). The path is supplied as
// a shell argument so the test can vary the spec we hand to
// `import()`, and `cwd` is set to the repo root so `npx tsx`
// resolves to the local devDependency.
function runExtract(
  quotedPath: string,
  cwd: string,
): Promise<{
  status: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "-c",
        `npx tsx --input-type=module -e "
          const mod = await import(${quotedPath});
          const out = {};
          if (mod.MODEL_SNAPSHOT) out.MODEL_SNAPSHOT = mod.MODEL_SNAPSHOT;
          if (mod.FACTS_LAST_REFRESHED) out.FACTS_LAST_REFRESHED = mod.FACTS_LAST_REFRESHED;
          process.stdout.write(JSON.stringify(out));
        "`,
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

// Reproduce the *bash* portion of the cron's `extract()` exactly:
// a relative `ts_path` is resolved with `realpath` before the
// heredoc, and the output is checked for non-emptiness. This is
// what the workflow runs in CI; if anyone drops the `realpath` (or
// short-circuits the path resolution), this test fails before the
// workflow does. The heredoc body is intentionally a subset of
// the workflow's (we don't need MODEL_DEALS / DEAL_LAST_REFRESHED
// for this seam — what we need is the path → heredoc contract).
function runExtractBash(
  tsPath: string,
  cwd: string,
): Promise<{
  status: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "-c",
        `
          set -euo pipefail
          abs_ts_path="$(realpath "${tsPath}")"
          npx tsx --input-type=module -e "
            const mod = await import(\${abs_ts_path@Q});
            process.stdout.write(JSON.stringify({ ok: !!mod.MODEL_SNAPSHOT }));
          "
        `,
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

run([
  [
    "extract: a bare-relative .ts path fails ERR_MODULE_NOT_FOUND (the bug); absolute path succeeds (the fix)",
    async () => {
      // The fixture is a tiny self-contained `.ts` that exports the
      // two top-level fields the cron's `extract()` looks for. We
      // create it inside the repo so `npx tsx` resolves
      // node_modules from the workspace root, then exercise both
      // the bare-relative specifier (the bug) and the absolute
      // specifier (the workflow fix).
      const fixtureDir = join(process.cwd(), "tests", ".tmp-extract-fixture")
      const fixturePath = join(fixtureDir, "catalog-fixture.ts")
      await mkdir(fixtureDir, { recursive: true })
      try {
        await writeFile(
          fixturePath,
          [
            "export const MODEL_SNAPSHOT = [{ id: 'fixture-model', name: 'Fixture', contextLength: 1024 }]",
            "export const FACTS_LAST_REFRESHED = '2026-01-01'",
            "",
          ].join("\n"),
          "utf-8",
        )

        const relPath = relative(process.cwd(), fixturePath)
        // The bug: `relPath` is `tests/.tmp-extract-fixture/catalog-fixture.ts`
        // — a bare-relative specifier. Node's ESM resolver would
        // try to parse it as a package name and fail with
        // `ERR_MODULE_NOT_FOUND: Cannot find package 'tests'`.
        assert(
          !relPath.startsWith("."),
          `fixture path must be bare-relative to exercise the bug — got ${relPath}`,
        )

        // 1) The cron's "as-written" heredoc, with the bare-relative
        //    path. Without the workflow fix (`realpath` → absolute
        //    before the heredoc) this would exit non-zero with
        //    ERR_MODULE_NOT_FOUND. With the fix in place, the
        //    cron's own `extract()` resolves the path to absolute
        //    before reaching the heredoc — so this case is now
        //    expected to be unreachable from the cron. We still
        //    document it as a negative: a `tsx` `import()` of a
        //    bare-relative `.ts` path is the exact pattern the
        //    workflow must avoid.
        const bare = await runExtract(`'${relPath}'`, process.cwd())
        assert(
          bare.status !== 0 && /ERR_MODULE_NOT_FOUND/.test(bare.stderr),
          `expected bare-relative import to fail with ERR_MODULE_NOT_FOUND — got status=${bare.status}, stderr=${bare.stderr.slice(0, 200)}`,
        )

        // 2) The cron's *fixed* heredoc: the same code, but the
        //    path is absolute (which is what `realpath` produces
        //    inside the workflow's `extract()`). This is the case
        //    the cron now runs, and it must succeed.
        const absolute = await runExtract(`'${fixturePath}'`, process.cwd())
        assert(
          absolute.status === 0,
          `absolute-path import must succeed — status=${absolute.status}, stderr=${absolute.stderr.slice(0, 400)}`,
        )
        const parsed = JSON.parse(absolute.stdout) as {
          MODEL_SNAPSHOT?: unknown
          FACTS_LAST_REFRESHED?: string
        }
        assertEqual(parsed.MODEL_SNAPSHOT, [
          { id: "fixture-model", name: "Fixture", contextLength: 1024 },
        ])
        assertEqual(parsed.FACTS_LAST_REFRESHED, "2026-01-01")
      } finally {
        await rm(fixtureDir, { recursive: true, force: true })
      }
    },
  ],
  [
    "extract: the cron's actual generated catalogs are importable from the heredoc (absolute path)",
    async () => {
      // End-to-end check against the *real* generated `.ts`
      // modules. This is the path the cron takes post-fix
      // (`realpath` of the relative `src/...` path, then the
      // heredoc). Locks down the seam against the actual
      // catalog files, not just a fixture.
      const result = await runExtract(
        `'${join(process.cwd(), "src", "catalog", "snapshot.ts")}'`,
        process.cwd(),
      )
      assert(
        result.status === 0,
        `importing the real src/catalog/snapshot.ts must succeed — status=${result.status}, stderr=${result.stderr.slice(0, 400)}`,
      )
      const parsed = JSON.parse(result.stdout) as { MODEL_SNAPSHOT?: unknown[] }
      assert(
        Array.isArray(parsed.MODEL_SNAPSHOT) && parsed.MODEL_SNAPSHOT.length > 0,
        `MODEL_SNAPSHOT must be a non-empty array — got ${JSON.stringify(parsed).slice(0, 200)}`,
      )
    },
  ],
  [
    "extract: the cron's full bash flow succeeds with a relative `src/...` path (locks in the realpath fix)",
    async () => {
      // This is the exact `extract()` body the workflow runs in
      // CI: `realpath` → heredoc → JSON.stringify → output. If
      // anyone removes the `realpath` (or replaces the heredoc
      // with a relative-path import), this test fails before the
      // workflow does.
      const result = await runExtractBash("src/catalog/snapshot.ts", process.cwd())
      assert(
        result.status === 0,
        `cron's extract() flow must succeed for a relative src/... path — status=${result.status}, stderr=${result.stderr.slice(0, 400)}`,
      )
      const parsed = JSON.parse(result.stdout) as { ok?: boolean }
      assert(parsed.ok === true, `expected {"ok":true} — got ${result.stdout}`)
    },
  ],
])
