// tests/helpers/flight-table.ts — a minimal flight-payload rendered table.
//
// The Command Code docs' RSC payload encodes rendered elements as
// `["$", tag, null, props]`, with a lone child collapsed to the child itself
// (a bare string for text, the element array for a single element). The
// plan-table parser (scripts/parse-rsc.mjs, issue #229) reads that shape, so
// the tests that need a synthetic usage-limits table share this builder
// instead of re-encoding the flight format in three places.

/** The rendered `["$","table",null,{…}]` element for a header + body rows. */
export function renderedTableElement(header: string[], body: string[][]): unknown[] {
  const element = (tag: string, children: unknown) => ["$", tag, null, { children }]
  return element("table", [
    element(
      "thead",
      element(
        "tr",
        header.map((label) => element("th", label)),
      ),
    ),
    element(
      "tbody",
      body.map((cells) =>
        element(
          "tr",
          cells.map((cell) => element("td", cell)),
        ),
      ),
    ),
  ])
}

/** A one-line RSC payload carrying the rendered table (cells are raw text). */
export function renderedTableRsc(header: string[], body: string[][]): string {
  return `1:${JSON.stringify(renderedTableElement(header, body))}\n`
}
