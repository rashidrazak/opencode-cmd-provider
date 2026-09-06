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
 * `modelIds` includes text-only entries so the refresh step can report
 * which package-membership models lack CLI evidence (a pending report,
 * never a failure since issue #133 — the CLI bundle is enrichment).
 * `modalities`
 * contains only image-capable entries, matching the provider's existing
 * text-only fallback behavior.
 *
 * `contextWindows` maps every catalog id that carries a `contextWindow`
 * literal to its value (1e6 etc). This is the context ladder's second step
 * (issue #132: models.md Context cell → RSC contextWindow → CLI
 * contextWindow → carried-forward LKG). Some catalog entries omit it
 * (verified live: GLM-5.1, MiniMax M2.7, the Qwen 3.6 pair carry
 * `reasoning` but no `contextWindow`); absent entries simply do not
 * appear in the map.
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
  const contextWindows = {}
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
    // Collect the catalog entry's contextWindow literal (issue #132 — the
    // context ladder's second step). A second conflicting entry for the same
    // id is a loud shape failure (same rule as conflicting modalities).
    const contextProperty = getProperty(node, "contextWindow")
    if (contextProperty) {
      const value = resolveContextWindow(contextProperty.value, constants)
      if (value !== undefined) {
        const existing = contextWindows[id]
        if (existing !== undefined && existing !== value) {
          throw new Error(`conflicting contextWindow entries for ${id}`)
        }
        contextWindows[id] = value
      }
    }
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
  return { modelIds: new Set(byId.keys()), modalities, contextWindows }
}

// contextWindow literals parse as numbers (1e6, 105e4, 200000) — never as
// identifiers/aliases. A catalog entry whose contextWindow is not a numeric
// literal is a shape change (loud), never a silent skip.
function resolveContextWindow(node, constants) {
  if (!node) return undefined
  if (node.type === "Literal" && typeof node.value === "number") return node.value
  if (node.type === "Identifier") {
    const resolved = constants.get(node.name)
    if (typeof resolved === "string") {
      const numeric = Number(resolved)
      if (Number.isFinite(numeric)) return numeric
    }
    throw new Error(
      `could not parse contextWindow: expected a numeric literal or constant, got identifier "${node.name}"`,
    )
  }
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "Literal"
  ) {
    throw new Error("could not parse contextWindow: negative window")
  }
  throw new Error(`could not parse contextWindow: expected a numeric literal, got ${node.type}`)
}
