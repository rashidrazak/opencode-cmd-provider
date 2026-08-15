// tests/snapshot.test.ts — committed snapshot shape (issue #16, seam 2)
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { assert, assertEqual, run } from "./harness.js"

run([
  [
    "snapshot is non-empty",
    () => {
      assert(MODEL_SNAPSHOT.length > 0, "snapshot must not be empty")
    },
  ],

  [
    "snapshot ids are unique",
    () => {
      const ids = new Set(MODEL_SNAPSHOT.map((model) => model.id))
      assertEqual(ids.size, MODEL_SNAPSHOT.length)
    },
  ],

  [
    "snapshot entries carry non-empty names",
    () => {
      for (const model of MODEL_SNAPSHOT) {
        assert(typeof model.name === "string" && model.name.length > 0, model.id)
      }
    },
  ],

  [
    "snapshot context lengths are positive",
    () => {
      for (const model of MODEL_SNAPSHOT) {
        assert(Number.isFinite(model.contextLength) && model.contextLength > 0, model.id)
      }
    },
  ],
])
