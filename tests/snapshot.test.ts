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
    "snapshot context lengths are positive (or null for pending rows whose models.md Context cell is missing)",
    () => {
      for (const model of MODEL_SNAPSHOT) {
        assert(
          model.contextLength === null ||
            (Number.isFinite(model.contextLength) && model.contextLength > 0),
          model.id,
        )
      }
    },
  ],

  [
    "snapshot rows carry ship-bar cost and efforts fields (models.md is the membership authority, issue #130)",
    () => {
      for (const model of MODEL_SNAPSHOT) {
        // A row may carry cost: null (missing price cell — the cost ladder
        // lands in #132) or efforts: null ("—" = model decides its own
        // depth), but the fields must exist on every row.
        assert("cost" in model, `${model.id}: missing cost field`)
        assert("efforts" in model, `${model.id}: missing efforts field`)
      }
    },
  ],
])
