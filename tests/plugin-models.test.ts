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
import { assert, assertEqual, run } from "./harness.js"

const OPTIONS = {
  npm: "opencode-cmd-provider",
  name: "Command Code",
  baseURL: "https://api.commandcode.ai",
}

// Local snapshot fixture in the post-#130 CatalogModel shape (ship-bar
// fields per row: contextLength/efforts/cost, null = pending).
const SNAPSHOT: readonly CatalogModel[] = [
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextLength: 200000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash (latest)",
    contextLength: 1000000,
    efforts: ["high", "max"],
    cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
  },
  {
    id: "meta/muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
    contextLength: 1048576,
    efforts: null,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
  },
  // A pending-context row (models.md Context cell missing; the fallback
  // ladder lands in #132). Not free, not zero — the runtime must keep it
  // usable with a neutral context rather than mislabel it.
  { id: "unknown/foo", name: "Foo", contextLength: null, efforts: null, cost: null },
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
      // A pending-context row must not read as a 0-context or broken
      // model: the runtime advertises a conservative placeholder context
      // (PENDING_CONTEXT_LENGTH, 128000) until the #132 ladder resolves it.
      assertEqual(unknown.limit, { context: 128000, output: 65536 })

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
        // The auto-registered cost mirrors the model's own parsed ship-bar
        // row cost (issue #130): a null row cost advertises no cost entry.
        const expectedRegisteredCost =
          model.cost === null
            ? undefined
            : {
                input: model.cost.input,
                output: model.cost.output,
                cache_read: model.cost.cacheRead,
                cache_write: model.cost.cacheWrite,
              }
        assertEqual(
          registered.cost,
          expectedRegisteredCost,
          `${model.id} cost must mirror the row's parsed ship-bar cost`,
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
        {
          id: reasoningId,
          name: "Derived Reasoning",
          contextLength: 1000,
          efforts: null,
          cost: null,
        },
        { id: effortsId, name: "Efforts Model", contextLength: 2000, efforts: null, cost: null },
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
      // Data-driven from the row's parsed cost — a model is only "free"
      // when its models.md price cell is an explicit all-zero entry (a
      // missing cell — cost null — gets no suffix and no cost key).
      // The pin is on a model whose row carries a zero-cost entry
      // (`poolside/laguna-s-2.1-free`), not on a specific upstream
      // name-collision pair. The name-collision case (paid + free with
      // the same upstream name) used to be pinned here against MiniMax;
      // that case is now exercised by the upstream-data-dependent
      // catalog-refresh cron, not by this unit test.
      const config = {}
      autoRegister(
        config,
        [
          {
            id: "poolside/laguna-s-2.1-free",
            name: "Laguna S 2.1",
            contextLength: 256000,
            efforts: null,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        OPTIONS,
      )
      const entry = config.provider.commandcode
      assertEqual(entry.models["poolside/laguna-s-2.1-free"].name, "[CMD] Laguna S 2.1 (free)")
    },
  ],

  [
    "absent cost entries get no (free) suffix and no cost key; zero-cost entries always do",
    () => {
      // A row with cost: null (missing models.md price cell) is never
      // "free": no suffix, and no cost entry advertised. Only an explicit
      // all-zero cell earns the suffix. Laguna has one (its name does not
      // collide with a paid sibling, but the suffix is still informative).
      const config = {}
      autoRegister(
        config,
        [
          {
            id: "vendor/unknown-model",
            name: "Unknown Model",
            contextLength: 16000,
            efforts: null,
            cost: null,
          },
          {
            id: "poolside/laguna-s-2.1-free",
            name: "Laguna S 2.1",
            contextLength: 256000,
            efforts: null,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        OPTIONS,
      )
      const entry = config.provider.commandcode
      assertEqual(entry.models["vendor/unknown-model"].name, "[CMD] Unknown Model")
      assert(
        entry.models["vendor/unknown-model"].cost === undefined,
        "a null-cost row must advertise no cost entry",
      )
      assertEqual(entry.models["poolside/laguna-s-2.1-free"].name, "[CMD] Laguna S 2.1 (free)")
    },
  ],

  [
    "a pending-context row keeps a usable model: neutral context, never 0, never a fabricated API value",
    () => {
      // Issue #130: a package row whose models.md Context cell is missing
      // ("—") ships with contextLength: null (the fallback ladder lands in
      // #132). The runtime must keep the model usable with a well-formed
      // context rather than advertise a broken 0-context model.
      const config = {}
      autoRegister(
        config,
        [
          {
            id: "vendor/pending-ctx",
            name: "Pending Ctx",
            contextLength: null,
            efforts: null,
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
          },
        ],
        OPTIONS,
      )
      const entry = config.provider.commandcode
      assertEqual(entry.models["vendor/pending-ctx"].limit, { context: 128000, output: 65536 })
    },
  ],

  [
    "a missing-cost row is never zero-filled and never labeled free (missing ≠ all-zero)",
    () => {
      // Issue #130: a package row whose price cell is missing ("—") ships
      // with cost: null — the cost ladder lands in #132. Missing must never
      // read as a $0 model: the auto-registered entry advertises NO cost
      // entry (the config schema's cost is optional), and no (free) suffix
      // is appended (only an explicit all-zero catalog entry is free).
      const config = {}
      autoRegister(
        config,
        [
          {
            id: "vendor/pending-cost",
            name: "Pending Cost",
            contextLength: 100000,
            efforts: null,
            cost: null,
          },
        ],
        OPTIONS,
      )
      const entry = config.provider.commandcode
      assertEqual(entry.models["vendor/pending-cost"].name, "[CMD] Pending Cost")
      assert(
        entry.models["vendor/pending-cost"].cost === undefined,
        "a missing cost must advertise no cost entry, never a zero cost",
      )
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
