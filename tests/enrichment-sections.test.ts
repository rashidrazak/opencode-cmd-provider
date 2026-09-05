// tests/enrichment-sections.test.ts — issue #134: retirement prune diff
// sections + refresh enrichment subsections.
//
// A package-table row removal prunes the Snapshot immediately; the refresh
// diff carries a loud removed-section plus five enrichment subsections
// (pending enrichment per model, carried-forward context, cost-fallback
// provenance, API divergence, banded-pricing notes). All six render
// deterministically over synthetic data — never upstream's live ids —
// through the pure `diffCatalogs` snapshot seam, fed by the pure
// `buildEnrichment` builder (synthetic extracts + refresh-log text).
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { diffCatalogs } from "../scripts/diff-catalog.mjs"
import { buildChangelogSection } from "../scripts/release-notes.mjs"
import { buildEnrichment, parseRefreshLog } from "../scripts/build-enrichment.mjs"
import { assert, assertEqual, run } from "./harness.js"

/**
 * Padding-agnostic table-row matcher (same contract as
 * tests/diff-catalog.test.ts): true when the markdown contains a table row
 * whose cells start with the given values.
 */
function hasRow(md, ...cells) {
  return md.split("\n").some((line) => {
    if (!line.trimStart().startsWith("|")) return false
    const values = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim())
    return cells.every((cell, i) => values[i] === cell)
  })
}

function hasBullet(md, ...needles) {
  return md
    .split("\n")
    .some((line) => line.trimStart().startsWith("-") && needles.every((n) => line.includes(n)))
}

const SNAPSHOT_BEFORE = [
  { id: "vendor/keep", name: "Keep Model", contextLength: 1000000 },
  { id: "vendor/retire", name: "Retire Model", contextLength: 400000 },
]

const SNAPSHOT_AFTER = [{ id: "vendor/keep", name: "Keep Model", contextLength: 1000000 }]

const FULL_ENRICHMENT = {
  pendingClassification: ["vendor/alpha"],
  pendingDeals: ["vendor/alpha", "vendor/beta"],
  pendingModalities: ["vendor/beta"],
  carriedForward: [{ id: "vendor/beta", contextLength: 400000 }],
  costFallbacks: [{ id: "vendor/gamma", source: "models-page" }],
  apiDivergence: {
    inMembershipNotApi: ["vendor/keep"],
    inApiNotMembership: ["api/only"],
    skipped: false,
  },
  bandedNotes: [
    "models-page: Gamma — banded pricing (2 context price bands); base rate shipped, verify against RSC peak/off-peak and over-context fields",
  ],
}

run([
  [
    "snapshot: a removed model renders a loud Removed-models section with its name (no enrichment input needed)",
    () => {
      const md = diffCatalogs({ kind: "snapshot", before: SNAPSHOT_BEFORE, after: SNAPSHOT_AFTER })
      assert(
        md.includes("### Removed models (1)"),
        `must render the loud removed-section, got: ${md}`,
      )
      assert(
        hasBullet(md, "`vendor/retire`", "Retire Model"),
        `the removed-section must name the model, got: ${md}`,
      )
      // The table row still renders (release-notes statement source).
      assert(hasRow(md, "`vendor/retire`", "removed"), `must keep the table row, got: ${md}`)
    },
  ],
  [
    "snapshot: no removals render no Removed section (added-only world stays quiet)",
    () => {
      const md = diffCatalogs({
        kind: "snapshot",
        before: SNAPSHOT_AFTER,
        after: [...SNAPSHOT_AFTER, { id: "vendor/new", name: "New Model", contextLength: 500000 }],
      })
      assert(!md.includes("### Removed models"), `must not render a removed-section, got: ${md}`)
      assert(hasRow(md, "`vendor/new`", "added"), `must keep the added row, got: ${md}`)
    },
  ],
  [
    "snapshot: all six sections render deterministically over synthetic enrichment",
    () => {
      const before = [
        { id: "vendor/keep", name: "Keep Model", contextLength: 1000000 },
        { id: "vendor/retire", name: "Retire Model", contextLength: 400000 },
        { id: "vendor/alpha", name: "Alpha", contextLength: 1000000 },
        { id: "vendor/beta", name: "Beta", contextLength: 400000 },
        { id: "vendor/gamma", name: "Gamma", contextLength: 200000 },
      ]
      const after = [
        { id: "vendor/keep", name: "Keep Model", contextLength: 1000000 },
        {
          id: "vendor/alpha",
          name: "Alpha",
          contextLength: 1000000,
          contextSource: "models.md",
          costSource: "models.md",
        },
        {
          id: "vendor/beta",
          name: "Beta",
          contextLength: 400000,
          contextSource: "carried-forward",
          costSource: "models.md",
        },
        {
          id: "vendor/gamma",
          name: "Gamma",
          contextLength: 200000,
          contextSource: "models.md",
          costSource: "models-page",
        },
      ]
      const args = { kind: "snapshot", before, after, enrichment: FULL_ENRICHMENT }
      const md1 = diffCatalogs(args)
      const md2 = diffCatalogs(args)
      assertEqual(md1, md2, "six-section output must be byte-stable across calls")
      // 1. Removed models (loud).
      assert(md1.includes("### Removed models (1)"), `missing removed-section, got: ${md1}`)
      assert(hasBullet(md1, "`vendor/retire`", "Retire Model"), `missing removed bullet: ${md1}`)
      // 2. Pending enrichment per model (reasons in fixed order).
      assert(md1.includes("### Pending enrichment (2)"), `missing pending section, got: ${md1}`)
      assert(
        hasBullet(md1, "`vendor/alpha`", "classification pending", "deals pending"),
        `missing alpha pending bullet: ${md1}`,
      )
      assert(
        hasBullet(md1, "`vendor/beta`", "modalities pending", "deals pending"),
        `missing beta pending bullet: ${md1}`,
      )
      // 3. Carried-forward context.
      assert(
        md1.includes("### Carried-forward context (1)"),
        `missing carried-forward section, got: ${md1}`,
      )
      assert(hasBullet(md1, "`vendor/beta`", "400000"), `missing carried bullet: ${md1}`)
      // 4. Cost-fallback provenance.
      assert(
        md1.includes("### Cost-fallback provenance (1)"),
        `missing cost-fallback section, got: ${md1}`,
      )
      assert(
        hasBullet(md1, "`vendor/gamma`", "models-page"),
        `missing cost-fallback bullet: ${md1}`,
      )
      // 5. API divergence (both directions).
      assert(md1.includes("### API divergence"), `missing divergence section, got: ${md1}`)
      assert(
        hasBullet(md1, "not served by the listing API", "`vendor/keep`"),
        `missing membership-not-API bullet: ${md1}`,
      )
      assert(
        hasBullet(md1, "not in package membership", "`api/only`"),
        `missing API-not-membership bullet: ${md1}`,
      )
      // 6. Banded-pricing notes.
      assert(md1.includes("### Banded pricing (1)"), `missing banded section, got: ${md1}`)
      assert(
        hasBullet(md1, "banded pricing", "verify against RSC"),
        `missing banded bullet: ${md1}`,
      )
      // Sorted: alpha before beta in the pending section.
      assert(
        md1.indexOf("`vendor/alpha`") < md1.indexOf("`vendor/beta`"),
        "pending bullets must be sorted by model id",
      )
    },
  ],
  [
    "snapshot: empty enrichment omits every subsection (backward compatible)",
    () => {
      const withEmpty = diffCatalogs({
        kind: "snapshot",
        before: SNAPSHOT_BEFORE,
        after: SNAPSHOT_AFTER,
        enrichment: {
          pendingClassification: [],
          pendingDeals: [],
          pendingModalities: [],
          carriedForward: [],
          costFallbacks: [],
          bandedNotes: [],
        },
      })
      const without = diffCatalogs({
        kind: "snapshot",
        before: SNAPSHOT_BEFORE,
        after: SNAPSHOT_AFTER,
      })
      // The removed-section is derived from before/after alone, so both
      // carry it — and nothing else.
      assertEqual(withEmpty, without, "empty enrichment must not change the output")
      assert(!withEmpty.includes("### Pending enrichment"), "no pending section when empty")
      assert(!withEmpty.includes("### Carried-forward"), "no carried section when empty")
      assert(!withEmpty.includes("### Cost-fallback"), "no cost section when empty")
      assert(!withEmpty.includes("### API divergence"), "no divergence section when unknown")
      assert(!withEmpty.includes("### Banded pricing"), "no banded section when empty")
    },
  ],
  [
    "snapshot: API divergence renders the matches and skipped states",
    () => {
      // Enrichment subsections render alongside a non-empty change table
      // (pure date churn short-circuits to "No changes."), so both worlds
      // below carry a change row.
      const changed = {
        before: SNAPSHOT_AFTER,
        after: [...SNAPSHOT_AFTER, { id: "vendor/new", name: "New Model", contextLength: 500000 }],
      }
      const matched = diffCatalogs({
        kind: "snapshot",
        ...changed,
        enrichment: {
          apiDivergence: { inMembershipNotApi: [], inApiNotMembership: [], skipped: false },
        },
      })
      assert(
        matched.includes("matches package membership"),
        `must render the matches line, got: ${matched}`,
      )
      const skipped = diffCatalogs({
        kind: "snapshot",
        ...changed,
        enrichment: { apiDivergence: { skipped: true } },
      })
      assert(
        skipped.includes("Divergence note skipped") || skipped.includes("divergence note skipped"),
        `must render the skipped line, got: ${skipped}`,
      )
    },
  ],
  [
    "snapshot: identical catalogs short-circuit to No changes even with enrichment input",
    () => {
      // The subsections describe the after-state, not a change — rendering
      // them on date churn would keep every release note's Model catalog
      // section alive forever.
      const md = diffCatalogs({
        kind: "snapshot",
        before: SNAPSHOT_AFTER,
        after: SNAPSHOT_AFTER,
        enrichment: FULL_ENRICHMENT,
      })
      assert(md.includes("No changes."), `must short-circuit, got: ${md}`)
      assert(!md.includes("### Pending enrichment"), `must omit subsections, got: ${md}`)
      assert(!md.includes("### API divergence"), `must omit divergence, got: ${md}`)
    },
  ],
  [
    "parseRefreshLog: divergence both directions, banded notes, modalities pending",
    () => {
      const log = [
        "refresh-snapshot: wrote 3 models to /tmp/snapshot.ts",
        "refresh-snapshot: divergence note — in package membership but not served by the listing API: vendor/keep, vendor/alpha",
        "refresh-snapshot: divergence note — served by the listing API but not in package membership: api/only",
        "refresh-snapshot: modalities pending — CLI bundle omits 1 package models: vendor/beta",
        "refresh-snapshot: modalities pending — vendor/beta: CLI omits and no Caps Vision evidence; text-only fallback",
        "refresh-snapshot: models-page: Gamma — banded pricing (2 context price bands); base rate shipped, verify against RSC",
      ].join("\n")
      const parsed = parseRefreshLog(log)
      assertEqual(parsed.inMembershipNotApi, ["vendor/alpha", "vendor/keep"])
      assertEqual(parsed.inApiNotMembership, ["api/only"])
      assertEqual(parsed.skipped, false)
      assertEqual(parsed.matched, false)
      assertEqual(parsed.pendingModalities, ["vendor/beta"])
      assertEqual(parsed.bandedNotes.length, 1)
      assert(parsed.bandedNotes[0].includes("banded pricing"), parsed.bandedNotes[0])
    },
  ],
  [
    "parseRefreshLog: matches and skipped states degrade deterministically",
    () => {
      const matched = parseRefreshLog(
        "refresh-snapshot: divergence note — listing API matches package membership",
      )
      assertEqual(matched.matched, true)
      assertEqual(matched.skipped, false)
      const skipped = parseRefreshLog(
        "refresh-snapshot: note — listing API unreachable; divergence note skipped",
      )
      assertEqual(skipped.skipped, true)
      assertEqual(skipped.matched, false)
      const empty = parseRefreshLog("refresh-snapshot: wrote 1 models to /tmp/snapshot.ts")
      assertEqual(empty.skipped, false)
      assertEqual(empty.matched, false)
      assertEqual(empty.inMembershipNotApi, [])
      assertEqual(empty.bandedNotes, [])
      assertEqual(empty.pendingModalities, [])
    },
  ],
  [
    "buildEnrichment: derives the six-section input from synthetic extracts + log",
    () => {
      const enrichment = buildEnrichment({
        snapshotAfter: {
          MODEL_SNAPSHOT: [
            { id: "vendor/alpha", name: "Alpha", contextLength: 1000000 },
            {
              id: "vendor/beta",
              name: "Beta",
              contextLength: 400000,
              contextSource: "carried-forward",
              costSource: "models.md",
            },
            {
              id: "vendor/gamma",
              name: "Gamma",
              contextLength: 200000,
              contextSource: "models.md",
              costSource: "models-page",
            },
          ],
        },
        classificationAfter: { MODEL_REASONING_PENDING: ["vendor/alpha"] },
        dealsAfter: { MODEL_DEALS: { "vendor/gamma": { tier: "premium", free: false } } },
        refreshLogText: [
          "refresh-snapshot: divergence note — in package membership but not served by the listing API: vendor/alpha",
          "refresh-snapshot: modalities pending — CLI bundle omits 1 package models: vendor/beta",
        ].join("\n"),
      })
      assertEqual(enrichment.pendingClassification, ["vendor/alpha"])
      // vendor/alpha + vendor/beta lack deals records; vendor/gamma has one.
      assertEqual(enrichment.pendingDeals, ["vendor/alpha", "vendor/beta"])
      assertEqual(enrichment.pendingModalities, ["vendor/beta"])
      assertEqual(enrichment.carriedForward, [{ id: "vendor/beta", contextLength: 400000 }])
      assertEqual(enrichment.costFallbacks, [{ id: "vendor/gamma", source: "models-page" }])
      assertEqual(enrichment.apiDivergence.inMembershipNotApi, ["vendor/alpha"])
      assertEqual(enrichment.apiDivergence.inApiNotMembership, [])
      // Deterministic: same inputs → same bytes.
      assertEqual(
        JSON.stringify(enrichment),
        JSON.stringify(
          buildEnrichment({
            snapshotAfter: {
              MODEL_SNAPSHOT: [
                { id: "vendor/alpha", name: "Alpha", contextLength: 1000000 },
                {
                  id: "vendor/beta",
                  name: "Beta",
                  contextLength: 400000,
                  contextSource: "carried-forward",
                  costSource: "models.md",
                },
                {
                  id: "vendor/gamma",
                  name: "Gamma",
                  contextLength: 200000,
                  contextSource: "models.md",
                  costSource: "models-page",
                },
              ],
            },
            classificationAfter: { MODEL_REASONING_PENDING: ["vendor/alpha"] },
            dealsAfter: { MODEL_DEALS: { "vendor/gamma": { tier: "premium", free: false } } },
            refreshLogText: [
              "refresh-snapshot: divergence note — in package membership but not served by the listing API: vendor/alpha",
              "refresh-snapshot: modalities pending — CLI bundle omits 1 package models: vendor/beta",
            ].join("\n"),
          }),
        ),
      )
    },
  ],
  [
    "buildEnrichment: missing inputs degrade to empty sections, never throw",
    () => {
      const enrichment = buildEnrichment({})
      assertEqual(enrichment.pendingClassification, [])
      assertEqual(enrichment.pendingDeals, [])
      assertEqual(enrichment.pendingModalities, [])
      assertEqual(enrichment.carriedForward, [])
      assertEqual(enrichment.costFallbacks, [])
      assertEqual(enrichment.bandedNotes, [])
      // No log signal → the divergence section is omitted, not "matches".
      assertEqual(enrichment.apiDivergence, null)
    },
  ],
  [
    "buildEnrichment: a missing deals extract degrades to no pending deals, never all-pending",
    () => {
      // The cron writes {"missing":true} when the before side has no deals
      // module; a non-null object without MODEL_DEALS must not mark every
      // snapshot id pending.
      const enrichment = buildEnrichment({
        snapshotAfter: { MODEL_SNAPSHOT: [{ id: "vendor/alpha", name: "Alpha" }] },
        dealsAfter: { missing: true },
      })
      assertEqual(enrichment.pendingDeals, [])
    },
  ],
  [
    "snapshot CLI: --enrichment renders the subsections end-to-end",
    async () => {
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const exec = promisify(execFile)
      const dir = await mkdtemp(join(tmpdir(), "cc-enrich-cli-"))
      try {
        await writeFile(join(dir, "before.json"), JSON.stringify(SNAPSHOT_BEFORE))
        await writeFile(join(dir, "after.json"), JSON.stringify(SNAPSHOT_AFTER))
        await writeFile(
          join(dir, "enrichment.json"),
          JSON.stringify({
            pendingDeals: ["vendor/keep"],
            apiDivergence: { inMembershipNotApi: [], inApiNotMembership: [], skipped: false },
          }),
        )
        const { stdout } = await exec("node", [
          "scripts/diff-catalog.mjs",
          "snapshot",
          join(dir, "before.json"),
          join(dir, "after.json"),
          "--enrichment",
          join(dir, "enrichment.json"),
        ])
        assert(
          stdout.includes("### Removed models (1)"),
          `CLI must render the removed-section, got: ${stdout}`,
        )
        assert(
          stdout.includes("### Pending enrichment (1)"),
          `CLI must render the pending section, got: ${stdout}`,
        )
        assert(
          stdout.includes("matches package membership"),
          `CLI must render the divergence matches line, got: ${stdout}`,
        )
        // A missing enrichment file degrades to no subsections, never a failure.
        const { stdout: degraded } = await exec("node", [
          "scripts/diff-catalog.mjs",
          "snapshot",
          join(dir, "before.json"),
          join(dir, "after.json"),
          "--enrichment",
          join(dir, "does-not-exist.json"),
        ])
        assert(
          degraded.includes("### Removed models (1)"),
          `degraded output must keep the removed-section, got: ${degraded}`,
        )
        assert(
          !degraded.includes("### Pending enrichment"),
          `degraded output must omit enrichment sections, got: ${degraded}`,
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
  [
    "snapshot: six-section output is Prettier-stable (format:check safety for release notes)",
    async () => {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const exec = promisify(execFile)
      const md = diffCatalogs({
        kind: "snapshot",
        before: SNAPSHOT_BEFORE,
        after: SNAPSHOT_AFTER,
        enrichment: FULL_ENRICHMENT,
      })
      const dir = await mkdtemp(join(tmpdir(), "cc-enrich-prettier-"))
      try {
        const file = join(dir, "enrichment.md")
        await writeFile(file, md)
        await exec("npx", ["prettier", "--parser", "markdown", "--check", file])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
  [
    "release notes: a prune refresh states added and removed models",
    () => {
      // The retire-prune release statement (issue #134): the PR body's
      // Model catalog section carries the added/removed table rows plus
      // the loud removed-section, and the release-notes authoring keeps
      // both (its `meaningful` filter keeps table rows and non-date list
      // items, and treats the embedded ## H2 as content).
      const snapshotSection = diffCatalogs({
        kind: "snapshot",
        before: [
          { id: "vendor/keep", name: "Keep Model", contextLength: 1000000 },
          { id: "vendor/retire", name: "Retire Model", contextLength: 400000 },
        ],
        after: [
          { id: "vendor/keep", name: "Keep Model", contextLength: 1000000 },
          { id: "vendor/new", name: "New Model", contextLength: 500000 },
        ],
      })
      const prBody = [
        "## Catalog refresh — 2026-09-06",
        "",
        "Automated refresh of the generated catalog files.",
        "",
        "### Changed files",
        "",
        "```",
        " src/catalog/snapshot.ts | 2 +-",
        "```",
        "",
        "### Model catalog",
        "",
        snapshotSection,
        "---",
        "",
        "_Auto-generated by the `catalog-refresh` workflow. Review and merge._",
        "",
      ].join("\n")
      const section = buildChangelogSection({
        version: "1.6.6",
        date: "2026-09-06",
        prBody,
      })
      assert(section.startsWith("## 1.6.6 - 2026-09-06"), section.slice(0, 60))
      assert(section.includes("### Model catalog"), "must keep the Model catalog section")
      const rows = section.split("\n").filter((line) => line.trimStart().startsWith("|"))
      const changes = new Map(
        rows.map((row) => {
          const cells = row
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim())
          return [cells[0], cells[1]]
        }),
      )
      assertEqual(changes.get("`vendor/new`"), "added", "release notes must state the added model")
      assertEqual(
        changes.get("`vendor/retire`"),
        "removed",
        "release notes must state the removed model",
      )
      assert(
        section.includes("### Removed models (1)"),
        `release notes must keep the loud removed-section, got: ${section}`,
      )
      assert(!section.includes("Changed files"), "non-semantic sections stay dropped")
      // Deterministic: same inputs → same bytes.
      assertEqual(section, buildChangelogSection({ version: "1.6.6", date: "2026-09-06", prBody }))
    },
  ],
  [
    "the catalog-refresh workflow captures refresh.log and feeds enrichment into the PR body",
    async () => {
      // Static lock (same pattern as tests/auto-release.test.ts guards):
      // the PR-body enrichment wiring lives in shell, so the workflow
      // content itself is the contract.
      const workflow = await readFile(
        join(process.cwd(), ".github/workflows/catalog-refresh.yml"),
        "utf-8",
      )
      // The regenerate step must preserve failures through the tee
      // (pipefail) so a red refresh still fails the job.
      assert(workflow.includes("set -o pipefail"), "regenerate must set pipefail")
      assert(workflow.includes("tee refresh.log"), "regenerate must capture refresh.log")
      // The extract step must capture the pending bucket for the builder.
      assert(
        workflow.includes("MODEL_REASONING_PENDING"),
        "extract must capture MODEL_REASONING_PENDING",
      )
      // The PR-body step must build enrichment and feed it to the snapshot diff.
      assert(workflow.includes("build-enrichment.mjs"), "PR body must run build-enrichment")
      assert(workflow.includes("--enrichment"), "snapshot diff must receive --enrichment")
      // The models page fixture rides along: committed with the refresh
      // but never deciding drift (issue #134 drift judgment — the page is
      // enrichment, so its byte churn must never open an empty PR).
      assert(
        workflow.includes("tests/fixtures/models-page.html"),
        "the commit step must keep riding the models-page fixture along",
      )
      const driftStep = workflow.slice(workflow.indexOf("Detect meaningful drift"))
      assert(
        !driftStep.slice(0, driftStep.indexOf("Commit regenerated")).includes("models-page.html"),
        "the drift check must not judge the models-page fixture",
      )
    },
  ],
])
