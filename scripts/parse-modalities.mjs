// scripts/parse-modalities.mjs — extract input modalities from the
// command-code CLI bundle without executing it.
//
// The npm package does not publish modalities in models.md. The CLI bundle
// does publish them as model object fields, for example:
//   { id: "gpt-5.6-sol", inputModalities: ["text", "image"], ... }
//
// Parse the bundle as JavaScript instead of relying on minified source shape.
// Property order, nested objects, strings, templates, and regex literals are
// therefore handled by Acorn rather than by a lookahead regex.
import * as acorn from "acorn"

const VALID_MODALITIES = new Set(["text", "image"])

function walk(node, visit) {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue
    walk(value, visit)
  }
}

function propertyName(property) {
  if (property.computed) return undefined
  if (property.key.type === "Identifier") return property.key.name
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value
  }
  return undefined
}

function collectStringConstants(ast) {
  const constants = new Map()
  walk(ast, (node) => {
    if (node.type !== "VariableDeclarator") return
    if (
      node.id.type === "Identifier" &&
      node.init?.type === "Literal" &&
      typeof node.init.value === "string"
    ) {
      constants.set(node.id.name, node.init.value)
    }
  })
  return constants
}

function getProperty(object, name) {
  return object.properties.find(
    (property) => property.type === "Property" && propertyName(property) === name,
  )
}

function resolveString(node, constants) {
  if (!node) return undefined
  if (node.type === "Literal" && typeof node.value === "string") return node.value
  if (node.type === "Identifier") return constants.get(node.name)
  return undefined
}

function parseModalities(node, modelId) {
  if (!node || node.type !== "ArrayExpression") {
    throw new Error(`inputModalities for ${modelId} must be an array of strings`)
  }
  const modalities = node.elements.map((element) => {
    if (!element || element.type !== "Literal" || typeof element.value !== "string") {
      throw new Error(`inputModalities for ${modelId} must be an array of strings`)
    }
    return element.value
  })
  if (new Set(modalities).size !== modalities.length) {
    throw new Error(`inputModalities for ${modelId} contains duplicates`)
  }
  for (const modality of modalities) {
    if (!VALID_MODALITIES.has(modality)) {
      throw new Error(`inputModalities for ${modelId} contains unsupported value ${modality}`)
    }
  }
  return modalities
}

/**
 * Parse every model object carrying inputModalities from the CLI bundle.
 *
 * `modelIds` includes text-only entries so the refresh step can assert that
 * every API snapshot model was represented in the CLI bundle. `modalities`
 * contains only image-capable entries, matching the provider's existing
 * text-only fallback behavior.
 */
export function parseInputModalities(bundleSource) {
  let ast
  try {
    ast = acorn.parse(bundleSource, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    })
  } catch (error) {
    throw new Error(
      `could not parse command-code CLI bundle: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const constants = collectStringConstants(ast)
  const byId = new Map()
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return
    const idProperty = getProperty(node, "id")
    const modalitiesProperty = getProperty(node, "inputModalities")
    if (!idProperty || !modalitiesProperty) return
    // Catalog entries carry descriptive/context metadata. This excludes
    // nested runtime payloads that happen to reuse the same two property names.
    if (
      !getProperty(node, "name") &&
      !getProperty(node, "label") &&
      !getProperty(node, "contextWindow")
    ) {
      return
    }

    // Runtime request/config objects can carry `id: e.id`; they are not
    // catalog entries and cannot be resolved statically. Refresh coverage
    // below still fails if an actual catalog model is missing from the bundle.
    const id = resolveString(idProperty.value, constants)
    if (!id) return
    const modalities = parseModalities(modalitiesProperty.value, id)
    const existing = byId.get(id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(modalities)) {
      throw new Error(`conflicting inputModalities entries for ${id}`)
    }
    byId.set(id, modalities)
  })

  if (byId.size === 0) {
    throw new Error("no inputModalities model entries found in the command-code bundle")
  }

  const modalities = Object.fromEntries(
    [...byId.entries()]
      .filter(([, values]) => values.includes("image"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  return { modelIds: new Set(byId.keys()), modalities }
}
