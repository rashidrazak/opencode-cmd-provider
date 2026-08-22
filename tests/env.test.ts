// tests/env.test.ts — COMMANDCODE_* env helpers
import { getApiBase, getCmdZdr } from "../src/env.js"
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

  [
    "CMD_ZDR=1 opts into ZDR",
    () => {
      assertEqual(getCmdZdr({ CMD_ZDR: "1" }), true)
    },
  ],

  [
    "CMD_ZDR is off when unset, empty, 0, or any non-1 value",
    () => {
      assertEqual(getCmdZdr({}), false, "unset → off")
      assertEqual(getCmdZdr({ CMD_ZDR: "" }), false, "empty → off")
      assertEqual(getCmdZdr({ CMD_ZDR: "0" }), false, "0 → off")
      assertEqual(getCmdZdr({ CMD_ZDR: "true" }), false, "true → off")
      assertEqual(getCmdZdr({ CMD_ZDR: "yes" }), false, "yes → off")
      assertEqual(getCmdZdr({ CMD_ZDR: "2" }), false, "2 → off")
    },
  ],
])
