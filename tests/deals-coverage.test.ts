// tests/deals-coverage.test.ts — every snapshot model must have a deals
// record so the TUI sidebar "Command Code" section renders for every model
// (issue: Ox Alpha / DeepSeek V4 Flash Vision (exp) showed no section because
// the docs fixtures predated them).
import { readFileSync } from "node:fs"
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { MODEL_COSTS } from "../src/catalog/facts.js"
import { MODEL_DEALS } from "../src/deals/catalog.js"
import { enrichCommandCodeModels } from "../src/deals/enrichment.js"
import { isFreeModelCost } from "../src/provider/pricing.js"
import { extractPlanPageRsc } from "../scripts/parse-rsc.mjs"
import { assert, assertEqual, run } from "./harness.js"

const RSC_GOAT = readFileSync(new URL("./fixtures/rsc-goat.txt", import.meta.url), "utf-8")
const RSC_PRO = readFileSync(new URL("./fixtures/rsc-pro.txt", import.meta.url), "utf-8")

run([
  [
    "every snapshot model has a MODEL_DEALS entry",
    () => {
      const missing = MODEL_SNAPSHOT.filter((model) => !(model.id in MODEL_DEALS)).map(
        (model) => model.id,
      )
      assertEqual(missing, [], `models missing deals data: ${missing.join(", ")}`)
    },
  ],

  [
    "deals free flag and facts zero-cost table agree",
    () => {
      // The picker's "(free)" suffix derives from the facts zero-cost table
      // (Core-side) while the TUI "FREE" row derives from MODEL_DEALS.free
      // (docs-side) — the two must never drift apart.
      for (const [id, deal] of Object.entries(MODEL_DEALS)) {
        assertEqual(
          deal.free,
          isFreeModelCost(MODEL_COSTS[id]),
          `${id}: deals free flag must match the facts zero-cost table`,
        )
      }
    },
  ],

  [
    "RSC fixture records resolve to snapshot models or are tolerated as docs-ahead skew",
    () => {
      // The RSC's per-plan (goat, pro) slug records are the source of truth
      // for the snapshot id (the alias is applied inside extractPlanPageRsc).
      // Records that don't resolve to a snapshot id are docs-ahead-of-API
      // skew (catalog-refresh run 33924108227: the docs shipped gpt-6-astra
      // before the API catalog did) — the generators drop them by design
      // (the !snapshotIds.has(sid) guards in buildRscInputs /
      // deriveCapabilityMap, locked by synthetic drop tests), so they must
      // not fail the suite. The reverse direction — a snapshot model with
      // no record — stays loud via the generators' coverage gates
      // (missingSnapshotModels) and the MODEL_DEALS-entry test above.
      const snapshotIds = new Set(MODEL_SNAPSHOT.map((model) => model.id))
      const snapshotNames = new Set(MODEL_SNAPSHOT.map((model) => model.name))
      for (const [label, rscText] of [
        ["rsc-goat", RSC_GOAT],
        ["rsc-pro", RSC_PRO],
      ]) {
        const records = extractPlanPageRsc(rscText)
        const resolving = [...records].filter(
          ([sid, record]) => snapshotIds.has(sid) || snapshotNames.has(record.name ?? ""),
        )
        assert(
          resolving.length > 0,
          `${label}: no fixture record resolves to the snapshot — fixtures unreadable?`,
        )
        // Spot-check: the models that previously regressed are still covered
        // after the HTML → RSC switch.
        const names = new Set([...records.values()].map((r) => r.name))
        assert(names.has("GLM-5.3 Flash"), `${label}: GLM-5.3 Flash must be present`)
        assert(names.has("Qwen 3.8 Flash"), `${label}: Qwen 3.8 Flash must be present`)
        assert(
          names.has("DeepSeek V4 Flash Vision (exp)"),
          `${label}: DeepSeek V4 Flash Vision (exp) must be present`,
        )
      }
    },
  ],

  [
    "enrichment injects options.cmd for the previously-regressed models",
    () => {
      const config = {
        provider: {
          commandcode: {
            models: {
              "deepseek/deepseek-v4-flash-vision-exp": {
                name: "DeepSeek V4 Flash Vision (exp)",
                limit: { context: 1000000, output: 65536 },
              },
            },
          },
        },
      } as const
      enrichCommandCodeModels(config as never)
      const models = (
        config as never as {
          provider: { commandcode: { models: Record<string, Record<string, unknown>> } }
        }
      ).provider.commandcode.models
      const vision = models["deepseek/deepseek-v4-flash-vision-exp"].options
      assert(vision && typeof vision === "object" && "cmd" in vision, "vision must get cmd")
      const cmd = (vision as { cmd: Record<string, unknown> }).cmd
      assertEqual(cmd.tier, "opensource")
      assertEqual(cmd.free, false)
      assertEqual(cmd.allowance, { goat: 20, pro: 30 })
      assert(cmd.peakOffPeak, "vision must have peakOffPeak")
    },
  ],
])
