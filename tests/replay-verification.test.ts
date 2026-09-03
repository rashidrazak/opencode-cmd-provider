// tests/replay-verification.test.ts — end-to-end replay of the
// 2026-08-28 → 09-02 upstream event history through the new pipeline
// (issue #116, the acceptance anchors of spec #108).
//
// Each upstream event class is replayed against a synthetic upstream
// world (never upstream's current values): the full refresh ladder —
// snapshot/facts regeneration, RSC fixture capture, classification
// generation, deals generation — runs green, the PR body renders the
// semantic change, and no runtime source requires a hand edit. The
// date-only-churn replay (PR #103) produces no PR at all, and the
// merge-to-release chain (synthetic PR body → bump commit → tag) is
// demonstrated with the release pipeline untouched.
//
// Event classes from the failure taxonomy:
//   1. hy4-preview efforts promotion      (2026-08-28, facts/Efforts)
//   2. v4-flash-fast efforts promotion    (2026-08-31, facts/Efforts)
//   3. Kimi-K3 efforts promotion          (2026-09-02, facts/Efforts)
//   4. MiniMax M3 free retirement         (2026-09-01, model retirement —
//      replayed on poolside/laguna-s-2.1-free, the free variant still in
//      today's Snapshot; the M3 free variant already left the committed
//      catalog when the retirement was absorbed)
//   5. Gemini 3.7 Flash deal end          (deals/discount)
import { execFile } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { startMockCc } from "./helpers/mock-cc.js"
import { snapshotIndex } from "../scripts/snapshot-index.mjs"
import { deriveReasoningWithoutEfforts } from "../src/provider/reasoning.js"
import { assert, assertEqual, run } from "./harness.js"

const exec = promisify(execFile)
const TODAY = new Date().toISOString().split("T")[0]

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

// ---------------------------------------------------------------------------
// Synthetic upstream worlds (full coverage of the real Snapshot ids, so the
// coverage gates stay ON and green).
// ---------------------------------------------------------------------------

const EFFORTS_PROMOTIONS = new Map([
  ["tencent/hy4-preview", "low, medium, high"],
  ["deepseek/deepseek-v4-flash-fast", "low, high, max"],
  ["moonshotai/Kimi-K3", "low, medium, high"],
])

const RETIRED_FREE_VARIANT = "poolside/laguna-s-2.1-free"
const GEMINI_ID = "google/gemini-3.7-flash"

interface WorldOptions {
  effortsPromoted?: boolean
  geminiDeal?: boolean
  retireFreeVariant?: boolean
}

/**
 * The snapshot-world model list: every real Snapshot id, minus the retired
 * variant when the replay retires it. The RSC pages keep carrying the
 * retired variant (the docs lag the API), so the classification and deals
 * coverage gates stay green — exactly how the real retirement arrived.
 */
function snapshotWorldIds({ retireFreeVariant }: WorldOptions): [string, string][] {
  const { byId } = snapshotIndex()
  const entries = [...byId.entries()]
  if (retireFreeVariant) {
    return entries.filter(([id]) => id !== RETIRED_FREE_VARIANT)
  }
  return entries
}

/** The models.md facts input. Efforts promotions flip the Efforts cell. */
function modelsMd(world: WorldOptions): string {
  const rows = snapshotWorldIds(world).map(([id, name]) => {
    let efforts = "low, medium, high"
    if (EFFORTS_PROMOTIONS.has(id)) {
      efforts = world.effortsPromoted ? (EFFORTS_PROMOTIONS.get(id) as string) : "—"
    }
    return `| \`${id}\` | ${name} | 1M | ${efforts} | $2/$10 · cache $0.2 (write $2.5) | Go | best |`
  })
  return [
    "## Open Source",
    "",
    "| Id | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n")
}

/** The CLI bundle (modalities input) covering every snapshot-world model. */
function modalitiesBundle(world: WorldOptions): string {
  const entries = snapshotWorldIds(world).map(
    ([id, name]) =>
      `${JSON.stringify(id)}:{id:${JSON.stringify(id)},name:${JSON.stringify(name)},inputModalities:["text"],contextWindow:1e6}`,
  )
  return `const models={${entries.join(",")}}`
}

/** The three RSC pages. Deal events flip per-model `deal` fields. */
function rscWorld({ geminiDeal = false }: WorldOptions): {
  pricing: string
  goat: string
  pro: string
} {
  // The RSC always covers the FULL real snapshot — including a variant the
  // API already retired (the docs lag the API).
  const { byId } = snapshotIndex()
  const deals = new Map<string, Record<string, unknown>>()
  if (geminiDeal) deals.set(GEMINI_ID, { discountPercent: 50, term: "while capacity lasts" })
  const records = [...byId.entries()].map(([id, name]) => {
    const deal = deals.get(id)
    return {
      slug: id.split("/").pop() ?? id,
      id,
      name,
      vendor: id.includes("/") ? id.split("/")[0] : id,
      category: "opensource",
      minPlanName: "Go",
      tiers: [{ rates: { input: 2, output: 10, cacheRead: 0.2 } }],
      caps: { text: true, vision: false },
      reasoning: true,
      ...(deal ? { deal } : {}),
    }
  })
  // The parser's array predicate requires the first id to be
  // vendor-prefixed; rotate one to the front.
  const firstVendor = records.findIndex((r) => r.id.includes("/"))
  records.unshift(...records.splice(firstVendor, 1))
  const availability = records.map((r) => ({
    id: r.id,
    name: r.name,
    category: "opensource",
    contextWindow: 1000000,
    caps: r.caps,
    tiers: r.tiers,
    ...(r.deal ? { deal: r.deal } : {}),
  }))
  const goat = `2:${JSON.stringify(records)}\n`
  const compact = records.map((r) => ({
    id: r.id,
    name: r.name,
    planAllowanceUsd: { goat: 20, pro: 20 },
  }))
  return {
    pricing: `2:${JSON.stringify(availability)}\n2:${JSON.stringify(compact)}\n`,
    goat,
    pro: goat,
  }
}

function apiModelsPayload(world: WorldOptions): unknown {
  return {
    object: "list",
    data: snapshotWorldIds(world).map(([id, name]) => ({ id, name, context_length: 1000000 })),
  }
}

// ---------------------------------------------------------------------------
// The refresh ladder, against a mock upstream world, into a workspace.
// ---------------------------------------------------------------------------

async function runLadder(world: WorldOptions, ws: string): Promise<void> {
  const rsc = rscWorld(world)
  const mock = await startMockCc({
    models: apiModelsPayload(world),
    registry: { "dist-tags": { latest: "1.39.2" } },
    factsMd: modelsMd(world),
    modalitiesBundle: modalitiesBundle(world),
    rscPricing: rsc.pricing,
    rscGoat: rsc.goat,
    rscPro: rsc.pro,
  })
  const env = {
    ...process.env,
    COMMANDCODE_API_BASE: mock.url,
    COMMANDCODE_REGISTRY_URL: `${mock.url}/registry`,
    COMMANDCODE_FACTS_URL: `${mock.url}/models.md`,
    COMMANDCODE_MODALITIES_URL: `${mock.url}/cli.mjs`,
    COMMANDCODE_RSC_PRICING_URL: `${mock.url}/docs/resources/pricing-limits`,
    COMMANDCODE_RSC_GOAT_URL: `${mock.url}/docs/plans/goat`,
    COMMANDCODE_RSC_PRO_URL: `${mock.url}/docs/plans/pro`,
  }
  try {
    await mkdir(join(ws, "src", "catalog"), { recursive: true })
    await mkdir(join(ws, "src", "deals"), { recursive: true })
    await mkdir(join(ws, "fixtures"), { recursive: true })
    // Leg 1: snapshot + facts from the live catalog.
    const snapshot = await runScript(
      [
        "scripts/refresh-snapshot.mjs",
        "--out",
        join(ws, "src/catalog/snapshot.ts"),
        "--facts-out",
        join(ws, "src/catalog/facts.ts"),
      ],
      env,
    )
    assertEqual(snapshot.status, 0, `refresh:snapshot failed: ${snapshot.stderr}`)
    // Leg 2: re-capture the RSC fixtures from the live docs pages.
    const fixtures = await runScript(
      ["scripts/capture-rsc-fixtures.mjs", "--fixtures-dir", join(ws, "fixtures")],
      env,
    )
    assertEqual(fixtures.status, 0, `refresh:fixtures failed: ${fixtures.stderr}`)
    // Leg 3: classification from the freshly captured fixtures.
    const classification = await runScript(
      [
        "scripts/refresh-classification.mjs",
        "--fixtures",
        "--fixtures-dir",
        join(ws, "fixtures"),
        "--out",
        join(ws, "src/catalog/classification.ts"),
      ],
      env,
    )
    assertEqual(classification.status, 0, `refresh:classification failed: ${classification.stderr}`)
    // Leg 4: deals from the freshly captured fixtures.
    const deals = await runScript(
      [
        "scripts/refresh-deals.mjs",
        "--fixtures",
        "--fixtures-dir",
        join(ws, "fixtures"),
        "--out",
        join(ws, "src/deals/catalog.ts"),
      ],
      env,
    )
    assertEqual(deals.status, 0, `refresh:deals failed: ${deals.stderr}`)
  } finally {
    await mock.close()
  }
}

interface ExtractedPayload {
  capability: Record<string, boolean>
  efforts: Record<string, string[]>
  overrides: Record<string, { capability: boolean; justification: string }>
}

async function extractClassificationPayload(ws: string): Promise<ExtractedPayload> {
  const mod = (await import(pathToFileURL(join(ws, "src/catalog/classification.ts")).href)) as {
    MODEL_REASONING_CAPABILITY: Record<string, boolean>
    CLASSIFICATION_OVERRIDES: ExtractedPayload["overrides"]
  }
  const facts = (await import(pathToFileURL(join(ws, "src/catalog/facts.ts")).href)) as {
    MODEL_EFFORTS: Record<string, string[]>
  }
  return {
    capability: mod.MODEL_REASONING_CAPABILITY,
    efforts: facts.MODEL_EFFORTS,
    overrides: mod.CLASSIFICATION_OVERRIDES,
  }
}

// The drift-check fragment the cron runs (same copy as
// tests/catalog-refresh-drift.test.ts — keep in lockstep).
const DRIFT_FRAGMENT = `
  git fetch origin main
  if git diff --quiet \\
      -I 'FACTS_LAST_REFRESHED' \\
      -I 'DEAL_LAST_REFRESHED' \\
      -I 'CLASSIFICATION_LAST_REFRESHED' \\
      origin/main -- \\
      src/catalog/snapshot.ts \\
      src/catalog/facts.ts \\
      src/catalog/classification.ts \\
      src/deals/catalog.ts; then
    echo "drift=false"
  else
    echo "drift=true"
  fi
`

run([
  [
    "replay: efforts promotions (hy4-preview, v4-flash-fast, Kimi-K3) ship a green refresh PR with zero human edits",
    async () => {
      const before = await mkdtemp(join(tmpdir(), "cc-replay-before-"))
      const after = await mkdtemp(join(tmpdir(), "cc-replay-after-"))
      try {
        // Both ladders run green (exit 0, all four legs) — no human edit.
        await runLadder({ effortsPromoted: false }, before)
        await runLadder({ effortsPromoted: true }, after)

        // Runtime source is untouched by the ladder (the "zero human
        // edits" anchor): the plugin's source tree shows no modification.
        const { stdout: dirty } = await exec("git", [
          "status",
          "--porcelain",
          "--",
          "src/provider",
          "src/plugin",
        ])
        assertEqual(dirty.trim(), "", "runtime source must carry no hand edits")

        // The derived runtime flips from data alone: before, the promoted
        // models are reasoning-without-efforts; after, they are efforts
        // models (derivation is the same public export the runtime uses).
        const beforePayload = await extractClassificationPayload(before)
        const afterPayload = await extractClassificationPayload(after)
        const derivedBefore = deriveReasoningWithoutEfforts(
          beforePayload.capability,
          beforePayload.efforts,
        )
        const derivedAfter = deriveReasoningWithoutEfforts(
          afterPayload.capability,
          afterPayload.efforts,
        )
        for (const id of EFFORTS_PROMOTIONS.keys()) {
          assert(derivedBefore.has(id), `${id} must start as reasoning-without-efforts`)
          assert(!derivedAfter.has(id), `${id} must become an efforts model`)
          assert(
            Array.isArray(afterPayload.efforts[id]) && afterPayload.efforts[id].length > 0,
            `${id} must gain a generated efforts entry`,
          )
        }

        // The PR body renders the semantic flips in plain language.
        const { writeFile: wr } = await import("node:fs/promises")
        const dir = await mkdtemp(join(tmpdir(), "cc-replay-diff-"))
        try {
          await wr(join(dir, "before.json"), JSON.stringify(beforePayload))
          await wr(join(dir, "after.json"), JSON.stringify(afterPayload))
          await wr(
            join(dir, "facts-before.json"),
            JSON.stringify({ MODEL_EFFORTS: beforePayload.efforts }),
          )
          await wr(
            join(dir, "facts-after.json"),
            JSON.stringify({ MODEL_EFFORTS: afterPayload.efforts }),
          )
          const { stdout: section } = await exec("node", [
            "scripts/diff-catalog.mjs",
            "classification",
            join(dir, "before.json"),
            join(dir, "after.json"),
            "--before-facts",
            join(dir, "facts-before.json"),
            "--after-facts",
            join(dir, "facts-after.json"),
          ])
          for (const [id, levels] of EFFORTS_PROMOTIONS) {
            const row = section
              .split("\n")
              .find((line) => line.trimStart().startsWith("|") && line.includes(`\`${id}\``))
            assert(
              row,
              `the PR body must render the ${id} promotion as a table row, got: ${section}`,
            )
            const cells = row
              .split("|")
              .slice(1, -1)
              .map((c) => c.trim())
            assertEqual(cells[1], "classification", row)
            assertEqual(cells[2], "reasoning-without-efforts", row)
            assertEqual(cells[3], `efforts model (${levels})`, row)
          }
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      } finally {
        await rm(before, { recursive: true, force: true })
        await rm(after, { recursive: true, force: true })
      }
    },
  ],

  [
    "replay: MiniMax-M3-free-class retirement and Gemini 3.7 Flash deal end ship a green refresh",
    async () => {
      const before = await mkdtemp(join(tmpdir(), "cc-replay-deals-before-"))
      const after = await mkdtemp(join(tmpdir(), "cc-replay-deals-after-"))
      try {
        // Precondition: the retirement anchor is a free variant still in
        // today's Snapshot (the M3 free variant already left the committed
        // catalog when its retirement was absorbed).
        const { byId } = snapshotIndex()
        assert(
          byId.has(RETIRED_FREE_VARIANT),
          `anchor model ${RETIRED_FREE_VARIANT} must be in the snapshot`,
        )
        assert(byId.has(GEMINI_ID), `anchor model ${GEMINI_ID} must be in the snapshot`)

        await runLadder({ geminiDeal: true }, before)
        await runLadder({ geminiDeal: false, retireFreeVariant: true }, after)

        // The deal end moved the deals module from data alone.
        type DealsModule = {
          MODEL_DEALS: Record<string, { free?: boolean; discount?: { pct: number } }>
        }
        const beforeDeals = (
          (await import(pathToFileURL(join(before, "src/deals/catalog.ts")).href)) as DealsModule
        ).MODEL_DEALS
        const afterDeals = (
          (await import(pathToFileURL(join(after, "src/deals/catalog.ts")).href)) as DealsModule
        ).MODEL_DEALS
        assertEqual(beforeDeals[GEMINI_ID].discount?.pct, 50, "before: the Gemini deal is active")
        assertEqual(afterDeals[GEMINI_ID].discount, undefined, "after: the Gemini deal ended")
        // The retired variant left the Snapshot but the docs lag, so the
        // coverage gates stayed green and the ladder never blocked.
        const afterSnapshot = (
          (await import(pathToFileURL(join(after, "src/catalog/snapshot.ts")).href)) as {
            MODEL_SNAPSHOT: { id: string }[]
          }
        ).MODEL_SNAPSHOT
        assert(
          !afterSnapshot.some((model) => model.id === RETIRED_FREE_VARIANT),
          "the retired variant must be gone from the regenerated snapshot",
        )
        const afterClassification = (
          (await import(pathToFileURL(join(after, "src/catalog/classification.ts")).href)) as {
            MODEL_REASONING_CAPABILITY: Record<string, boolean>
          }
        ).MODEL_REASONING_CAPABILITY
        assert(
          typeof afterClassification[RETIRED_FREE_VARIANT] === "boolean",
          "the docs lag: the retired variant keeps its RSC record (and classification entry)",
        )

        // The PR body renders the deal end and the model removal.
        const dir = await mkdtemp(join(tmpdir(), "cc-replay-deals-diff-"))
        try {
          await writeFile(join(dir, "before.json"), JSON.stringify({ MODEL_DEALS: beforeDeals }))
          await writeFile(join(dir, "after.json"), JSON.stringify({ MODEL_DEALS: afterDeals }))
          const { stdout: dealsSection } = await exec("node", [
            "scripts/diff-catalog.mjs",
            "deals",
            join(dir, "before.json"),
            join(dir, "after.json"),
          ])
          assert(
            dealsSection
              .split("\n")
              .some(
                (line) =>
                  line.trimStart().startsWith("|") &&
                  line.includes(`\`${GEMINI_ID}\``) &&
                  /\|\s*discount\s*\|/.test(line) &&
                  /50% off/.test(line),
              ),
            `the PR body must render the deal end as a discount table row, got: ${dealsSection}`,
          )
          const beforeSnapshot = (
            (await import(pathToFileURL(join(before, "src/catalog/snapshot.ts")).href)) as {
              MODEL_SNAPSHOT: { id: string }[]
            }
          ).MODEL_SNAPSHOT
          await writeFile(
            join(dir, "snapshot-before.json"),
            JSON.stringify({ MODEL_SNAPSHOT: beforeSnapshot }),
          )
          await writeFile(
            join(dir, "snapshot-after.json"),
            JSON.stringify({ MODEL_SNAPSHOT: afterSnapshot }),
          )
          const { stdout: snapshotSection } = await exec("node", [
            "scripts/diff-catalog.mjs",
            "snapshot",
            join(dir, "snapshot-before.json"),
            join(dir, "snapshot-after.json"),
          ])
          assert(
            snapshotSection
              .split("\n")
              .some(
                (line) =>
                  line.trimStart().startsWith("|") &&
                  line.includes(`\`${RETIRED_FREE_VARIANT}\``) &&
                  line.split("|").some((c) => c.trim() === "removed"),
              ),
            `the PR body must render the retirement as a table row, got: ${snapshotSection}`,
          )
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      } finally {
        await rm(before, { recursive: true, force: true })
        await rm(after, { recursive: true, force: true })
      }
    },
  ],

  [
    "replay: PR #103 (date-only churn) produces no PR at all",
    async () => {
      const ws = await mkdtemp(join(tmpdir(), "cc-replay-103-ws-"))
      const base = await mkdtemp(join(tmpdir(), "cc-replay-103-git-"))
      try {
        // One real ladder run produces the "before" generated modules.
        await runLadder({}, ws)
        const remote = join(base, "remote.git")
        const work = join(base, "work")
        await exec("git", ["init", "--bare", "-q", remote])
        await exec("git", ["init", "-q", "-b", "main", work])
        await exec("git", ["-C", work, "config", "user.email", "test@example.com"])
        await exec("git", ["-C", work, "config", "user.name", "Test"])
        await exec("git", ["-C", work, "config", "commit.gpgsign", "false"])
        await exec("git", ["-C", work, "remote", "add", "origin", remote])
        await mkdir(join(work, "src/catalog"), { recursive: true })
        await mkdir(join(work, "src/deals"), { recursive: true })
        await mkdir(join(work, "tests/fixtures"), { recursive: true })
        for (const f of [
          "src/catalog/snapshot.ts",
          "src/catalog/facts.ts",
          "src/catalog/classification.ts",
          "src/deals/catalog.ts",
        ]) {
          await cp(join(ws, f), join(work, f))
        }
        for (const f of ["rsc-pricing-limits.txt", "rsc-goat.txt", "rsc-pro.txt"]) {
          await cp(join(ws, "fixtures", f), join(work, "tests/fixtures", f))
        }
        await exec("git", ["-C", work, "add", "-A"])
        await exec("git", ["-C", work, "commit", "-q", "-m", "seed generated catalogs"])
        await exec("git", ["-C", work, "push", "-q", "origin", "main"])

        // The next-day run: the generated data is identical, only the
        // refreshed-date stamps move, and the fixture bytes churn
        // (upstream site deploy → new build ids).
        const bumpDate = (text: string) =>
          text.replace(
            /export const (FACTS|DEAL|CLASSIFICATION)_LAST_REFRESHED = ".*"/,
            (_m, which) => `export const ${which}_LAST_REFRESHED = "2026-09-02"`,
          )
        for (const f of [
          "src/catalog/facts.ts",
          "src/catalog/classification.ts",
          "src/deals/catalog.ts",
        ]) {
          const text = await readFile(join(work, f), "utf-8")
          await writeFile(join(work, f), bumpDate(text), "utf-8")
        }
        await writeFile(
          join(work, "tests/fixtures/rsc-goat.txt"),
          (await readFile(join(work, "tests/fixtures/rsc-goat.txt"), "utf-8")).replaceAll(
            "commandcode-ai",
            "churned-build-id",
          ),
          "utf-8",
        )

        // The cron's drift check must report NO drift → no PR at all.
        const { stdout } = await exec("bash", ["-c", DRIFT_FRAGMENT], { cwd: work })
        assert(
          stdout.includes("drift=false"),
          `the date-only replay must open no PR, got: ${stdout}`,
        )

        const dealsText = await readFile(join(work, "src/deals/catalog.ts"), "utf-8")
        assert(
          dealsText.includes('"claude-sonnet-5": { tier: "opensource"'),
          `the synthetic deals module must carry the sonnet entry, got: ${dealsText.slice(0, 400)}`,
        )
        await writeFile(
          join(work, "src/deals/catalog.ts"),
          dealsText.replace(
            '"claude-sonnet-5": { tier: "opensource"',
            '"claude-sonnet-5": { tier: "premium"',
          ),
          "utf-8",
        )
        const { stdout: drift2 } = await exec("bash", ["-c", DRIFT_FRAGMENT], { cwd: work })
        assert(
          drift2.includes("drift=true"),
          `a real data change must still open the refresh PR, got: ${drift2}`,
        )
      } finally {
        await rm(ws, { recursive: true, force: true })
        await rm(base, { recursive: true, force: true })
      }
    },
  ],

  [
    "replay: merging the refresh PR cuts the release (synthetic body → bump commit → tag)",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "cc-replay-release-"))
      try {
        const remote = join(base, "remote.git")
        const work = join(base, "work")
        await exec("git", ["init", "--bare", "-q", remote])
        await exec("git", ["init", "-q", "-b", "main", work])
        await exec("git", ["-C", work, "config", "user.email", "test@example.com"])
        await exec("git", ["-C", work, "config", "user.name", "Test"])
        await exec("git", ["-C", work, "config", "commit.gpgsign", "false"])
        await exec("git", ["-C", work, "remote", "add", "origin", remote])
        await writeFile(
          join(work, "package.json"),
          JSON.stringify({ name: "replay-pkg", version: "1.6.2" }, null, 2) + "\n",
          "utf-8",
        )
        await writeFile(
          join(work, "CHANGELOG.md"),
          ["## 1.6.2 - 2026-08-01", "", "- previous release.", "", ""].join("\n"),
          "utf-8",
        )
        // The PR body carries the semantic sections the ladder's diffs
        // produced (the exact section shape the cron renders).
        await writeFile(
          join(work, "pr-body.md"),
          [
            "## Catalog refresh — 2026-09-02",
            "",
            "### Changed files",
            "",
            "```",
            " src/catalog/facts.ts | 6 +++---",
            "```",
            "",
            "### Model catalog",
            "",
            "- **FACTS_LAST_REFRESHED**: `2026-09-01` → `2026-09-02`",
            "No changes.",
            "",
            "### Reasoning classification",
            "",
            "- **CLASSIFICATION_LAST_REFRESHED**: `2026-09-01` → `2026-09-02`",
            "",
            "| Model               | Change         | Before                    | After                           |",
            "| ------------------- | -------------- | ------------------------- | ------------------------------- |",
            "| `moonshotai/Kimi-K3` | classification | reasoning-without-efforts | efforts model (low, medium, high) |",
            "",
            "### Deals intelligence",
            "",
            "- **DEAL_LAST_REFRESHED**: `2026-09-01` → `2026-09-02`",
            "",
            "| Model    | Change   | Before              | After |",
            "| -------- | -------- | ------------------- | ----- |",
            `| \`${GEMINI_ID}\` | discount | 50% off (deal ended) | —     |`,
            "",
            "---",
            "",
            "_Auto-generated by the `catalog-refresh` workflow. Review and merge._",
            "",
          ].join("\n"),
          "utf-8",
        )
        await exec("mkdir", ["-p", join(work, "scripts")])
        await cp(
          join(process.cwd(), "scripts", "release-notes.mjs"),
          join(work, "scripts", "release-notes.mjs"),
        )
        await exec("git", ["-C", work, "add", "-A"])
        await exec("git", ["-C", work, "commit", "-q", "-m", "seed"])
        await exec("git", ["-C", work, "push", "-q", "origin", "main"])

        // The exact release fragments the auto-release workflow runs (see
        // tests/auto-release.test.ts, which locks them; keep in lockstep).
        const fragment = `
          set -euo pipefail
          version="$(node -p "require('./package.json').version")"
          next="$(node -e "const [maj,min,pat]=process.argv[1].split('.').map(Number);process.stdout.write(maj+'.'+min+'.'+(pat+1))" "$version")"
          if git rev-parse -q --verify "refs/tags/v\${next}" >/dev/null; then
            echo "::warning::tag v\${next} already exists — skipping the auto-release (no commit, no tag)."
            exit 0
          fi
          date="$(date -u +%Y-%m-%d)"
          node scripts/release-notes.mjs "\${next}" "\${date}" pr-body.md > release-notes.md
          { cat release-notes.md; cat CHANGELOG.md; } > CHANGELOG.md.new
          mv CHANGELOG.md.new CHANGELOG.md
          npm version "\${next}" --no-git-tag-version --allow-same-version >/dev/null
          npm install --package-lock-only >/dev/null 2>&1
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add package.json package-lock.json CHANGELOG.md
          git commit -q -m "chore(release): \${next}"
          git tag "v\${next}"
          next="$(node -p "require('./package.json').version")"
          git push -q origin main "v\${next}"
          echo "auto-release: cut v\${next} on main; the tag-driven release pipeline takes it from here."
        `
        await exec("bash", ["-c", fragment], {
          cwd: work,
          env: { ...process.env, npm_config_cache: join(tmpdir(), "cc-replay-npm-cache") },
        })
        const pkg = JSON.parse(await readFile(join(work, "package.json"), "utf-8")) as {
          version: string
        }
        assertEqual(pkg.version, "1.6.3")
        const { stdout: subject } = await exec("git", ["-C", work, "log", "-1", "--format=%s"])
        assertEqual(subject.trim(), "chore(release): 1.6.3")
        const changelog = await readFile(join(work, "CHANGELOG.md"), "utf-8")
        assert(
          changelog.startsWith(`## 1.6.3 - ${TODAY}`),
          `expected the release section first, got: ${changelog.slice(0, 60)}`,
        )
        assert(
          changelog.split("\n").some((line) => {
            if (!line.trimStart().startsWith("|")) return false
            const cells = line
              .split("|")
              .slice(1, -1)
              .map((c) => c.trim())
            return (
              cells[0] === "`moonshotai/Kimi-K3`" &&
              cells[1] === "classification" &&
              cells[2] === "reasoning-without-efforts" &&
              cells[3] === "efforts model (low, medium, high)"
            )
          }),
          "the CHANGELOG must carry the PR's semantic classification table",
        )
        assert(
          changelog
            .split("\n")
            .some(
              (line) =>
                line.trimStart().startsWith("|") &&
                line.includes(`\`${GEMINI_ID}\``) &&
                line.includes("50% off"),
            ),
          "the CHANGELOG must carry the PR's semantic deals table",
        )
        assert(!changelog.includes("Changed files"), "non-semantic sections must be dropped")
        const { stdout: refs } = await exec("git", ["-C", work, "ls-remote", "origin"])
        assert(refs.includes("refs/tags/v1.6.3"), "the tag must be pushed (pipeline trigger)")
        // The release pipeline itself is untouched by this work: it still
        // triggers on v* tags, gates the stale catalogs, and publishes.
        const release = await readFile(
          join(process.cwd(), ".github/workflows/release.yml"),
          "utf-8",
        )
        assert(release.includes('tags: ["v*"]'), release)
        assert(release.includes("npm publish"), release)
        assert(release.includes("stale catalog snapshot or facts"), release)
        // The release pipeline's changelog extractor must only stop at a
        // version-shaped heading — the refresh sections embed `## Model
        // catalog` H2s, and treating any `##` as a terminator truncated
        // the v1.6.3/v1.6.4 release notes to the first heading (both runs
        // shipped 5-line notes with no change tables).
        assert(release.includes("/^## [0-9]+\\.[0-9]+\\.[0-9]+ - /"), release)
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
  ],
])
