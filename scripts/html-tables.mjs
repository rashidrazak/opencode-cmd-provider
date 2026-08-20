// scripts/html-tables.mjs — minimal HTML table extractor for the Command Code
// docs pages. Returns arrays of rows; each row is an array of cell text with
// tags, whitespace, and navigation arrows stripped.
const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
const CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi

export function extractTables(html) {
  const tables = []
  for (const table of html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) ?? []) {
    const rows = []
    for (const row of table.match(ROW_RE) ?? []) {
      const cells = []
      for (const cell of row.match(CELL_RE) ?? []) {
        cells.push(cleanCell(cell.replace(/<\/?t[dh][^>]*>/gi, "")))
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length > 0) tables.push(rows)
  }
  return tables
}

function cleanCell(raw) {
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function parseMoney(value) {
  if (value === undefined) return null
  const cleaned = value.replace(/,/g, "").trim()
  if (cleaned === "" || cleaned === "—" || /^(free|Free)$/.test(cleaned)) return null
  const match = cleaned.match(/^\$?([0-9]*\.?[0-9]+)$/)
  return match ? Number(match[1]) : null
}
