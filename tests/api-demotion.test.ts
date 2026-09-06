// tests/api-demotion.test.ts — issue #133: the provider listing API is a
// pure divergence reporter (set-diff notes, both directions, zero gating
// power, zero field writes, zero runtime knowledge) and the refresh
// pipeline reads membership first (registry dist-tag to package table)
// with enrichment attached after.
//
// Synthetic worlds only (never upstream's live ids): the listing API is
// annotate-only, so its values must never leak into the emitted modules.
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { startMockCc } from "./helpers/mock-cc.js"
import { assert, assertEqual, run } from "./harness.js"

const PACKAGE_MD =
  "## Open Source\n\n" +
  "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |\n" +
  "|---|---|---|---|---|---|---|\n" +
  "| `vendor/divergent` | Divergent Model | 1M | low | $2/$10 · cache $0.2 | Go and above | best |\n"

const CLI_BUNDLE =
  'const models={D:{name:"Divergent Model",id:"vendor/divergent",inputModalities:["text"],contextWindow:1e6}}'

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
  // Every enrichment source points at the mock (which 404s unless the
  // test provides a body) so a refresh test never touches the live site.
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

run([
  [
    "listing API 500 degrades to a skipped-divergence note; membership ships with exit 0",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-api-500-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        modelsStatus: 500,
        registry: { "dist-tags": { latest: "9.9.9" } },
        factsMd: PACKAGE_MD,
        modalitiesBundle: CLI_BUNDLE,
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("divergence note skipped"),
          `expected a skipped-divergence note, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        assertEqual(
          mod.MODEL_SNAPSHOT.map((m) => m.id),
          ["vendor/divergent"],
          "membership must ship despite the API outage",
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "listing API non-JSON body degrades to a skipped-divergence note; membership ships with exit 0",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-api-raw-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        modelsRaw: "<html>not json</html>",
        registry: { "dist-tags": { latest: "9.9.9" } },
        factsMd: PACKAGE_MD,
        modalitiesBundle: CLI_BUNDLE,
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("divergence note skipped"),
          `expected a skipped-divergence note, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        assertEqual(
          mod.MODEL_SNAPSHOT.map((m) => m.id),
          ["vendor/divergent"],
          "membership must ship despite the API garbage body",
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "listing API wrong-shape JSON degrades to a skipped-divergence note; membership ships with exit 0",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-api-shape-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: "not-an-array" },
        registry: { "dist-tags": { latest: "9.9.9" } },
        factsMd: PACKAGE_MD,
        modalitiesBundle: CLI_BUNDLE,
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("divergence note skipped"),
          `expected a skipped-divergence note, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        assertEqual(
          mod.MODEL_SNAPSHOT.map((m) => m.id),
          ["vendor/divergent"],
          "membership must ship despite the API shape change",
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "same-id divergent API values never reach Snapshot or facts fields (the API wins no field)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-api-fields-"))
      const out = join(dir, "snapshot.ts")
      const factsOut = join(dir, "facts.ts")
      const mock = await startMockCc({
        // The API serves the SAME id with wrong values: a wrong name and a
        // context_length no package row carries. Neither may leak anywhere.
        models: {
          object: "list",
          data: [{ id: "vendor/divergent", name: "WRONG NAME FROM API", context_length: 1 }],
        },
        registry: { "dist-tags": { latest: "9.9.9" } },
        factsMd: PACKAGE_MD,
        modalitiesBundle: CLI_BUNDLE,
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", factsOut],
          scriptEnv(mock),
        )
        assertEqual(result.status, 0, result.stderr || result.stdout)
        const mod = await import(out)
        assertEqual(mod.MODEL_SNAPSHOT, [
          {
            id: "vendor/divergent",
            name: "Divergent Model",
            contextLength: 1000000,
            contextSource: "models.md",
            efforts: ["low"],
            cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
            costSource: "models.md",
          },
        ])
        const factsMod = await import(factsOut)
        assertEqual(factsMod.MODEL_COSTS, {
          "vendor/divergent": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
        })
        assertEqual(factsMod.MODEL_EFFORTS, { "vendor/divergent": ["low"] })
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a membership failure aborts before the listing API is contacted (membership-before-enrichment)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-api-order-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registryRaw: "<html>not json</html>",
        factsMd: PACKAGE_MD,
        modalitiesBundle: CLI_BUNDLE,
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status !== 0, `expected non-zero exit, got ${result.status}`)
        assertEqual(
          mock.hits.models,
          0,
          "a broken membership read must abort before the listing API is contacted",
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "CLI bundle outage degrades to text-only modalities with a pending note, exit 0 (enrichment, never a membership gate)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-cli-outage-"))
      const out = join(dir, "snapshot.ts")
      const factsOut = join(dir, "facts.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "9.9.9" } },
        factsMd: PACKAGE_MD,
        cliStatus: 500,
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", factsOut],
          scriptEnv(mock),
        )
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("modalities pending") &&
            result.stdout.includes("vendor/divergent"),
          `expected a modalities-pending note naming the model, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        const row = mod.MODEL_SNAPSHOT.find((m) => m.id === "vendor/divergent")
        assert(row, "the package row must ship despite the CLI outage")
        assertEqual(row.contextLength, 1000000)
        assertEqual(row.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 })
        // Text-only fallback: no image entry for the model.
        const factsText = await readFile(factsOut, "utf-8")
        const modSection = factsText.slice(factsText.indexOf("MODEL_INPUT_MODALITIES"))
        assert(
          !modSection.includes("vendor/divergent"),
          "a CLI-outage model must fall back to text-only (no modalities entry)",
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "runtime source has no listing-API code path (stays offline)",
    () => {
      // The plugin runtime never reads the listing endpoint: membership
      // ships bundled in the Snapshot. Any refresh-time fetch must stay in
      // scripts/, never in src/. Two pins: no reference to the listing
      // endpoint anywhere under src/, AND no fetch() at all in the
      // offline layers (src/plugin, src/catalog) — network at runtime
      // lives only in the provider transport (generate/messages/whoami)
      // and the plan-summary tool, never in catalog/plugin wiring.
      const root = join(dirname(new URL(import.meta.url).pathname), "..")
      const offenders: string[] = []
      const fetchOffenders: string[] = []
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
            continue
          }
          if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue
          const text = readFileSync(full, "utf-8")
          if (text.includes("/provider/v1/models")) {
            offenders.push(full)
          }
          if (
            (full.includes(`${join(root, "src", "plugin")}/`) ||
              full.includes(`${join(root, "src", "catalog")}/`)) &&
            /(^|[^A-Za-z0-9_.])fetch\s*\(/.test(text)
          ) {
            fetchOffenders.push(full)
          }
        }
      }
      walk(join(root, "src"))
      assertEqual(offenders, [], "runtime source must not reference the listing endpoint")
      assertEqual(
        fetchOffenders,
        [],
        "the offline layers (src/plugin, src/catalog) must not fetch at runtime",
      )
    },
  ],
])
