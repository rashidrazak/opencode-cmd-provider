// tests/env.test.ts — COMMANDCODE_* env helpers (PLAN #2 Part A)
import { getModelsTimeoutMs, getApiBase, getModelsUrl, getDataDir } from "../src/env.js"
import { assertEqual, run } from "./harness.js"

run([
  [
    "defaults match the pi provider",
    () => {
      assertEqual(getModelsTimeoutMs({}), 10_000)
      assertEqual(getApiBase({}), "https://api.commandcode.ai")
      assertEqual(getModelsUrl({}), "https://api.commandcode.ai/provider/v1/models")
    },
  ],

  [
    "invalid timeout falls back to default",
    () => {
      assertEqual(getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "-5" }), 10_000)
      assertEqual(getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "abc" }), 10_000)
    },
  ],

  [
    "env overrides are honored",
    () => {
      assertEqual(
        getApiBase({ COMMANDCODE_API_BASE: "http://127.0.0.1:9999" }),
        "http://127.0.0.1:9999",
      )
      assertEqual(
        getModelsUrl({ COMMANDCODE_MODELS_URL: "http://127.0.0.1:9999/models" }),
        "http://127.0.0.1:9999/models",
      )
      assertEqual(getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "2500" }), 2500)
    },
  ],

  [
    "data dir resolves XDG_DATA_HOME, then HOME/.local/share/opencode",
    () => {
      assertEqual(
        getDataDir({ XDG_DATA_HOME: "/x" }, () => "/home/u"),
        "/x",
      )
      assertEqual(
        getDataDir({}, () => "/home/u"),
        "/home/u/.local/share/opencode",
      )
    },
  ],
])
