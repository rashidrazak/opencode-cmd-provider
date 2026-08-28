// tests/capture-rsc-fixtures.test.ts — seam: scripts/capture-rsc-fixtures.mjs.
// Spawns the script with the RSC env vars pointed at the in-process mock
// Command Code server and asserts the three payloads land in the fixtures
// dir verbatim — and that a 4xx aborts the run without touching the
// committed fixtures (all-or-nothing).
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { startMockCc } from "./helpers/mock-cc.js"
import { assert, assertEqual, run } from "./harness.js"

const RSC_PRICING = readFileSync(
  new URL("./fixtures/rsc-pricing-limits.txt", import.meta.url),
  "utf-8",
)
const RSC_GOAT = readFileSync(new URL("./fixtures/rsc-goat.txt", import.meta.url), "utf-8")
const RSC_PRO = readFileSync(new URL("./fixtures/rsc-pro.txt", import.meta.url), "utf-8")

function runScript(args, env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

const RSC_ENV = (mock: { url: string }) => ({
  ...process.env,
  COMMANDCODE_RSC_PRICING_URL: `${mock.url}/docs/resources/pricing-limits`,
  COMMANDCODE_RSC_GOAT_URL: `${mock.url}/docs/plans/goat`,
  COMMANDCODE_RSC_PRO_URL: `${mock.url}/docs/plans/pro`,
})

run([
  [
    "capture-rsc-fixtures writes the three RSC payloads to the fixtures dir",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-capture-rsc-"))
      const mock = await startMockCc({
        rscPricing: RSC_PRICING,
        rscGoat: RSC_GOAT,
        rscPro: RSC_PRO,
      })
      try {
        const result = await runScript(
          ["scripts/capture-rsc-fixtures.mjs", "--fixtures-dir", dir],
          RSC_ENV(mock),
        )
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assertEqual(
          await readFile(join(dir, "rsc-pricing-limits.txt"), "utf-8"),
          RSC_PRICING,
          "pricing payload must be captured verbatim",
        )
        assertEqual(
          await readFile(join(dir, "rsc-goat.txt"), "utf-8"),
          RSC_GOAT,
          "goat payload must be captured verbatim",
        )
        assertEqual(
          await readFile(join(dir, "rsc-pro.txt"), "utf-8"),
          RSC_PRO,
          "pro payload must be captured verbatim",
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
  [
    "capture-rsc-fixtures is all-or-nothing: a 4xx aborts and writes nothing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-capture-rsc-404-"))
      // Pricing endpoint unset → the mock serves 404 for it. Goat and
      // pro succeed — the script must still abort without writing a
      // partial fixture set.
      const mock = await startMockCc({ rscGoat: RSC_GOAT, rscPro: RSC_PRO })
      try {
        const result = await runScript(
          ["scripts/capture-rsc-fixtures.mjs", "--fixtures-dir", dir],
          RSC_ENV(mock),
        )
        assert(
          result.status !== 0,
          `4xx must abort the capture, got status ${result.status}: ${result.stdout} ${result.stderr}`,
        )
        assert(
          result.stderr.includes("HTTP 404") || result.stderr.includes("returned HTTP"),
          `stderr must attribute the 4xx, got: ${result.stderr}`,
        )
        const files = await readdir(dir)
        assertEqual(files.length, 0, `no fixture file may be written, got: ${files.join(", ")}`)
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
])
