// tests/parse-modalities.test.ts — AST parser for CLI input modalities
import { parseInputModalities } from "../scripts/parse-modalities.mjs"
import { assertEqual, run, throws } from "./harness.js"

const BUNDLE = `
  const ALIAS = "alias/model"
  const MODELS = {
    FIRST: {
      label: "description with } and commas, inside a string",
      inputModalities: ["text", "image"],
      id: "first/model",
      nested: { id: "not-a-model", inputModalities: ["text"] },
    },
    SECOND: { id: ALIAS, name: "Alias", inputModalities: ["text"] },
    THIRD: { inputModalities: ["text"], id: "third/model", name: "Third" },
    RUNTIME: { id: request.id, inputModalities: ["text", "image"] },
  }
  const template = \`ignore \\${{ braces: true }}\`
  const regex = /[{}]/
`

run([
  [
    "collects contextWindows for catalog entries that carry them",
    () => {
      const withCtx = `const MODELS = {
        FIRST: { id: "first/model", name: "First", inputModalities: ["text"], contextWindow: 2e5 },
        SECOND: { id: "second/model", label: "Second", inputModalities: ["text"], contextWindow: 1e6 },
      }`
      const result = parseInputModalities(withCtx)
      assertEqual(result.contextWindows, { "first/model": 200000, "second/model": 1000000 })
    },
  ],
  [
    "omits contextWindows when a catalog entry has none; rejects a conflicting duplicate",
    () => {
      const noCtx = `const MODELS = {
        FIRST: { id: "first/model", name: "First", inputModalities: ["text"] },
      }`
      assertEqual(parseInputModalities(noCtx).contextWindows, {})
      const conflict = `const MODELS = {
        FIRST: { id: "first/model", name: "First", inputModalities: ["text"], contextWindow: 1e6 },
        SECOND: { id: "first/model", name: "First", inputModalities: ["text"], contextWindow: 2e5 },
      }`
      throws(
        () => parseInputModalities(conflict),
        /conflicting contextWindow entries for first\/model/,
      )
    },
  ],
  [
    "extracts modalities independent of property order",
    () => {
      const result = parseInputModalities(BUNDLE)
      assertEqual([...result.modelIds].sort(), ["alias/model", "first/model", "third/model"])
      assertEqual(result.modalities, { "first/model": ["text", "image"] })
    },
  ],

  [
    "allows duplicate identical entries",
    () => {
      const result = parseInputModalities(
        `const models = [{id: "same/model", name: "Same", inputModalities: ["text", "image"]}, {inputModalities: ["text", "image"], id: "same/model", name: "Same"}]`,
      )
      assertEqual(result.modalities, { "same/model": ["text", "image"] })
    },
  ],

  [
    "rejects conflicting duplicate entries",
    () => {
      throws(
        () =>
          parseInputModalities(
            `const models = [{id: "same/model", name: "Same", inputModalities: ["text"]}, {id: "same/model", name: "Same", inputModalities: ["text", "image"]}]`,
          ),
        /conflicting inputModalities entries for same\/model/,
      )
    },
  ],

  [
    "rejects unsupported modality values",
    () => {
      throws(
        () =>
          parseInputModalities(
            `const model = {id: "bad/model", name: "Bad", inputModalities: ["audio"]}`,
          ),
        /unsupported value audio/,
      )
    },
  ],

  [
    "rejects malformed JavaScript instead of silently returning no models",
    () => {
      throws(() => parseInputModalities(`const model = {id: "broken/model"`), /could not parse/)
    },
  ],
])
