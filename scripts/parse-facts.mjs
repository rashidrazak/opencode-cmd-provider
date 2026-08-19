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
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("| `")) continue
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length < 6) continue
    const id = cells[0].replace(/^`|`$/g, "")
    if (!id || id.length === 0) continue

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
    costs[id] = {
      input: Number(priceMatch[1]),
      output: Number(priceMatch[2]),
      cacheRead: Number(priceMatch[3]),
      cacheWrite: priceMatch[4] === undefined ? 0 : Number(priceMatch[4]),
    }
  }
  return { efforts, costs }
}
