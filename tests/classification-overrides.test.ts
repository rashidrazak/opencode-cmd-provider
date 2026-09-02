// tests/classification-overrides.test.ts — seam: the reasoning-classification
// override map (scripts/classification-overrides.mjs). Modeled on the
// tier-overrides pattern (ADR-0005's one judgment seam): the map pins a
// model's reasoning capability only when upstream's own surfaces
// contradict each other, every entry carries a written justification
// naming the disagreement, and the map starts empty (issue #110).
import {
  CLASSIFICATION_OVERRIDES,
  applyClassificationOverride,
  validateClassificationOverrides,
} from "../scripts/classification-overrides.mjs"
import { assert, assertEqual, run } from "./harness.js"

run([
  [
    "CLASSIFICATION_OVERRIDES starts empty (upstream data is truth by default)",
    () => {
      assertEqual(Object.keys(CLASSIFICATION_OVERRIDES).length, 0)
    },
  ],
  [
    "applyClassificationOverride passes the upstream flag through when no override exists",
    () => {
      assertEqual(applyClassificationOverride("claude-sonnet-5", true), true)
      assertEqual(applyClassificationOverride("moonshotai/Kimi-K2.6", false), false)
    },
  ],
  [
    "applyClassificationOverride: an override entry wins over the upstream flag",
    () => {
      const overrides = {
        "moonshotai/Kimi-K3": {
          capability: false,
          justification: "upstream RSC flag says true but models.md omits reasoning",
        },
      }
      assertEqual(applyClassificationOverride("moonshotai/Kimi-K3", true, overrides), false)
      // Models without an entry keep the upstream value.
      assertEqual(applyClassificationOverride("claude-sonnet-5", true, overrides), true)
    },
  ],
  [
    "validateClassificationOverrides accepts a well-formed entry",
    () => {
      validateClassificationOverrides({
        "moonshotai/Kimi-K3": {
          capability: false,
          justification: "upstream RSC flag says true but models.md omits reasoning",
        },
      })
    },
  ],
  [
    "validateClassificationOverrides rejects a note-less entry, naming the model",
    () => {
      let message = ""
      try {
        validateClassificationOverrides({ "moonshotai/Kimi-K3": { capability: false } })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      assert(
        message.includes("moonshotai/Kimi-K3") && /justification/.test(message),
        `expected a loud justification failure naming the model, got: ${message}`,
      )
    },
  ],
  [
    "validateClassificationOverrides rejects an empty justification, naming the model",
    () => {
      let message = ""
      try {
        validateClassificationOverrides({
          "moonshotai/Kimi-K3": { capability: true, justification: "   " },
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      assert(
        message.includes("moonshotai/Kimi-K3"),
        `expected the failure to name the offending model, got: ${message}`,
      )
    },
  ],
  [
    "validateClassificationOverrides rejects a non-boolean capability, naming the model",
    () => {
      let message = ""
      try {
        validateClassificationOverrides({
          "moonshotai/Kimi-K3": { capability: "true", justification: "a reason" },
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      assert(
        message.includes("moonshotai/Kimi-K3") && /capability/.test(message),
        `expected a loud capability failure naming the model, got: ${message}`,
      )
    },
  ],
])
