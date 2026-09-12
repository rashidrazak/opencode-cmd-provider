// tests/secretlint-config.test.ts — the Command Code key gate must stay both
// live and quiet. Runs the real secretlint CLI against `.secretlintrc.json`, so
// the config shape is exercised rather than re-implemented: a key-shaped
// literal has to fail, the documented placeholder has to pass, and the
// repository has to pass as it stands (the test fixtures are allowlisted by
// value in the config, so a new sentinel surfaces here rather than only in CI).
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { run, assert, assertEqual } from "./harness.js"

const repoRoot = resolve(import.meta.dirname, "..")
const secretlint = join(repoRoot, "node_modules", ".bin", "secretlint")
const hasSecretlint = existsSync(secretlint)

function scan(...targets: string[]): { status: number | null; output: string } {
  const result = spawnSync(secretlint, [...targets, "--no-color"], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 120_000,
  })
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-secretlint-"))
  const file = join(dir, name)
  writeFileSync(file, content)
  return file
}

run([
  [
    "secretlint reports a Command Code key shape",
    () => {
      if (!hasSecretlint) return console.log("skip - secretlint is not installed")
      // Assembled at runtime: this file must not itself contain the shape it
      // asserts on, or the gate would (correctly) report it.
      const key = "user_" + "0123456789abcdef0123456789abcdef"
      const leak = tempFile("leak.ts", `export const apiKey = "${key}"\n`)
      const { status, output } = scan(leak)
      assert(status !== 0, `a string shaped like a Command Code key must fail the scan:\n${output}`)
    },
  ],
  [
    "secretlint accepts the documented placeholder",
    () => {
      if (!hasSecretlint) return console.log("skip - secretlint is not installed")
      const snippet = tempFile("readme.sh", 'export COMMANDCODE_API_KEY="user_..."\n')
      const { status, output } = scan(snippet)
      assertEqual(status, 0, `the documented placeholder is not key material:\n${output}`)
    },
  ],
  [
    "secretlint passes the repository as it stands",
    () => {
      if (!hasSecretlint) return console.log("skip - secretlint is not installed")
      const { status, output } = scan("**/*")
      assertEqual(status, 0, `the tree reports findings the gate would fail on:\n${output}`)
    },
  ],
])
