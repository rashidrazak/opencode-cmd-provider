// tests/plugin-models.test.ts — snapshot auto-registration + config augmentation
// (issue #16)
import {
  autoRegister,
  augmentConfigCommandCodeModels,
  DEFAULT_DISPLAY_PREFIX,
  resolveDisplayPrefix,
} from "../src/plugin/models.js"
import type { CatalogModel } from "../src/catalog/snapshot.js"
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import {
  MODEL_EFFORTS,
  REASONING_MODELS,
  isReasoningModel,
  reasoningVariantsForModel,
} from "../src/provider/reasoning.js"
import { inputModalitiesForModel } from "../src/provider/modalities.js"
import { MODEL_COSTS, ZERO_MODEL_COST } from "../src/provider/pricing.js"
import { assert, assertEqual, run } from "./harness.js"

const OPTIONS = {
  npm: "opencode-cmd-provider",
  name: "Command Code",
  baseURL: "https://api.commandcode.ai",
}

const SNAPSHOT: readonly CatalogModel[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 200000 },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)", contextLength: 1000000 },
  {
    id: "meta/muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
    contextLength: 1048576,
  },
  { id: "unknown/foo", name: "Foo", contextLength: 16000 },
]

run([
  [
    "auto-registers the provider entry into an empty config",
    () => {
      const config = {}
      const returned = autoRegister(config, SNAPSHOT, OPTIONS)
      assert(returned === config, "autoRegister must return the same config object")
      const entry = config.provider.commandcode
      assert(entry, "provider.commandcode missing")
      assertEqual(entry.npm, "opencode-cmd-provider")
      assertEqual(entry.name, "Command Code")
      assertEqual(entry.env, ["COMMANDCODE_API_KEY"])
      assertEqual(entry.options, { baseURL: "https://api.commandcode.ai" })
      assertEqual(Object.keys(entry.models ?? {}).length, 4)

      // Wiring (names, limits, prefix) is pinned to the local snapshot
      // fixture; upstream-owned metadata (reasoning, variants, modalities,
      // cost) is asserted as a **relation to the generated catalogs** — the
      // same tables the runtime consumes — and never re-typed (issue #108:
      // an upstream value change must never break this suite).
      const sonnet = entry.models["claude-sonnet-5"]
      assertEqual(sonnet.name, "[CMD] Claude Sonnet 5")
      assertEqual(sonnet.limit, { context: 200000, output: 65536 })
      assertEqual(sonnet.status, "active")

      const flash = entry.models["deepseek/deepseek-v4-flash"]
      assertEqual(flash.name, "[CMD] DeepSeek V4 Flash (latest)")
      assertEqual(flash.limit, { context: 1000000, output: 65536 })

      const muse = entry.models["meta/muse-spark-1.2-contributor"]
      assertEqual(muse.name, "[CMD] Muse Spark 1.2 Contributor")
      assertEqual(muse.limit, { context: 1048576, output: 65536 })
      assertEqual(muse.status, "active")

      const unknown = entry.models["unknown/foo"]
      assertEqual(unknown.name, "[CMD] Foo")
      assertEqual(unknown.limit, { context: 16000, output: 16000 })

      const expectedCost = (id: string) => {
        const costs = MODEL_COSTS[id] ?? ZERO_MODEL_COST
        return {
          input: costs.input,
          output: costs.output,
          cache_read: costs.cacheRead,
          cache_write: costs.cacheWrite,
        }
      }
      for (const model of SNAPSHOT) {
        const registered = entry.models[model.id]
        assertEqual(
          registered.reasoning,
          isReasoningModel(model.id) ? true : undefined,
          `${model.id} reasoning flag must mirror the generated classification`,
        )
        assertEqual(
          registered.variants ?? undefined,
          reasoningVariantsForModel(model.id),
          `${model.id} variants must mirror the generated efforts facts`,
        )
        assertEqual(
          registered.modalities,
          { input: [...inputModalitiesForModel(model.id)] },
          `${model.id} modalities must mirror the generated modality facts`,
        )
        assertEqual(
          registered.cost,
          expectedCost(model.id),
          `${model.id} cost must mirror the generated pricing facts`,
        )
      }
    },
  ],

  [
    "auto-registration advertises a derived reasoning-without-efforts model without variants, and an efforts model with variants",
    () => {
      // End-to-end derivation check (issue #111): the model ids are picked
      // from the generated catalogs at runtime — no upstream value pins —
      // and pushed through the public auto-registration export.
      const reasoningId = [...REASONING_MODELS][0]
      assert(reasoningId, "the derived reasoning-without-efforts set must not be empty")
      const effortsId = Object.keys(MODEL_EFFORTS)[0]
      assert(effortsId, "the generated efforts facts must not be empty")
      const snapshot: readonly CatalogModel[] = [
        { id: reasoningId, name: "Derived Reasoning", contextLength: 1000 },
        { id: effortsId, name: "Efforts Model", contextLength: 2000 },
      ]
      const config = {}
      autoRegister(config, snapshot, OPTIONS)
      const entry = config.provider.commandcode
      // A reasoning-capable model without efforts: `reasoning: true` with
      // no variants (opencode has nothing to cycle).
      const reasoning = entry.models[reasoningId]
      assertEqual(reasoning.reasoning, true)
      assertEqual(reasoning.variants, undefined)
      // An efforts model: its variants come from the generated efforts
      // facts, one per supported effort.
      const efforts = entry.models[effortsId]
      assertEqual(efforts.reasoning, true)
      assertEqual(
        Object.keys(efforts.variants ?? {}),
        [...MODEL_EFFORTS[effortsId]],
        "variants must mirror the generated efforts entry",
      )
    },
  ],

  [
    "injects nothing when the snapshot is empty",
    () => {
      const config = { provider: { openai: { npm: "x" } } }
      autoRegister(config, [], OPTIONS)
      assertEqual(Object.keys(config.provider), ["openai"])
    },
  ],

  [
    "leaves a declared commandcode entry untouched when the snapshot is empty",
    () => {
      const declared = {
        "claude-sonnet-5": {
          name: "My Sonnet",
          limit: { context: 999, output: 999 },
        },
      }
      const config = {
        provider: {
          commandcode: {
            name: "My CC",
            options: { baseURL: "http://custom" },
            models: declared,
          },
        },
      }
      autoRegister(config, [], OPTIONS)
      assertEqual(config.provider.commandcode, {
        name: "My CC",
        options: { baseURL: "http://custom" },
        models: declared,
      })
    },
  ],

  [
    "merges with a user-declared entry without touching user models",
    () => {
      const declared = {
        "my-sonnet": {
          id: "claude-sonnet-5",
          name: "My Sonnet",
          limit: { context: 999, output: 999 },
        },
        "retired-model": {
          name: "Retired",
          limit: { context: 1000, output: 1000 },
        },
      }
      const config = {
        provider: {
          commandcode: {
            name: "My CC",
            env: ["MY_CC_KEY"],
            options: { baseURL: "http://custom" },
            models: declared,
          },
        },
      }
      autoRegister(config, SNAPSHOT, OPTIONS)
      const entry = config.provider.commandcode
      assertEqual(entry.name, "My CC")
      assertEqual(entry.env, ["MY_CC_KEY"])
      assertEqual(entry.options, { baseURL: "http://custom" })
      assertEqual(entry.npm, "opencode-cmd-provider")

      assertEqual(entry.models["my-sonnet"], declared["my-sonnet"])
      assertEqual(entry.models["retired-model"], declared["retired-model"])
      assert(entry.models["claude-sonnet-5"] === undefined, "id-mapped model must not duplicate")
      const flash = entry.models["deepseek/deepseek-v4-flash"]
      assertEqual(flash.name, "[CMD] DeepSeek V4 Flash (latest)")
    },
  ],

  [
    "keeps provider-level declared settings when only some are declared",
    () => {
      const config = {
        provider: {
          commandcode: {
            name: "Custom Name",
          },
        },
      }
      autoRegister(config, SNAPSHOT, OPTIONS)
      const entry = config.provider.commandcode
      assertEqual(entry.name, "Custom Name")
      assertEqual(entry.npm, "opencode-cmd-provider")
      assertEqual(entry.env, ["COMMANDCODE_API_KEY"])
      assertEqual(entry.options, { baseURL: "https://api.commandcode.ai" })
    },
  ],

  [
    "resolveDisplayPrefix falls back to the [CMD] default",
    () => {
      assertEqual(DEFAULT_DISPLAY_PREFIX, "[CMD] ")
      assertEqual(resolveDisplayPrefix(undefined), "[CMD] ")
      assertEqual(resolveDisplayPrefix({}), "[CMD] ")
      assertEqual(resolveDisplayPrefix({ options: {} }), "[CMD] ")
      assertEqual(resolveDisplayPrefix({ options: { display_prefix: 42 } }), "[CMD] ")
    },
  ],

  [
    "display_prefix overrides auto-registered model names",
    () => {
      const config = {
        provider: {
          commandcode: {
            options: { display_prefix: "CC/" },
          },
        },
      }
      autoRegister(config, SNAPSHOT, OPTIONS)
      const entry = config.provider.commandcode
      assertEqual(entry.models["claude-sonnet-5"].name, "CC/Claude Sonnet 5")
      assertEqual(entry.models["unknown/foo"].name, "CC/Foo")
    },
  ],

  [
    "an empty display_prefix disables the prefix entirely",
    () => {
      const config = {
        provider: {
          commandcode: {
            options: { display_prefix: "" },
          },
        },
      }
      autoRegister(config, SNAPSHOT, OPTIONS)
      const entry = config.provider.commandcode
      assertEqual(entry.models["claude-sonnet-5"].name, "Claude Sonnet 5")
      assertEqual(entry.models["deepseek/deepseek-v4-flash"].name, "DeepSeek V4 Flash (latest)")
      // Non-name metadata must be unaffected.
      assertEqual(entry.models["claude-sonnet-5"].limit, { context: 200000, output: 65536 })
      assertEqual(entry.models["claude-sonnet-5"].reasoning, true)
    },
  ],

  [
    "declared models keep their names; empty prefix also applies to auto-registered ones",
    () => {
      const declared = {
        "my-sonnet": {
          id: "claude-sonnet-5",
          name: "My Sonnet",
          limit: { context: 999, output: 999 },
        },
      }
      const config = {
        provider: {
          commandcode: {
            options: { display_prefix: "" },
            models: declared,
          },
        },
      }
      autoRegister(config, SNAPSHOT, OPTIONS)
      const entry = config.provider.commandcode
      // Declared entries are preserved verbatim.
      assertEqual(entry.models["my-sonnet"], declared["my-sonnet"])
      // The empty prefix applies to auto-registered models.
      assertEqual(entry.models["unknown/foo"].name, "Foo")
    },
  ],

  [
    "auto-registered models advertise tool call support",
    () => {
      const config = {}
      autoRegister(config, SNAPSHOT, OPTIONS)
      const entry = config.provider.commandcode
      for (const [id, model] of Object.entries(entry.models ?? {})) {
        assertEqual(model.tool_call, true, `${id} must set tool_call`)
      }
    },
  ],

  [
    "free variants get a (free) suffix so paid and free models are distinguishable",
    () => {
      // Data-driven from the zero cost table — a model is only
      // "free" when the catalog has an actual zero-cost entry (an
      // absent entry falls back to ZERO_MODEL_COST and is NOT free).
      // The pin is on a model that has a zero-cost entry in the
      // generated facts (`poolside/laguna-s-2.1-free`), not on a
      // specific upstream name-collision pair. The name-collision
      // case (paid + free with the same upstream name) used to be
      // pinned here against MiniMax; that case is now exercised by
      // the upstream-data-dependent catalog-refresh cron, not by
      // this unit test.
      const config = {}
      autoRegister(
        config,
        [{ id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1", contextLength: 256000 }],
        OPTIONS,
      )
      const entry = config.provider.commandcode
      assertEqual(entry.models["poolside/laguna-s-2.1-free"].name, "[CMD] Laguna S 2.1 (free)")
    },
  ],

  [
    "absent cost entries get no (free) suffix; zero-cost entries always do",
    () => {
      // A model missing from MODEL_COSTS falls back to ZERO_MODEL_COST but is
      // deliberately NOT free — only an explicit zero-cost catalog entry earns
      // the suffix. Laguna has one (its name does not collide with a paid
      // sibling, but the suffix is still informative).
      const config = {}
      autoRegister(
        config,
        [
          { id: "vendor/unknown-model", name: "Unknown Model", contextLength: 16000 },
          { id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1", contextLength: 256000 },
        ],
        OPTIONS,
      )
      const entry = config.provider.commandcode
      assertEqual(entry.models["vendor/unknown-model"].name, "[CMD] Unknown Model")
      assertEqual(entry.models["poolside/laguna-s-2.1-free"].name, "[CMD] Laguna S 2.1 (free)")
    },
  ],

  [
    "config hook augments config-declared commandcode models with variants",
    () => {
      const config = {
        provider: {
          commandcode: {
            name: "Command Code",
            models: {
              "deepseek/deepseek-v4-flash": {
                name: "DeepSeek V4 Flash",
                limit: { context: 1000000, output: 384000 },
              },
              "unknown/foo": {
                name: "Foo",
                limit: { context: 16000, output: 4096 },
              },
            },
          },
        },
      } as const
      augmentConfigCommandCodeModels(config as never)
      const flash = config.provider.commandcode.models["deepseek/deepseek-v4-flash"] as {
        reasoning?: boolean
        variants?: Record<string, { reasoningEffort: string }>
      }
      assertEqual(flash.reasoning, true)
      assertEqual(Object.keys(flash.variants ?? {}), ["high", "max"])
      assertEqual(flash.variants?.["high"], { reasoningEffort: "high" })
      const unknown = config.provider.commandcode.models["unknown/foo"] as {
        reasoning?: boolean
        variants?: Record<string, { reasoningEffort: string }>
      }
      assertEqual(unknown.reasoning, undefined)
      assertEqual(unknown.variants, undefined)
    },
  ],

  [
    "config hook fills reasoning metadata only where the user left it unset",
    () => {
      const config = {
        provider: {
          commandcode: {
            name: "Command Code",
            models: {
              "deepseek/deepseek-v4-flash": {
                name: "DeepSeek V4 Flash",
                limit: { context: 1000000, output: 384000 },
                reasoning: false,
              },
              "meta/muse-spark-1.2-contributor": {
                name: "Muse Spark 1.2 Contributor",
                limit: { context: 1048576, output: 65536 },
                reasoning: false,
              },
              "vendor/not-in-any-catalog": {
                name: "Not In Any Catalog",
                limit: { context: 16000, output: 65536 },
              },
            },
          },
        },
      } as const
      augmentConfigCommandCodeModels(config as never)
      const flash = config.provider.commandcode.models["deepseek/deepseek-v4-flash"] as {
        reasoning?: boolean
        variants?: Record<string, { reasoningEffort: string }>
      }
      assertEqual(flash.reasoning, false, "declared reasoning: false must survive augmentation")
      assertEqual(
        flash.variants,
        undefined,
        "variants must not be injected when reasoning is disabled",
      )
      const muse = config.provider.commandcode.models["meta/muse-spark-1.2-contributor"] as {
        reasoning?: boolean
        variants?: Record<string, { reasoningEffort: string }>
      }
      assertEqual(muse.reasoning, false, "declared reasoning: false must survive augmentation")
      assertEqual(muse.variants, undefined)
      const notInCatalog = config.provider.commandcode.models["vendor/not-in-any-catalog"] as {
        reasoning?: boolean
        variants?: Record<string, { reasoningEffort: string }>
      }
      assertEqual(notInCatalog.reasoning, undefined)
      assertEqual(notInCatalog.variants, undefined)
    },
  ],

  [
    "config hook marks reasoning-capable models without variants as reasoning",
    () => {
      // The reasoning-capable id comes from the **derived** reasoning-
      // without-efforts set (issue #108) — never a pinned upstream id, which
      // upstream can promote to an efforts model at any time (that exact
      // promotion broke the muse-spark pin on 2026-09-03). The non-reasoning
      // control is an id absent from every generated catalog.
      const reasoningId = [...REASONING_MODELS][0]
      assert(reasoningId, "the derived reasoning-without-efforts set must not be empty")
      const config = {
        provider: {
          commandcode: {
            name: "Command Code",
            models: {
              [reasoningId]: {
                name: "Derived Reasoning Model",
                limit: { context: 1048576, output: 65536 },
              },
              "vendor/not-in-any-catalog": {
                name: "Not In Any Catalog",
                limit: { context: 16000, output: 65536 },
              },
            },
          },
        },
      } as const
      augmentConfigCommandCodeModels(config as never)
      const models = config.provider.commandcode.models as Record<
        string,
        { reasoning?: boolean; variants?: Record<string, { reasoningEffort: string }> }
      >
      const reasoning = models[reasoningId]
      assertEqual(reasoning.reasoning, true)
      assertEqual(reasoning.variants, undefined)
      const notInCatalog = models["vendor/not-in-any-catalog"]
      assertEqual(notInCatalog.reasoning, undefined)
      assertEqual(notInCatalog.variants, undefined)
    },
  ],
])
