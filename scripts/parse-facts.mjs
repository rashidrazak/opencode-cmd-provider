// scripts/parse-facts.mjs — parse models.md (command-code npm package bundled
// catalog) into reasoning efforts + flat per-1M-token rates.
//
// Column format (verified against command-code@1.28.1):
//   | `id` | Name | Context | Efforts | $in/$out · cache $read (write $write) | Min plan | Best for |
// Efforts: comma-separated levels or "—" (model decides its own depth).
// Pricing: "$0.66/$1.98 · cache $0.022" with optional "(write $2.5)".

export function parseFactsMarkdown(markdown) {
  const efforts = {}
  const costs = {}
  const lines = markdown.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed.startsWith("| ")) continue
    if (isSeparatorRow(trimmed)) continue
    if (trimmed.startsWith("| `")) {
      parseRow(trimmed, efforts, costs)
      continue
    }
    if (isSeparatorRow((lines[i + 1] ?? "").trim())) continue
    throw new Error(`could not parse row: ${trimmed}`)
  }
  return { efforts, costs }
}

function isSeparatorRow(trimmed) {
  return /^\|\s*:?-+:?\s*\|/.test(trimmed)
}

function parseRow(trimmed, efforts, costs) {
  const cells = trimmed
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim())
  if (cells.length < 6) {
    throw new Error(`could not parse row: ${trimmed}`)
  }
  const id = cells[0].replace(/^`|`$/g, "")
  if (!id || id.length === 0) {
    throw new Error(`could not parse row: ${trimmed}`)
  }

  const effortsRaw = cells[3]
  if (effortsRaw !== "—" && effortsRaw.length > 0) {
    efforts[id] = effortsRaw.split(",").map((level) => level.trim())
  }

  const priceMatch = cells[4].match(
    /^\$([0-9.]+)\/\$([0-9.]+) · cache \$([0-9.]+)(?: \(write \$([0-9.]+)\))?$/,
  )
  if (!priceMatch) {
    throw new Error(`could not parse price for ${id}: ${cells[4]}`)
  }
  const input = Number(priceMatch[1])
  const output = Number(priceMatch[2])
  const cacheRead = Number(priceMatch[3])
  const cacheWrite = priceMatch[4] === undefined ? 0 : Number(priceMatch[4])
  if (![input, output, cacheRead, cacheWrite].every(Number.isFinite)) {
    throw new Error(`could not parse price for ${id}: ${cells[4]}`)
  }
  costs[id] = { input, output, cacheRead, cacheWrite }
}
