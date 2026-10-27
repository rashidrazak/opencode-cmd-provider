// tests/refresh-snapshot.test.ts — refresh script integration (issue #16 seam 3,
// ADR-0024: catalog-primary Snapshot membership + ship-bar)
//
// Membership now comes from the Command Code model catalog's client view
// (`GET /provider/v1/models?view=client`), the same source the CLI resolves
// models from. These tests drive the refresh end to end against the mock and
// assert the *contracts* — membership shape, loud shape failures, ladder
// provenance — never upstream values (spec #108).
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { startMockCc } from "./helpers/mock-cc.js"
import { assert, assertEqual, run } from "./harness.js"

/**
 * A client-view catalog record. Every value here is synthetic and test-owned:
 * an upstream price or context change must move the committed Snapshot, never
 * this suite.
 */
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    context_length: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    inputModalities: ["text", "image"],
    pricing: { inputCost: 2, outputCost: 10, cacheReadCost: 0.2, cacheWriteCost: 2.5 },
    ...overrides,
  }
}

/** A client-view catalog payload wrapping the given records. */
function catalog(data: unknown[], overrides: Record<string, unknown> = {}) {
  return { catalogVersion: "test-catalog", data, refreshInterval: 900, ...overrides }
}

// The plain listing endpoint (`/provider/v1/models`, thin shape) is a separate
// resource consulted only for the divergence note.
const API_MODELS = {
  object: "list",
  data: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 200000 },
    { id: "api-only/model", name: "API Only", context_length: 12345 },
  ],
}

// Async spawn: the in-process mock server must keep serving while the child
// process fetches the catalog, so the parent event loop cannot be blocked.
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
  // Every enrichment source is pointed at the mock (which 404s unless the
  // test provides a body) so a ladder needing a source degrades hermetically
  // — a refresh test must never touch the live Command Code site.
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

run([
  [
    "membership comes from the catalog endpoint, and the plain listing API is note-only",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-refresh-"))
      const out = join(dir, "snapshot.ts")
      const factsOut = join(dir, "facts.ts")
      const mock = await startMockCc({
        models: API_MODELS,
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([
          record(),
          record({
            id: "gpt-6-astra",
            name: "GPT-6 Astra",
            context_length: 1_050_000,
            pricing: { inputCost: 10, outputCost: 50, cacheReadCost: 1, cacheWriteCost: 12.5 },
          }),
        ]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", factsOut],
          scriptEnv(mock),
        )
        assert(result.status === 0, result.stderr || result.stdout)
        assertEqual(mock.hits.catalog, 1)
        // Both catalog records ship. `api-only/model` is served by the thin
        // listing endpoint but is NOT in the catalog, so it must not ship —
        // the divergence note names it instead.
        const mod = await import(out)
        assertEqual(
          mod.MODEL_SNAPSHOT.map((m) => m.id),
          ["claude-sonnet-5", "gpt-6-astra"],
        )
        assert(
          result.stdout.includes("api-only/model"),
          `expected the divergence note to name the API-only model, got: ${result.stdout}`,
        )
        assert(
          result.stdout.includes("test-catalog"),
          `expected the catalog version in the log, got: ${result.stdout}`,
        )
        const factsMod = await import(factsOut)
        assertEqual(factsMod.FACTS_CATALOG_VERSION, "test-catalog")
        assertEqual(factsMod.FACTS_PACKAGE_VERSION, "1.49.1")
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a newly launched model (catalog-ahead of any package release) ships on the next refresh",
    async () => {
      // The bug ADR-0024 fixed: gpt-6.1-terra was live on the catalog and in
      // the CLI, but absent from that release's models.md, so the plugin
      // silently withheld it until a package shipped.
      const dir = await mkdtemp(join(tmpdir(), "cc-catalog-ahead-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([
          record({
            id: "gpt-6.1-terra",
            name: "GPT-6.1 Terra",
            context_length: 1_050_000,
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            inputModalities: ["text", "image"],
            pricing: { inputCost: 1, outputCost: 5, cacheReadCost: 0.05, cacheWriteCost: 1.25 },
          }),
        ]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status === 0, result.stderr || result.stdout)
        const mod = await import(out)
        assertEqual(mod.MODEL_SNAPSHOT, [
          {
            id: "gpt-6.1-terra",
            name: "GPT-6.1 Terra",
            contextLength: 1050000,
            contextSource: "catalog",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
            costSource: "catalog",
          },
        ])
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "hidden catalog records never reach membership; they are reported, not failed",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-hidden-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([
          record({ id: "vendor/visible" }),
          record({ id: "vendor/free-variant", hidden: true }),
        ]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status === 0, result.stderr || result.stdout)
        const mod = await import(out)
        assertEqual(
          mod.MODEL_SNAPSHOT.map((m) => m.id),
          ["vendor/visible"],
        )
        assert(
          result.stdout.includes("hidden") && result.stdout.includes("vendor/free-variant"),
          `expected the hidden record to be reported, got: ${result.stdout}`,
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    'an upstream "off" level never reaches the generated efforts tables (ADR-0019)',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-facts-off-"))
      const out = join(dir, "snapshot.ts")
      const factsOut = join(dir, "facts.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([record({ reasoningEfforts: ["off", "high", "max"] })]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", factsOut],
          scriptEnv(mock),
        )
        assert(result.status === 0, result.stderr || result.stdout)
        const mod = await import(out)
        assertEqual(mod.MODEL_SNAPSHOT[0].efforts, ["high", "max"])
        const factsMod = await import(factsOut)
        assertEqual(factsMod.MODEL_EFFORTS, { "claude-sonnet-5": ["high", "max"] })
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "exact context_length ships verbatim (no decimal rounding)",
    async () => {
      // models.md's coarse "1.05M" cell became 1050000; the catalog carries
      // the true 1048576 and the Snapshot must use it.
      const dir = await mkdtemp(join(tmpdir(), "cc-exact-ctx-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([record({ context_length: 1_048_576 })]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status === 0, result.stderr || result.stdout)
        const mod = await import(out)
        assertEqual(mod.MODEL_SNAPSHOT[0].contextLength, 1_048_576)
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "modalities come from the catalog record, not a CLI scrape",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-modalities-"))
      const out = join(dir, "snapshot.ts")
      const factsOut = join(dir, "facts.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([
          record({ inputModalities: ["text"] }),
          record({
            id: "vision/model",
            name: "Vision Model",
            inputModalities: ["text", "image"],
          }),
        ]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", factsOut],
          scriptEnv(mock),
        )
        assert(result.status === 0, result.stderr || result.stdout)
        const factsMod = await import(factsOut)
        // text-only is omitted by convention (the runtime falls back to text)
        assertEqual(factsMod.MODEL_INPUT_MODALITIES, { "vision/model": ["text", "image"] })
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "an explicitly free record keeps all-zero costs (free ≠ missing)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-free-"))
      const out = join(dir, "snapshot.ts")
      const factsOut = join(dir, "facts.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([
          record({
            id: "poolside/laguna-s-2.1-free",
            name: "Laguna S 2.1",
            context_length: 262_144,
            inputModalities: ["text"],
            pricing: { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0 },
          }),
        ]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", factsOut],
          scriptEnv(mock),
        )
        assert(result.status === 0, result.stderr || result.stdout)
        const mod = await import(out)
        const free = mod.MODEL_SNAPSHOT[0]
        assertEqual(free.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
        const factsMod = await import(factsOut)
        assertEqual(factsMod.MODEL_COSTS[free.id], free.cost)
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "an absent context_length resolves through the ladder: catalog → RSC contextWindow",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-ctx-ladder-"))
      const out = join(dir, "snapshot.ts")
      const slugPayload = (records) => `2:${JSON.stringify(records)}\n`
      const rscRecord = {
        slug: "ctx-ladder",
        id: "ctx/ladder",
        name: "Ctx Ladder",
        vendor: "ctx",
        category: "opensource",
        minPlanName: "Go",
        contextWindow: 333_000,
        tiers: [],
        caps: {},
        reasoning: false,
      }
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([
          (() => {
            const { context_length: _drop, ...withoutContext } = record({
              id: "ctx/ladder",
              name: "Ctx Ladder",
            })
            return withoutContext
          })(),
        ]),
        rscGoat: slugPayload([rscRecord]),
        rscPro: slugPayload([rscRecord]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status === 0, result.stderr || result.stdout)
        assert(
          result.stdout.includes("context ctx/ladder: 333000 (from RSC contextWindow)"),
          `expected the per-step context annotation, got: ${result.stdout}`,
        )
        const mod = await import(out)
        assertEqual(mod.MODEL_SNAPSHOT[0].contextLength, 333_000)
        assertEqual(mod.MODEL_SNAPSHOT[0].contextSource, "rsc")
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "an absent pricing block fails loudly after the full cost ladder (costs never carry forward)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-cost-ladder-fail-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([
          (() => {
            const { pricing: _drop, ...withoutPricing } = record({ id: "a/model", name: "A Model" })
            return withoutPricing
          })(),
        ]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status !== 0, `expected non-zero exit, got ${result.status}`)
        assert(
          result.stderr.includes("a/model") &&
            result.stderr.includes("no cost after the full fallback ladder"),
          `expected a loud unshippable-row failure naming the model, got: ${result.stderr}`,
        )
        assert(
          /costs never carry forward/i.test(result.stderr),
          `the loud failure must state that costs never carry forward, got: ${result.stderr}`,
        )
        let wrote = true
        try {
          await readFile(out, "utf-8")
        } catch {
          wrote = false
        }
        assert(!wrote, "no module must be written for an unshippable row")
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a catalog shape change fails loudly and writes nothing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-catalog-shape-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([record({ context_length: "1M" })]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status !== 0, `expected non-zero exit, got ${result.status}`)
        assert(
          result.stderr.includes("context_length"),
          `expected the shape failure to name the field, got: ${result.stderr}`,
        )
        let wrote = true
        try {
          await readFile(out, "utf-8")
        } catch {
          wrote = false
        }
        assert(!wrote, "no module may be written on a shape change")
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "refresh-snapshot fails loudly when the registry body is not JSON",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-registry-parse-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registryRaw: "<html>not json</html>",
        catalog: catalog([record()]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status !== 0, `expected non-zero exit, got ${result.status}`)
        assert(
          result.stderr.includes("could not parse"),
          `expected 'could not parse' in stderr, got: ${result.stderr}`,
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "an unreachable catalog fails loudly (membership has no fallback source)",
    async () => {
      // ADR-0024: the catalog is membership. There is no second membership
      // source — a failed fetch is a failed refresh, never a silent
      // smaller catalog and never a carried-forward model list.
      const dir = await mkdtemp(join(tmpdir(), "cc-catalog-down-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalogStatus: 500,
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(result.status !== 0, `expected non-zero exit, got ${result.status}`)
        assert(
          result.stderr.includes("could not fetch") || result.stderr.includes("failed to fetch"),
          `expected a loud fetch failure, got: ${result.stderr}`,
        )
        let wrote = true
        try {
          await readFile(out, "utf-8")
        } catch {
          wrote = false
        }
        assert(!wrote, "no module may be written when membership cannot be read")
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "a record advertising no modalities logs a pending note, not a failure",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-modalities-pending-"))
      const out = join(dir, "snapshot.ts")
      const mock = await startMockCc({
        models: { object: "list", data: [] },
        registry: { "dist-tags": { latest: "1.49.1" } },
        catalog: catalog([record({ inputModalities: null })]),
      })
      try {
        const result = await runScript(
          ["scripts/refresh-snapshot.mjs", "--out", out, "--facts-out", join(dir, "facts.ts")],
          scriptEnv(mock),
        )
        assert(
          result.status === 0,
          `expected success with a pending note, got stderr: ${result.stderr}`,
        )
        assert(
          result.stdout.includes("modalities pending") && result.stdout.includes("claude-sonnet-5"),
          `expected a modalities-pending note, got stdout: ${result.stdout}`,
        )
        const mod = await import(out)
        assert(
          mod.MODEL_SNAPSHOT.some((m) => m.id === "claude-sonnet-5"),
          "the row must ship",
        )
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
])
