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
