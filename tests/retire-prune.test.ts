// tests/retire-prune.test.ts — issue #134: a package-table row removal
// prunes the Snapshot immediately, with a loud removed-section in the
// refresh diff and an added/removed models statement in release notes,
// while declared-model merge semantics keep existing user configs working.
//
// End to end through the mock Command Code server (never upstream's live
// ids or values): two refresh runs (row present → row removed), then the
// pure diff + release-notes seams over the emitted modules, then the
// auto-registration merge over the pruned Snapshot.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { startMockCc } from "./helpers/mock-cc.js"
import { diffCatalogs } from "../scripts/diff-catalog.mjs"
import { buildChangelogSection } from "../scripts/release-notes.mjs"
import { autoRegister } from "../src/plugin/models.js"
import { assert, assertEqual, run } from "./harness.js"

const KEEP = "vendor/keep-model"
const RETIRE = "vendor/retire-model"

const mdRow = (id, name) =>
  `| \`${id}\` | ${name} | 1M | low | $2/$10 · cache $0.2 | Go and above | best |`

const MODELS_MD_BEFORE =
  "## Open Source\n\n" +
  "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |\n" +
  "|---|---|---|---|---|---|---|\n" +
  `${mdRow(KEEP, "Keep Model")}\n` +
  `${mdRow(RETIRE, "Retire Model")}\n`

const MODELS_MD_AFTER =
  "## Open Source\n\n" +
  "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |\n" +
  "|---|---|---|---|---|---|---|\n" +
  `${mdRow(KEEP, "Keep Model")}\n`

const CLI_BUNDLE = (ids) =>
  `const models={${ids
    .map((id, i) => `M${i}:{name:"${id}",id:"${id}",inputModalities:["text"],contextWindow:1e6}`)
    .join(",")}}`

const API_MODELS = {
  object: "list",
  data: [
    { id: KEEP, name: "Keep Model", context_length: 1000000 },
    { id: RETIRE, name: "Retire Model", context_length: 1000000 },
  ],
}

const OPTIONS = {
  npm: "opencode-cmd-provider",
  name: "Command Code",
  baseURL: "https://api.commandcode.ai",
}

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

function scriptEnv(mock: { url: string }) {
  return {
    ...process.env,
    COMMANDCODE_API_BASE: mock.url,
    COMMANDCODE_REGISTRY_URL: `${mock.url}/registry`,
    COMMANDCODE_FACTS_URL: `${mock.url}/models.md`,
    COMMANDCODE_MODALITIES_URL: `${mock.url}/cli.mjs`,
    COMMANDCODE_RSC_GOAT_URL: `${mock.url}/docs/plans/goat`,
    COMMANDCODE_RSC_PRO_URL: `${mock.url}/docs/plans/pro`,
    COMMANDCODE_MODELS_PAGE_URL: `${mock.url}/models-page.html`,
    COMMANDCODE_MODELS_DETAIL_URL: `${mock.url}/model-detail`,
  }
}

/** One snapshot refresh against a synthetic package table; own dir per run. */
async function refreshOnce(factsMd: string) {
  const dir = await mkdtemp(join(tmpdir(), "cc-retire-"))
  const out = join(dir, "snapshot.ts")
  const factsOut = join(dir, "facts.ts")
  const mock = await startMockCc({
    models: API_MODELS,
    registry: { "dist-tags": { latest: "9.9.9" } },
    factsMd,
    modalitiesBundle: CLI_BUNDLE([KEEP, RETIRE]),
  })
  try {
    const result = await runScript(
      ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", factsOut],
      scriptEnv(mock),
    )
    assertEqual(result.status, 0, result.stderr || result.stdout)
    const mod = await import(out)
    return { dir, rows: mod.MODEL_SNAPSHOT, stdout: result.stdout }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  } finally {
    await mock.close()
  }
}

run([
  [
    "retire-prune end to end: row removal prunes the Snapshot; diff is loud; release notes state it; declared configs survive",
    async () => {
      const before = await refreshOnce(MODELS_MD_BEFORE)
      const after = await refreshOnce(MODELS_MD_AFTER)
      try {
        // 1. The removed row vanishes from the next Snapshot immediately.
        assertEqual(
          before.rows.map((m) => m.id).sort(),
          [KEEP, RETIRE].sort(),
          "before: both models ship",
        )
        assertEqual(
          after.rows.map((m) => m.id),
          [KEEP],
          "after: the removed row is pruned from the Snapshot",
        )

        // 2. The refresh diff carries the loud removed-section + table row.
        const md = diffCatalogs({ kind: "snapshot", before: before.rows, after: after.rows })
        assert(
          md.includes("### Removed models (1)"),
          `must render the loud removed-section, got: ${md}`,
        )
        const removedBullet = md
          .split("\n")
          .find((line) => line.trimStart().startsWith("-") && line.includes(`\`${RETIRE}\``))
        assert(
          removedBullet && removedBullet.includes("Retire Model"),
          `the removed-section must name the model, got: ${md}`,
        )
        assert(
          md.split("\n").some((line) => {
            if (!line.trimStart().startsWith("|")) return false
            const cells = line
              .split("|")
              .slice(1, -1)
              .map((c) => c.trim())
            return cells[0] === `\`${RETIRE}\`` && cells[1] === "removed"
          }),
          `must keep the removed table row, got: ${md}`,
        )

        // 3. Release notes state the removed model.
        const prBody = [
          "## Catalog refresh — 2026-09-06",
          "",
          "### Changed files",
          "",
          "```",
          " src/catalog/snapshot.ts | 1 -",
          "```",
          "",
          "### Model catalog",
          "",
          md,
          "---",
          "",
          "_Auto-generated by the `catalog-refresh` workflow. Review and merge._",
          "",
        ].join("\n")
        const notes = buildChangelogSection({
          version: "9.9.10",
          date: "2026-09-06",
          prBody,
        })
        assert(
          notes.split("\n").some((line) => {
            if (!line.trimStart().startsWith("|")) return false
            const cells = line
              .split("|")
              .slice(1, -1)
              .map((c) => c.trim())
            return cells[0] === `\`${RETIRE}\`` && cells[1] === "removed"
          }),
          `release notes must state the removed model, got: ${notes}`,
        )
        assert(
          notes.includes("### Removed models (1)"),
          `release notes must keep the loud removed-section, got: ${notes}`,
        )

        // 4. Declared-model merge semantics: a user config referencing the
        // retired id keeps working against the pruned Snapshot.
        const config = {
          provider: {
            commandcode: {
              models: {
                "my-retired": {
                  id: RETIRE,
                  name: "My Retired",
                  limit: { context: 999, output: 999 },
                },
              },
            },
          },
        }
        autoRegister(config, after.rows, OPTIONS)
        const entry = config.provider.commandcode
        assertEqual(
          entry.models["my-retired"],
          {
            id: RETIRE,
            name: "My Retired",
            limit: { context: 999, output: 999 },
          },
          "the declared retired entry must survive the prune untouched",
        )
        assert(
          entry.models[KEEP] !== undefined,
          "the surviving snapshot model must still auto-register",
        )
        assert(
          entry.models[RETIRE] === undefined,
          "the pruned id must not auto-register under its own key",
        )
      } finally {
        await rm(before.dir, { recursive: true, force: true })
        await rm(after.dir, { recursive: true, force: true })
      }
    },
  ],
])
