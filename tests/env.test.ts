// tests/env.test.ts — COMMANDCODE_* env helpers
import { getApiBase } from "../src/env.js"
import { assertEqual, run } from "./harness.js"

run([
  [
    "default API base matches the pi provider",
    () => {
      assertEqual(getApiBase({}), "https://api.commandcode.ai")
    },
  ],

  [
    "env override is honored",
    () => {
      assertEqual(
        getApiBase({ COMMANDCODE_API_BASE: "http://127.0.0.1:9999" }),
        "http://127.0.0.1:9999",
      )
    },
  ],
])
