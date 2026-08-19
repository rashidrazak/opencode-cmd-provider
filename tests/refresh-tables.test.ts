// tests/refresh-tables.test.ts — refresh script --tables integration
// Runs the real script against the mock catalog endpoint and a fixture CLI
// bundle (no network), then asserts both source tables were rewritten.
import { mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { startMockCc } from "./helpers/mock-cc.js"
import { assert, assertEqual, run } from "./harness.js"

const MODELS_PAYLOAD = {
  object: "list",
  data: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 200000 },
    { id: "zai-org/GLM-5.3", name: "GLM-5.3", context_length: 1000000 },
  ],
}

// Fixture emulating the minified catalog shape in command-code's dist/cli.mjs:
// the effort-less model comes first so the test also guards the lookahead bug.
const CLI_BUNDLE = [
  'const CAT={KIMI:{id:"claude-sonnet-5",inputModalities:["text","image"],provider:FA,spec:JA,label:"Sonnet",contextWindow:2e5},',
  'GLM:{id:"zai-org/GLM-5.3",inputModalities:["text"],provider:KA,spec:JA,reasoning:!0,reasoningEfforts:["low","high","max"],contextWindow:1e6}}',
  "",
].join("")

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

run([
  [
    "refresh-snapshot --cli-js rewrites both tables in place",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-refresh-tables-"))
      const repoRoot = join(import.meta.dirname, "..")
      const scriptPath = join(repoRoot, "scripts", "refresh-snapshot.mjs")
      const cliFixture = join(dir, "cli.mjs")
      await writeFile(cliFixture, CLI_BUNDLE, "utf-8")

      // Copy the real source files into the sandbox so the script rewrites the
      // copies, not the working tree.
      const reasoningOut = join(dir, "reasoning.ts")
      const modalitiesOut = join(dir, "modalities.ts")
      await cp(join(repoRoot, "src", "provider", "reasoning.ts"), reasoningOut)
      await cp(join(repoRoot, "src", "provider", "modalities.ts"), modalitiesOut)

      const mock = await startMockCc({ models: MODELS_PAYLOAD })
      try {
        const result = await runScript(
          [
            scriptPath,
            "--out",
            join(dir, "snapshot.ts"),
            "--cli-js",
            cliFixture,
            // Point the table rewrite at the sandbox copies.
            "--reasoning-out",
            reasoningOut,
            "--modalities-out",
            modalitiesOut,
          ],
          {
            ...process.env,
            COMMANDCODE_API_BASE: mock.url,
            COMMANDCODE_CLI_VERSION_LABEL: "1.28.1-test",
          },
        )
        assert(result.status === 0, result.stderr || result.stdout)

        const reasoning = await readFile(reasoningOut, "utf-8")
        assert(reasoning.includes('"zai-org/GLM-5.3": ["low", "high", "max"]'), reasoning)
        assert(!reasoning.includes('"claude-sonnet-5": ['), "effort-less model must not be listed")
        assert(
          reasoning.includes("command-code@1.28.1-test"),
          "doc comment must carry the CLI version label",
        )

        const modalities = await readFile(modalitiesOut, "utf-8")
        assert(modalities.includes('"claude-sonnet-5": ["text", "image"]'), modalities)
        assert(!modalities.includes('"zai-org/GLM-5.3": ["text", "image"]'), modalities)

        // The rest of each file must survive the rewrite untouched.
        assert(modalities.includes("export function modelSupportsImageInput"), modalities)
        assert(reasoning.includes("export function thinkingMetadataForModel"), reasoning)
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
])
