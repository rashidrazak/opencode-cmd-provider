// tests/plugin-models.test.ts — catalog → opencode Model mapping (PLAN #11)
import { catalogToOpenCodeModels } from "../src/plugin/models.js"
import { commandCodeModelsFromApiResponse } from "../src/provider/models.js"
import { assert, assertEqual, run } from "./harness.js"

run([
  [
    "maps catalog models to opencode Model shape",
    () => {
      const models = commandCodeModelsFromApiResponse({
        object: "list",
        data: [
          { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 200000 },
          { id: "unknown/foo", name: "Foo", context_length: 16000 },
        ],
      })
      const mapped = catalogToOpenCodeModels(models, {
        npm: "opencode-cmd-provider",
        url: "https://api.commandcode.ai",
      })
      const sonnet = mapped["claude-sonnet-5"]
      assert(sonnet, "sonnet missing")
      assertEqual(sonnet.api.id, "claude-sonnet-5")
      assertEqual(sonnet.api.npm, "opencode-cmd-provider")
      assertEqual(sonnet.api.url, "https://api.commandcode.ai")
      assertEqual(sonnet.capabilities.reasoning, true)
      assertEqual(sonnet.capabilities.attachment, true)
      assertEqual(sonnet.capabilities.toolcall, true)
      assertEqual(sonnet.capabilities.interleaved, false)
      assertEqual(sonnet.limit, { context: 200000, output: 65536 })
      assertEqual(sonnet.status, "active")
      const unknown = mapped["unknown/foo"]
      assertEqual(unknown.capabilities.reasoning, false)
      assertEqual(unknown.capabilities.attachment, false)
      assertEqual(unknown.cost.input, 0)
    },
  ],

  [
    "models hook returns empty map when catalog is empty",
    () => {
      const mapped = catalogToOpenCodeModels([], {
        npm: "opencode-cmd-provider",
        url: "https://api.commandcode.ai",
      })
      assertEqual(mapped, {})
    },
  ],
])
