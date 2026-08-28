// scripts/json-stream.mjs — shared JSON extractor for Command Code docs
// streams. The Next.js flight payload embeds the same per-model records
// (objects) and per-page arrays (lists) as escaped JSON inside <script>
// text. Both shapes need the same depth-state-machine to find the matching
// closing bracket/brace while honouring JSON string escaping rules. Keeping
// it here means parse-docs.mjs and parse-rsc.mjs can both consume it
// without one having to import the other (parse-docs stays self-contained
// for the live HTML path; parse-rsc owns the RSC surface).

// Scan `text` from `start` for a JSON value whose opening character matches
// the first char of `text` at `start` (i.e. the caller has already found
// the opening `[` or `{` and passes the index of it). Returns the parsed
// value and the index immediately after the matching closing bracket/brace,
// or `undefined` if no parseable value is found. Tracks depth correctly
// across nested objects/arrays, string escapes, and unicode escapes.
export function parseJsonValue(text, start) {
  const open = text[start]
  if (open !== "{" && open !== "[") return undefined
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === "\\") {
      escaped = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === "{" || c === "[") depth++
    else if (c === "}" || c === "]") {
      depth--
      if (depth === 0) {
        if (c !== close) return undefined
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

// Find every JSON array in `text` whose first element matches the caller's
// expectations. `predicate` is called with each candidate array's first
// element; return `true` to keep it. Returns an array of the parsed arrays
// in the order they appear. Used by parse-rsc.mjs to pull the embedded
// availability/compact arrays out of the pricing-limits RSC and the slug
// records array out of the per-plan RSC.
export function findJsonArrays(text, predicate) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue
    const parsed = parseJsonValue(text, i)
    if (!parsed) continue
    if (Array.isArray(parsed.value) && parsed.value.length > 0) {
      if (!predicate || predicate(parsed.value, parsed.value[0])) {
        out.push(parsed.value)
      }
    }
    i = parsed.end - 1
  }
  return out
}

// Find every JSON value in `text` that satisfies the caller's predicate.
// Recursively descends into objects and arrays so values nested anywhere
// in the payload (e.g. the pricing-limits RSC's `models` / `rows` arrays
// wrapped in an outer envelope) are reachable. The predicate receives
// the parsed value; return `true` to keep it. Returns the matched values
// in document order.
export function findJsonValues(text, predicate) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue
    const parsed = parseJsonValue(text, i)
    if (!parsed) continue
    collectMatching(parsed.value, predicate, out)
    i = parsed.end - 1
  }
  return out
}

function collectMatching(value, predicate, out) {
  if (predicate(value)) out.push(value)
  if (Array.isArray(value)) {
    for (const item of value) collectMatching(item, predicate, out)
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      collectMatching(value[key], predicate, out)
    }
  }
}
