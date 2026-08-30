// tests/plugin-models.test.ts — snapshot auto-registration + config augmentation
// (issue #16)
import {
  autoRegister,
  augmentConfigCommandCodeModels,
  DEFAULT_DISPLAY_PREFIX,
  resolveDisplayPrefix,
} from "../src/plugin/core.js"
import type { CatalogModel } from "../src/catalog/snapshot.js"
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
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

      const sonnet = entry.models["claude-sonnet-5"]
      assertEqual(sonnet.name, "[CMD] Claude Sonnet 5")
      assertEqual(sonnet.limit, { context: 200000, output: 65536 })
      assertEqual(sonnet.reasoning, true)
      assertEqual(Object.keys(sonnet.variants ?? {}), ["low", "medium", "high", "xhigh", "max"])
      assertEqual(sonnet.modalities, { input: ["text", "image"] })
      assertEqual(sonnet.cost, { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 })
      assertEqual(sonnet.status, "active")

      const flash = entry.models["deepseek/deepseek-v4-flash"]
      assertEqual(flash.name, "[CMD] DeepSeek V4 Flash (latest)")
      assertEqual(flash.limit, { context: 1000000, output: 65536 })
      assertEqual(flash.reasoning, true)
      assertEqual(Object.keys(flash.variants ?? {}), ["high", "max"])

      const muse = entry.models["meta/muse-spark-1.2-contributor"]
      assertEqual(muse.name, "[CMD] Muse Spark 1.2 Contributor")
      assertEqual(muse.limit, { context: 1048576, output: 65536 })
      assertEqual(muse.reasoning, true)
      assertEqual(muse.variants, undefined)
      assertEqual(muse.modalities, { input: ["text", "image"] })
      assertEqual(muse.cost, { input: 0.1, output: 0.2, cache_read: 0.002, cache_write: 0 })
      assertEqual(muse.status, "active")

      const unknown = entry.models["unknown/foo"]
      assertEqual(unknown.name, "[CMD] Foo")
      assertEqual(unknown.limit, { context: 16000, output: 16000 })
      assertEqual(unknown.reasoning, undefined)
      assertEqual(unknown.variants, undefined)
      assertEqual(unknown.modalities, { input: ["text"] })
      assertEqual(unknown.cost, { input: 0, output: 0, cache_read: 0, cache_write: 0 })
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
    "omits the env hint when the user declared a static options.apiKey (issue #102)",
    () => {
      // Upstream #34388: a registered `env` array can block the config key on
      // affected v1 builds, and a static key makes the hint pointless anyway.
      const config = {
        provider: {
          commandcode: {
            options: { apiKey: "sk-static" },
          },
        },
      }
      autoRegister(config, SNAPSHOT, OPTIONS)
      const entry = config.provider.commandcode
      assertEqual(entry.options.apiKey, "sk-static")
      assertEqual(entry.env, undefined)
      assertEqual(entry.options.baseURL, OPTIONS.baseURL)
      assert(Object.keys(entry.models ?? {}).length > 0)
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
      const config = {}
      // Real snapshot: upstream names the paid and free MiniMax variants
      // identically, so the display name must disambiguate the free ones.
      autoRegister(config, MODEL_SNAPSHOT, OPTIONS)
      const entry = config.provider.commandcode
      assertEqual(entry.models["MiniMaxAI/MiniMax-M3"].name, "[CMD] MiniMax M3")
      assertEqual(entry.models["MiniMaxAI/MiniMax-M2.7"].name, "[CMD] MiniMax M2.7")
      assertEqual(entry.models["minimax/minimax-m3-free"].name, "[CMD] MiniMax M3 (free)")
      assertEqual(entry.models["minimax/minimax-m2.7-free"].name, "[CMD] MiniMax M2.7 (free)")
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
              "moonshotai/Kimi-K2.6": {
                name: "Kimi K2.6",
                limit: { context: 256000, output: 65536 },
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
      const kimi = config.provider.commandcode.models["moonshotai/Kimi-K2.6"] as {
        reasoning?: boolean
      }
      assertEqual(kimi.reasoning, undefined)
    },
  ],

  [
    "config hook marks reasoning-capable models without variants as reasoning",
    () => {
      const config = {
        provider: {
          commandcode: {
            name: "Command Code",
            models: {
              "meta/muse-spark-1.2-contributor": {
                name: "Muse Spark 1.2 Contributor",
                limit: { context: 1048576, output: 65536 },
              },
              "moonshotai/Kimi-K2.6": {
                name: "Kimi K2.6",
                limit: { context: 256000, output: 65536 },
              },
            },
          },
        },
      } as const
      augmentConfigCommandCodeModels(config as never)
      const muse = config.provider.commandcode.models["meta/muse-spark-1.2-contributor"] as {
        reasoning?: boolean
        variants?: Record<string, { reasoningEffort: string }>
      }
      assertEqual(muse.reasoning, true)
      assertEqual(muse.variants, undefined)
      const kimi = config.provider.commandcode.models["moonshotai/Kimi-K2.6"] as {
        reasoning?: boolean
        variants?: Record<string, { reasoningEffort: string }>
      }
      assertEqual(kimi.reasoning, undefined)
      assertEqual(kimi.variants, undefined)
    },
  ],
])
