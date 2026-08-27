// tests/deals-coverage.test.ts — every snapshot model must have a deals
// record so the TUI sidebar "Command Code" section renders for every model
// (issue: Ox Alpha / DeepSeek V4 Flash Vision (exp) showed no section because
// the docs fixtures predated them).
import { readFileSync } from "node:fs"
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { MODEL_DEALS } from "../src/deals/catalog.js"
import { enrichCommandCodeModels } from "../src/deals/enrichment.js"
import { extractModelRecords } from "../scripts/parse-docs.mjs"
import { assert, assertEqual, run } from "./harness.js"

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
    "every fixture record maps to a snapshot model (no drift)",
    () => {
      const snapshotIds = new Set(MODEL_SNAPSHOT.map((model) => model.id))
      const snapshotNames = new Set(MODEL_SNAPSHOT.map((model) => model.name))
      for (const fixture of ["goat.html", "pro.html"]) {
        const html = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf-8")
        for (const record of extractModelRecords(html).values()) {
          assert(
            snapshotNames.has(record.name),
            `${fixture}: docs record "${record.name}" is not in the snapshot`,
          )
        }
        // spot-check: the models that previously regressed are now covered
        assert(
          [...extractModelRecords(html).values()].some(
            (r) => r.name === "GLM-5.3 Flash",
          ),
          `${fixture}: GLM-5.3 Flash must be present`,
        )
        assert(
          [...extractModelRecords(html).values()].some(
            (r) => r.name === "Qwen 3.8 Flash",
          ),
          `${fixture}: Qwen 3.8 Flash must be present`,
        )
        assert(
          [...extractModelRecords(html).values()].some(
            (r) => r.name === "DeepSeek V4 Flash Vision (exp)",
          ),
          `${fixture}: DeepSeek V4 Flash Vision (exp) must be present`,
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
