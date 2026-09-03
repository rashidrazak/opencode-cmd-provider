// scripts/release-notes.mjs — CHANGELOG section authoring for the
// auto-release workflow (issue #115).
//
// Merging a catalog-refresh PR cuts a patch release: the workflow feeds
// the merged PR body to this module, which renders the release's
// `## X.Y.Z - date` CHANGELOG section from the PR body's **semantic**
// sections (Model catalog / Reasoning classification / Deals
// intelligence). The `Changed files` stat block and the bot footer are
// not semantic and are dropped.
//
// Trust model: the merged PR body is untrusted upstream-derived input.
// It is passed as a FILE (env → file → this module reads it as data),
// never interpolated into run scripts; the version and date arrive as
// argv (computed locally from package.json / the clock), never parsed
// from the PR. The output is deterministic: same inputs → same bytes.
//
// Self-contained by design: the auto-release test copies this file into
// a synthetic repository and runs the workflow's exact fragment against
// it, so it must not import sibling modules.
//
// Usage: node scripts/release-notes.mjs <version> <date> <pr-body-file>
//   Prints the CHANGELOG section to stdout.

/**
 * Renders the `## X.Y.Z - date` CHANGELOG section from a merged refresh
 * PR body's semantic sections.
 *
 * Section parsing details that matter:
 *   - The cron's PR body embeds `diff-catalog.mjs` output INSIDE its
 *     `###` sections, and that output carries `##` H2 headings ("## Model
 *     catalog"). An H2 line inside a section is therefore CONTENT, not a
 *     terminator — treating it as one emptied every section (run of
 *     PR #117: the emitted CHANGELOG failed `format:check` because the
 *     emptied sections left doubled blank lines). Sections end at the
 *     next `###` heading or at the `---` footer separator only.
 *   - The output must be Prettier-stable: never more than one consecutive
 *     blank line (the release pipeline's `format:check` runs over the
 *     committed CHANGELOG).
 *
 * @param {{ version: string, date: string, prBody: string }} args
 * @returns {string}
 */
export function buildChangelogSection({ version, date, prBody }) {
  const lines = String(prBody ?? "").split(/\r?\n/)
  const sections = []
  let current = null
  for (const line of lines) {
    if (/^###\s/.test(line)) {
      current = { title: line.replace(/^###\s+/, "").trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current === null) continue
    // A section ends at the next `###` heading or at the `---` footer
    // separator — anything after the separator is the bot footer.
    // `##` lines are content (the embedded diff sections use them).
    if (/^###\s/.test(line) || /^---/.test(line)) {
      current = null
      continue
    }
    current.lines.push(line)
  }
  const semantic = sections.filter((section) => section.title.toLowerCase() !== "changed files")
  // A section whose body carries no table rows and no substantive list
  // content beyond the diff tool's date line is **empty noise** (the 1.6.3
  // release note was a bare "### Model catalog" followed by a date line
  // and "No changes."). Release notes must state what actually changed;
  // sections with no change rows are dropped so the CHANGELOG never shows
  // an empty heading.
  const meaningful = semantic.filter((section) => {
    const body = section.lines.filter((line) => line.trim() !== "")
    if (body.length === 0) return false
    // A table row (| ...) means the diff tool emitted actual changes.
    if (body.some((line) => /^\|/.test(line))) return true
    // Otherwise: any list item other than the `- **...LAST_REFRESHED**:`
    // date line is a legacy prose diff line — treat it as content.
    return body.some((line) => /^\s*[-*+]\s/.test(line) && !/LAST_REFRESHED\*\*/.test(line))
  })
  const out = [`## ${version} - ${date}`]
  if (meaningful.length === 0) {
    // The PR body may not carry any substantive sections (pure date
    // churn or an unexpected shape); the release still ships with a
    // minimal, honest entry.
    out.push("", "Automated catalog refresh.", "")
    return collapseBlankLines(out)
  }
  for (const section of meaningful) {
    out.push("", `### ${section.title}`)
    // Trim trailing blank lines per section so the join is deterministic
    // regardless of upstream spacing churn.
    const body = [...section.lines]
    while (body.length > 0 && body[body.length - 1].trim() === "") body.pop()
    for (const line of body) out.push(line)
  }
  out.push("")
  return collapseBlankLines(out)
}

/**
 * Collapses runs of blank lines to a single blank line, strips
 * leading/trailing blanks, and separates list blocks from following
 * paragraph lines. Prettier does the same to Markdown (a non-list line
 * directly after a list item is a lazy continuation and gets re-indented),
 * so the emitted CHANGELOG must already be in that normal form or the
 * release pipeline's `format:check` fails on the bump commit.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function collapseBlankLines(lines) {
  const out = []
  const isListItem = (line) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line)
  const isTableRow = (line) => /^\s*\|/.test(line)
  for (const line of lines) {
    if (line.trim() === "") {
      if (out.length === 0 || out[out.length - 1] === "") continue
      out.push("")
      continue
    }
    // A paragraph line right after a list item is a lazy continuation in
    // Markdown — Prettier re-indents it, so break it out with a blank line.
    // Table rows are atomic: a table directly after a list/paragraph line
    // also needs the separating blank (Prettier would otherwise treat the
    // table as the paragraph's lazy continuation and indent it).
    if (
      out.length > 0 &&
      out[out.length - 1] !== "" &&
      ((isListItem(out[out.length - 1]) && !isTableRow(line)) ||
        (isTableRow(line) && !isTableRow(out[out.length - 1]))) &&
      !isListItem(line) &&
      !line.startsWith("#") &&
      !line.startsWith("```")
    ) {
      out.push("")
    }
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out.join("\n") + "\n"
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 3) {
    console.error("usage: node scripts/release-notes.mjs <version> <date> <pr-body-file>")
    process.exit(2)
  }
  const [version, date, prBodyPath] = args
  const { readFile } = await import("node:fs/promises")
  let prBody
  try {
    prBody = await readFile(prBodyPath, "utf-8")
  } catch (error) {
    console.error(
      `release-notes: could not read the PR body file (${prBodyPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(1)
  }
  process.stdout.write(buildChangelogSection({ version, date, prBody }))
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
