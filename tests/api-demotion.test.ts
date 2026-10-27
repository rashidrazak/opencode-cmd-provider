// tests/api-demotion.test.ts — the plain listing endpoint is a divergence
// reporter, and the runtime stays offline.
//
// ADR-0024 moved membership to the catalog endpoint's client view
// (`/provider/v1/models?view=client`). The *plain* listing endpoint
// (`/provider/v1/models`, the thin shape) remains what it was after issue #130:
// annotate-only — set-diff notes in both directions, zero gating power, zero
// field writes. Its values must never reach the emitted modules.
//
// Synthetic worlds only (never upstream's live ids).
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { startMockCc } from "./helpers/mock-cc.js"
import { assert, assertEqual, run } from "./harness.js"

const CATALOG = {
  catalogVersion: "test-catalog",
  data: [
    {
      id: "vendor/divergent",
      name: "Divergent Model",
      context_length: 1_000_000,
      reasoningEfforts: ["low"],
      inputModalities: ["text"],
      pricing: { inputCost: 2, outputCost: 10, cacheReadCost: 0.2 },
    },
  ],
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
  // Every enrichment source points at the mock (which 404s unless the
  // test provides a body) so a refresh test never touches the live site.
  return {
    ...process.env,
    COMMANDCODE_API_BASE: mock.url,
    COMMANDCODE_REGISTRY_URL: `${mock.url}/registry`,
    COMMANDCODE_CATALOG_URL: `${mock.url}/provider/v1/models?view=client`,
    COMMANDCODE_RSC_GOAT_URL: `${mock.url}/docs/plans/goat`,
    COMMANDCODE_RSC_PRO_URL: `${mock.url}/docs/plans/pro`,
    COMMANDCODE_MODELS_PAGE_URL: `${mock.url}/models-page.html`,
    COMMANDCODE_MODELS_DETAIL_URL: `${mock.url}/model-detail`,
  }
}

/** Runs one refresh with the given plain-endpoint failure mode. */
async function refreshWithPlainEndpoint(options: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "cc-api-"))
  const out = join(dir, "snapshot.ts")
  const factsOut = join(dir, "facts.ts")
  const mock = await startMockCc({
    registry: { "dist-tags": { latest: "9.9.9" } },
    catalog: CATALOG,
    ...options,
  })
  try {
    const result = await runScript(
      ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", factsOut],
      scriptEnv(mock),
    )
    return { result, out, factsOut, dir }
  } finally {
    await mock.close()
  }
}

run([
  [
    "plain listing API 500 degrades to a skipped-divergence note; membership ships with exit 0",
    async () => {
      const { result, out, dir } = await refreshWithPlainEndpoint({ modelsStatus: 500 })
      try {
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("divergence note skipped"),
          `expected a skipped-divergence note, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        assertEqual(
          mod.MODEL_SNAPSHOT.map((m) => m.id),
          ["vendor/divergent"],
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "plain listing API non-JSON body degrades to a skipped-divergence note; membership ships",
    async () => {
      const { result, out, dir } = await refreshWithPlainEndpoint({
        modelsRaw: "<html>not json</html>",
      })
      try {
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("divergence note skipped"),
          `expected a skipped-divergence note, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        assertEqual(
          mod.MODEL_SNAPSHOT.map((m) => m.id),
          ["vendor/divergent"],
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "plain listing API wrong-shape JSON degrades to a skipped-divergence note; membership ships",
    async () => {
      const { result, out, dir } = await refreshWithPlainEndpoint({
        models: { object: "not-a-list" },
      })
      try {
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("divergence note skipped"),
          `expected a skipped-divergence note, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        assertEqual(
          mod.MODEL_SNAPSHOT.map((m) => m.id),
          ["vendor/divergent"],
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "same-id divergent plain-API values never reach Snapshot or facts fields (the plain API wins no field)",
    async () => {
      const { result, out, factsOut, dir } = await refreshWithPlainEndpoint({
        // The plain endpoint serves the SAME id with wrong values: a wrong
        // name and a context_length no catalog record carries. Neither may
        // leak anywhere — the catalog view is the only authority.
        models: {
          object: "list",
          data: [{ id: "vendor/divergent", name: "WRONG NAME FROM API", context_length: 1 }],
        },
      })
      try {
        assertEqual(result.status, 0, result.stderr || result.stdout)
        const mod = await import(out)
        assertEqual(mod.MODEL_SNAPSHOT, [
          {
            id: "vendor/divergent",
            name: "Divergent Model",
            contextLength: 1000000,
            contextSource: "catalog",
            efforts: ["low"],
            cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
            costSource: "catalog",
          },
        ])
        const factsMod = await import(factsOut)
        assertEqual(factsMod.MODEL_COSTS, {
          "vendor/divergent": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
        })
        assertEqual(factsMod.MODEL_EFFORTS, { "vendor/divergent": ["low"] })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a membership failure aborts before the plain listing endpoint is contacted",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-api-order-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registryRaw: "<html>not json</html>",
        catalog: CATALOG,
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
          "the plain endpoint must not be contacted when membership cannot be resolved",
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a record advertising no modalities logs a pending note and ships text-only (never a failure)",
    async () => {
      const { result, out, factsOut, dir } = await refreshWithPlainEndpoint({
        catalog: {
          catalogVersion: "test-catalog",
          data: [
            {
              id: "vendor/divergent",
              name: "Divergent Model",
              context_length: 1_000_000,
              inputModalities: null,
              pricing: { inputCost: 2, outputCost: 10, cacheReadCost: 0.2 },
            },
          ],
        },
        models: { object: "list", data: [] },
      })
      try {
        assertEqual(result.status, 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("modalities pending") &&
            result.stdout.includes("vendor/divergent"),
          `expected a modalities-pending note naming the model, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        assert(
          mod.MODEL_SNAPSHOT.some((m) => m.id === "vendor/divergent"),
          "the row must ship",
        )
        const factsText = await readFile(factsOut, "utf-8")
        const modSection = factsText.slice(factsText.indexOf("MODEL_INPUT_MODALITIES"))
        assert(
          !modSection.includes("vendor/divergent"),
          "a modality-less model must fall back to text-only (no modalities entry)",
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "runtime source reaches the catalog only from the background-sync module",
    () => {
      // ADR-0024 changed this policy deliberately: membership may refresh at
      // runtime, but ONLY from src/plugin/catalog-sync.ts, and only behind
      // registration (the entry point fires it unawaited, after the config hook
      // has already registered models from the cache/bundle).
      //
      // Two pins keep that narrow:
      //   1. `src/plugin/catalog-sync.ts` is the one module allowed to name the
      //      catalog endpoint — anywhere else it is a code path nobody audited;
      //   2. no module under src/catalog/ may fetch at all: the catalog data
      //      layer stays pure, so the disk cache is readable without network
      //      semantics and the runtime bundle cannot grow a second transport.
      const root = join(dirname(new URL(import.meta.url).pathname), "..")
      const syncModule = join(root, "src", "plugin", "catalog-sync.ts")
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
          if (full === syncModule) continue
          const text = readFileSync(full, "utf-8")
          // A `*_SOURCE_URL` provenance declaration legitimately names the
          // endpoint (it is metadata a surface can display); any other mention
          // would be a code path. Check per line so the constant cannot mask a
          // real offender in the same file.
          for (const line of text.split("\n")) {
            if (!line.includes("/provider/v1/models")) continue
            if (/^\s*\/\//.test(line)) continue
            if (/export const [A-Z_]*SOURCE_URL\s*=/.test(line)) continue
            offenders.push(`${full}: ${line.trim()}`)
          }
          if (
            full.includes(`${join(root, "src", "catalog")}/`) &&
            /(^|[^A-Za-z0-9_.])fetch\s*\(/.test(text)
          ) {
            fetchOffenders.push(full)
          }
        }
      }
      walk(join(root, "src"))
      assertEqual(
        offenders,
        [],
        "only src/plugin/catalog-sync.ts may reference the catalog endpoint",
      )
      assertEqual(
        fetchOffenders,
        [],
        "the catalog data layer (src/catalog) must stay pure — no fetch at all",
      )
    },
  ],
])
