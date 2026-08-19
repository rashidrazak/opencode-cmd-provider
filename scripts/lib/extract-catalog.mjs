// scripts/lib/extract-catalog.mjs — parse the bundled model catalog out of the
// command-code CLI bundle so refresh-snapshot.mjs can regenerate the static
// reasoning-effort and input-modality tables. Runs at release time; never at
// runtime.
//
// The command-code package ships its catalog as minified JS
// (dist/cli.mjs) with entries shaped like:
//   KEY:{id:"model-id",inputModalities:["text","image"],...,reasoningEfforts:["low","high"],...}
// (key order and extra fields vary; contextWindow uses shorthand like 1e6).
//
// Only the documented id + inputModalities + reasoningEfforts fields are read;
// anything else in the entry is ignored. Parsing is strict: any entry that
// starts the pattern but cannot be fully parsed fails the run, so a changed
// bundle shape surfaces immediately instead of silently dropping models.

/**
 * @typedef {Object} ExtractedModel
 * @property {string} id
 * @property {string[]} inputModalities
 * @property {string[]} reasoningEfforts
 */

const ENTRY_START = /\{id:"(?<id>[^"]+)",inputModalities:\[(?<modalities>[^\]]*)\]/g

const VALID_MODALITIES = new Set(["text", "image"])
const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])

function parseStringArray(raw) {
  if (raw.trim() === "") return []
  return raw.split(",").map((value) => value.trim().replace(/^"|"$/g, ""))
}

function validateArrayValues(model, field, values, allowed) {
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(
        `model ${model} has unexpected ${field} entry ${JSON.stringify(value)}; ` +
          `update extract-catalog.mjs if the catalog gained new ${field} values`,
      )
    }
  }
}

/**
 * Extract model catalog entries from command-code CLI bundle source.
 * @param {string} bundleSource
 * @returns {ExtractedModel[]}
 * Entries with an explicit reasoningEfforts list win over ones without
 * (duplicate specs exist in the bundle).
 */
export function extractCatalog(bundleSource) {
  const byId = new Map()
  let match
  ENTRY_START.lastIndex = 0
  while ((match = ENTRY_START.exec(bundleSource)) !== null) {
    const id = match.groups.id
    const inputModalities = parseStringArray(match.groups.modalities)
    validateArrayValues(id, "inputModalities", inputModalities, VALID_MODALITIES)

    // The rest of the entry runs to the entry's closing brace. Field values in
    // the bundle never contain "}", so the first "}" after the entry start is
    // the entry terminator. Reading past it would attribute the NEXT entry's
    // reasoningEfforts to this model, so the search is bounded to the entry body.
    const entryEnd = bundleSource.indexOf("}", match.index + match[0].length)
    if (entryEnd === -1) {
      throw new Error(`could not find the end of model ${id}'s catalog entry`)
    }
    const rest = bundleSource.slice(match.index + match[0].length, entryEnd)
    const effortsMatch = rest.match(/reasoningEfforts:\[([^\]]*)\]/)
    const reasoningEfforts = effortsMatch ? parseStringArray(effortsMatch[1]) : []
    validateArrayValues(id, "reasoningEfforts", reasoningEfforts, VALID_EFFORTS)

    const existing = byId.get(id)
    if (!existing || (reasoningEfforts.length > 0 && existing.reasoningEfforts.length === 0)) {
      byId.set(id, { id, inputModalities, reasoningEfforts })
    }
  }
  if (byId.size === 0) {
    throw new Error("no model catalog entries found in the command-code bundle")
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
