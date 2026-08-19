# Capability Facts Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate `src/catalog/facts.ts` (reasoning efforts + flat-rate costs) from the command-code npm package's bundled `models.md` at snapshot-refresh time, so capability facts update automatically and drift is detected at release.

**Architecture:** The refresh script gains a facts fetch+parse+write step, producing a generated `facts.ts` next to `snapshot.ts`. `reasoning.ts` and `pricing.ts` become thin re-export shims over the generated facts; the cost calculator drops its now-dead tier logic. The release workflow's stale-snapshot gate extends to `facts.ts` (ADR 0003).

**Tech Stack:** Node 22+, TypeScript, no new dependencies (parser is hand-rolled for the stable models.md table format; unpkg + npm registry via global fetch).

**Spec:** `docs/superpowers/specs/2026-08-19-facts-sync-design.md`

---

## File Map

- Create: `src/catalog/facts.ts` — GENERATED file (efforts + costs + facts header constants)
- Create: `tests/fixtures/models.md` — canned models.md fixture for tests
- Modify: `scripts/refresh-snapshot.mjs` — add facts fetch/parse/write
- Modify: `src/provider/reasoning.ts` — import/re-export MODEL_EFFORTS from facts.js
- Modify: `src/provider/pricing.ts` — import/re-export MODEL_COSTS + header constants from facts.js; delete tier type/field
- Modify: `src/provider/cost.ts` — remove tier loop
- Modify: `tests/refresh-snapshot.test.ts` — facts parsing/generation tests
- Modify: `tests/cost.test.ts` — drop tier test, adapt flat-rate test
- Modify: `tests/reasoning.test.ts` — keep MODEL_EFFORTS import (re-exported)
- Modify: `.github/workflows/release.yml` — gate includes facts.ts
- Modify: `docs/adr/0003-release-gates.md` — amendment paragraph
- Modify: `package.json` — no script change needed (`refresh:snapshot` stays); optionally add facts env vars doc line in README only if user-facing (skip)

---

### Task 1: Facts parser + fixture

**Files:**

- Create: `tests/fixtures/models.md`
- Create: `scripts/parse-facts.mjs` (pure parser module, importable by the refresh script and tests)

- [ ] **Step 1: Write the failing parser tests**

Create `tests/parse-facts.test.ts`:

```ts
// tests/parse-facts.test.ts — models.md facts parser (facts auto-sync design)
import { readFile } from "node:fs/promises"
import { parseFactsMarkdown } from "../scripts/parse-facts.mjs"
import { assert, assertEqual, run, throws } from "./harness.js"

const FIXTURE = "tests/fixtures/models.md"

run([
  [
    "parses efforts and flat costs from the fixture",
    async () => {
      const md = await readFile(FIXTURE, "utf-8")
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.efforts["claude-sonnet-5"], ["low", "medium", "high", "xhigh", "max"])
      assertEqual(facts.efforts["Qwen/Qwen3.8-Max"], ["low", "medium", "xhigh"])
      assertEqual(facts.efforts["moonshotai/Kimi-K3"], undefined)
      assertEqual(facts.costs["claude-sonnet-5"], {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
      })
      assertEqual(facts.costs["Qwen/Qwen3.8-Max"], {
        input: 2,
        output: 6,
        cacheRead: 0.25,
        cacheWrite: 2.5,
      })
    },
  ],

  [
    "models without a cache-write rate get cacheWrite 0",
    async () => {
      const md = await readFile(FIXTURE, "utf-8")
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.costs["moonshotai/Kimi-K3"], {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 0,
      })
    },
  ],

  [
    "free models parse to all-zero rates",
    async () => {
      const md = await readFile(FIXTURE, "utf-8")
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.costs["poolside/laguna-s-2.1-free"], {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })
    },
  ],

  [
    "unparseable pricing rows fail loudly",
    () => {
      const md = "| `x/y` | X Y | 1M | low | $nope/$1 · cache $0.2 | Go | best |\n"
      throws(() => parseFactsMarkdown(md), /could not parse price for x\/y/)
    },
  ],
])
```

- [ ] **Step 2: Run the parser tests to verify they fail**

Run: `npx tsx tests/parse-facts.test.ts`
Expected: FAIL — `Cannot find module '../scripts/parse-facts.mjs'` (module does not exist yet) plus fixture missing.

- [ ] **Step 3: Create the fixture**

Create `tests/fixtures/models.md` with the exact table format (verified live against command-code@1.28.1; fixture is a trimmed subset covering every format variation):

```md
# Command Code Models

## Open Source

| Id (use EXACTLY this)        | Name                     | Context | Efforts            | $/1M in/out · cache read         | Min plan     | Best for                                             |
| ---------------------------- | ------------------------ | ------- | ------------------ | -------------------------------- | ------------ | ---------------------------------------------------- |
| `moonshotai/Kimi-K3`         | Kimi K3                  | 1M      | —                  | $3/$15 · cache $0.3              | Go and above | long-horizon coding & knowledge work with 1M context |
| `Qwen/Qwen3.8-Max`           | Qwen 3.8 Max             | 1M      | low, medium, xhigh | $2/$6 · cache $0.25 (write $2.5) | Go and above | autonomous long-horizon coding & professional work   |
| `poolside/laguna-s-2.1-free` | Laguna S 2.1             | 256K    | —                  | $0/$0 · cache $0                 | Go and above | open-weight agentic coding and long-horizon work     |
| `deepseek/deepseek-v4-pro`   | DeepSeek V4 Pro (latest) | 1M      | high, max          | $0.66/$1.98 · cache $0.022       | Go and above | hybrid-attention long-context reasoning              |

## Anthropic

| Id (use EXACTLY this) | Name            | Context | Efforts                       | $/1M in/out · cache read         | Min plan      | Best for                                         |
| --------------------- | --------------- | ------- | ----------------------------- | -------------------------------- | ------------- | ------------------------------------------------ |
| `claude-sonnet-5`     | Claude Sonnet 5 | 1M      | low, medium, high, xhigh, max | $2/$10 · cache $0.2 (write $2.5) | Pro and above | best combo of speed & intelligence (recommended) |

Rates are the advertised price list resolved from the billing source of truth (promos are already baked in).
```

- [ ] **Step 4: Write the parser**

Create `scripts/parse-facts.mjs`:

```js
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
```

- [ ] **Step 5: Run the parser tests to verify they pass**

Run: `npx tsx tests/parse-facts.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/models.md tests/parse-facts.test.ts scripts/parse-facts.mjs
git commit -m "feat(facts): parse reasoning efforts + rates from the command-code catalog"
```

---

### Task 2: Refresh script writes generated facts.ts

**Files:**

- Modify: `scripts/refresh-snapshot.mjs`
- Modify: `tests/refresh-snapshot.test.ts`
- Modify: `tests/helpers/mock-cc.ts` (add a generic JSON/text route for registry + models.md)

- [ ] **Step 1: Write the failing test for facts generation**

Extend `tests/refresh-snapshot.test.ts`. First extend the mock helper to serve the registry and models.md endpoints. In `tests/helpers/mock-cc.ts`:

```ts
export interface MockCcOptions {
  models?: unknown
  /** events to emit for POST /alpha/generate; last event wins for infinite repetition */
  stream?: Array<Record<string, unknown> | "end">
  status?: number
  errorBody?: string
  /** called with the parsed /alpha/generate request body and headers */
  onGenerate?: (body: Record<string, unknown>, headers: Record<string, string>) => void
  /** served at GET /registry (npm registry JSON: { "dist-tags": { latest } }) */
  registry?: unknown
  /** served at GET /models.md (raw command-code models.md text) */
  factsMd?: string
}
```

In `startMockCc`, add before the 404 fallback:

```ts
if (req.url === "/registry" && req.method === "GET") {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(options.registry ?? { "dist-tags": { latest: "9.9.9" } }))
  return
}
if (req.url === "/models.md" && req.method === "GET") {
  res.writeHead(200, { "content-type": "text/markdown" })
  res.end(options.factsMd ?? "")
  return
}
```

Then add a new test case to `tests/refresh-snapshot.test.ts`:

```ts
  [
    "refresh-snapshot writes generated facts.ts next to the snapshot",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-facts-"))
      const out = join(dir, "snapshot.ts")
      const factsOut = join(dir, "facts.ts")
      const mock = await startMockCc({
        models: MODELS_PAYLOAD,
        registry: { "dist-tags": { latest: "1.28.1" } },
        factsMd:
          "## Open Source\n\n" +
          "| Id | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |\n" +
          "|---|---|---|---|---|---|---|\n" +
          "| `claude-sonnet-5` | Claude Sonnet 5 | 1M | low, medium, high, xhigh, max | $2/$10 · cache $0.2 (write $2.5) | Pro and above | best |\n",
      })
      try {
        const result = await runScript(
          [
            "scripts/refresh-snapshot.mjs",
            "--out",
            out,
            "--facts-out",
            factsOut,
          ],
          {
            ...process.env,
            COMMANDCODE_API_BASE: mock.url,
            COMMANDCODE_REGISTRY_URL: `${mock.url}/registry`,
            COMMANDCODE_FACTS_URL: `${mock.url}/models.md`,
          },
        )
        assert(result.status === 0, result.stderr || result.stdout)
        const contents = await readFile(factsOut, "utf-8")
        assert(contents.includes("GENERATED by scripts/refresh-snapshot.mjs"), "missing generated header")
        assert(contents.includes('FACTS_PACKAGE_VERSION = "1.28.1"'), "missing package version")
        const mod = await import(factsOut)
        assertEqual(mod.MODEL_EFFORTS, {
          "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
        })
        assertEqual(mod.MODEL_COSTS, {
          "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        })
        assertEqual(mod.FACTS_LAST_REFRESHED, new Date().toISOString().split("T")[0])
      } finally {
        await mock.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx tests/refresh-snapshot.test.ts`
Expected: FAIL — script does not read `--facts-out`/registry/facts env vars yet; output file missing.

- [ ] **Step 3: Implement facts fetch + write in the refresh script**

Modify `scripts/refresh-snapshot.mjs`:

1. Add arg/env plumbing after the existing `argValue` helper:

```js
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/command-code"
const DEFAULT_FACTS_URL = (version) =>
  `https://unpkg.com/command-code@${version}/dist/bundled/command-code-knowledge/reference/models.md`

const registryUrl = process.env.COMMANDCODE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL
```

2. Add `--facts-out` to the arg parsing block:

```js
const factsOut = argValue("--facts-out") ?? resolve(dirname(out), "facts.ts")
```

Wait — `factsOut` must be defined after `out`. Place the `--facts-out` resolution after the existing `const out = ...` line.

3. Add a `fetchJson` helper next to the existing fetch logic (reuse for registry):

```js
async function fetchJson(url) {
  let response
  try {
    response = await fetch(url, { headers: { accept: "application/json" } })
  } catch (error) {
    fail(`could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    fail(`failed to fetch ${url}: ${response.status} ${response.statusText}`)
  }
  return response.json()
}
```

4. Replace the existing catalog fetch block with:

```js
const catalog = await fetchJson(`${base}/provider/v1/models`)
const models = parseCatalog(catalog)
if (models.length === 0) fail("Command Code returned an empty model catalog")
```

(keeps existing behavior; `parseCatalog` unchanged)

5. After writing the snapshot, add the facts block:

```js
// --- Capability facts (reasoning efforts + rates) from the CLI catalog ---
const { parseFactsMarkdown } = await import("./parse-facts.mjs")
const registry = await fetchJson(registryUrl)
const latest = registry?.["dist-tags"]?.latest
if (typeof latest !== "string" || latest.length === 0) {
  fail(`could not resolve latest command-code version from ${registryUrl}`)
}
const factsUrl = process.env.COMMANDCODE_FACTS_URL ?? DEFAULT_FACTS_URL(latest)
let factsResponse
try {
  factsResponse = await fetch(factsUrl, { headers: { accept: "text/markdown" } })
} catch (error) {
  fail(`could not fetch ${factsUrl}: ${error instanceof Error ? error.message : String(error)}`)
}
if (!factsResponse.ok) {
  fail(`failed to fetch ${factsUrl}: ${factsResponse.status} ${factsResponse.statusText}`)
}
const factsMarkdown = await factsResponse.text()
const { efforts, costs } = parseFactsMarkdown(factsMarkdown)
await writeFile(
  factsOut,
  renderFacts({
    sourceUrl: factsUrl,
    packageVersion: latest,
    lastRefreshed: new Date().toISOString().split("T")[0],
    efforts,
    costs,
  }),
  "utf-8",
)
console.log(
  `refresh-snapshot: wrote ${models.length} models to ${out} and facts (${Object.keys(efforts).length} efforts, ${Object.keys(costs).length} costs) to ${factsOut}`,
)
```

6. Add `renderFacts` (mirrors `renderSnapshot` style):

```js
function renderFacts({ sourceUrl, packageVersion, lastRefreshed, efforts, costs }) {
  const effortLines = Object.entries(efforts).map(
    ([id, levels]) => `  ${JSON.stringify(id)}: ${JSON.stringify(levels)},`,
  )
  const costLines = Object.entries(costs).map(
    ([id, cost]) =>
      `  ${JSON.stringify(id)}: { input: ${cost.input}, output: ${cost.output}, cacheRead: ${cost.cacheRead}, cacheWrite: ${cost.cacheWrite} },`,
  )
  return [
    "// src/catalog/facts.ts — GENERATED by scripts/refresh-snapshot.mjs. Do not edit.",
    "//",
    "// Capability facts (reasoning efforts + per-1M-token rates) parsed from the",
    "// command-code npm package's bundled model catalog (models.md). Regenerate",
    "// with `npm run refresh:snapshot`.",
    "",
    `export const FACTS_SOURCE_URL = ${JSON.stringify(sourceUrl)}`,
    `export const FACTS_PACKAGE_VERSION = ${JSON.stringify(packageVersion)}`,
    `export const FACTS_LAST_REFRESHED = ${JSON.stringify(lastRefreshed)}`,
    "",
    "export const MODEL_EFFORTS: Readonly<Record<string, readonly string[]>> = {",
    ...effortLines,
    "}",
    "",
    "export const MODEL_COSTS: Readonly<",
    "  Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>",
    "> = {",
    ...costLines,
    "}",
    "",
  ].join("\n")
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx tests/refresh-snapshot.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Run the full suite to catch import fallout**

Run: `npm test`
Expected: PASS (facts.ts not yet imported by src; existing snapshot test still green).

- [ ] **Step 6: Commit**

```bash
git add scripts/refresh-snapshot.mjs tests/refresh-snapshot.test.ts tests/helpers/mock-cc.ts
git commit -m "feat(facts): refresh script generates facts.ts from the CLI catalog"
```

---

### Task 3: Generate the real facts.ts and wire up reasoning/pricing modules

**Files:**

- Create: `src/catalog/facts.ts` (generated — run the script against the live network)
- Modify: `src/provider/reasoning.ts`
- Modify: `src/provider/pricing.ts`
- Modify: `src/provider/cost.ts`
- Modify: `tests/cost.test.ts`
- Modify: `tests/reasoning.test.ts` (only if a stale assertion breaks)

- [ ] **Step 1: Run the refresh script against the live network**

Run: `npm run refresh:snapshot`
Expected output includes `wrote 56 models to ... and facts (... efforts, ... costs) to ...`.

Then inspect the generated file:

Run: `head -40 src/catalog/facts.ts && grep -c '": {' src/catalog/facts.ts`
Expected: header + constants; the file compiles as valid TS.

Also verify drift is now visible — compare against the old hand-written values:

Run: `git diff --stat src/catalog/facts.ts src/provider/pricing.ts src/provider/reasoning.ts`
Expected: facts.ts is new; pricing.ts/reasoning.ts not yet changed.

- [ ] **Step 2: Write the failing test for flat-rate cost calculation**

Modify `tests/cost.test.ts`:

1. Delete the test `"tiers select the highest threshold exceeded"` (tiers are gone).
2. Update the first test's fallback object (the `?? {...}` inline fallback) — it hardcodes 0.14/0.28; keep the fallback but make the test not depend on the live table value. Replace the first test with:

```ts
  [
    "flat rates are applied per million tokens",
    () => {
      const u = usage(1_000_000, 500_000, 0, 0)
      calculateCommandCodeCost({ cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 } }, u)
      assertEqual(u.cost.input, 0.14)
      assertEqual(u.cost.output, 0.14)
      assertEqual(u.cost.total, 0.28)
    },
  ],
```

(no longer reads MODEL_COSTS at all — the table value would change every refresh)

- [ ] **Step 3: Run cost tests to verify the tier test fails (still present)**

Run: `npx tsx tests/cost.test.ts`
Expected: after step 2 the tier test is deleted, so this should PASS already. To verify the deletion is meaningful, run the full suite and confirm nothing else referenced tiers:

Run: `npm run typecheck`
Expected: FAIL — `CommandCodeModelCostTier` still referenced by `cost.ts`? No: typecheck fails because `pricing.ts` still exports `tiers` but nothing yet references it. Verify by reading the errors; expected errors are only about the still-present tier loop in `cost.ts` referencing `CommandCodeModelCost["tiers"]` — which stays valid until Task 3 Step 5.

- [ ] **Step 4: Rewrite reasoning.ts to re-export generated MODEL_EFFORTS**

Replace the `MODEL_EFFORTS` table (lines 16-44) and its doc comment in `src/provider/reasoning.ts` with:

```ts
import { MODEL_EFFORTS } from "../catalog/facts.js"

export { MODEL_EFFORTS }
```

Keep everything else (types, `REASONING_MODELS`, `isReasoningModel`, `reasoningVariantsForModel`, `mappedReasoningEffort`, `resolveProviderReasoning`) unchanged. The `CommandCodeReasoningEffort` type is still defined locally (it derives from `PiThinkingLevel`, which is not in the generated file).

- [ ] **Step 5: Rewrite pricing.ts to re-export generated MODEL_COSTS and drop tiers**

In `src/provider/pricing.ts`:

1. Replace the import block at the top with:

```ts
import {
  MODEL_COSTS,
  FACTS_SOURCE_URL as PRICING_SOURCE_URL,
  FACTS_LAST_REFRESHED as PRICING_LAST_VERIFIED,
} from "../catalog/facts.js"

export { MODEL_COSTS, PRICING_SOURCE_URL, PRICING_LAST_VERIFIED }
```

2. Delete `CommandCodeModelCostTier` interface and the `tiers?: readonly CommandCodeModelCostTier[]` field from `CommandCodeModelCost`.
3. Delete the whole `MODEL_COSTS` table body (lines 29-226 originally; after deletion, the file holds interfaces + re-exports).
4. Delete the now-unused `PRICING_SOURCE_URL`/`PRICING_LAST_VERIFIED` local consts (replaced by re-export aliases).

The resulting file shape:

```ts
// src/provider/pricing.ts — Command Code model pricing types + cost table.
// MODEL_COSTS is GENERATED (src/catalog/facts.ts) — see FACTS_SOURCE_URL.
import {
  MODEL_COSTS,
  FACTS_SOURCE_URL as PRICING_SOURCE_URL,
  FACTS_LAST_REFRESHED as PRICING_LAST_VERIFIED,
} from "../catalog/facts.js"

export { MODEL_COSTS, PRICING_SOURCE_URL, PRICING_LAST_VERIFIED }

export interface CommandCodeModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface CommandCodeModelCost extends CommandCodeModelCostRates {}

export const ZERO_MODEL_COST: CommandCodeModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}
```

- [ ] **Step 6: Remove the tier loop from cost.ts**

Replace lines 18-27 of `src/provider/cost.ts`:

```ts
export function calculateCommandCodeCost(model: CostModel, usage: CostUsage): void {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite
  let rates = model.cost
  let matchedThreshold = -1
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier
      matchedThreshold = tier.inputTokensAbove
    }
  }
```

with:

```ts
export function calculateCommandCodeCost(model: CostModel, usage: CostUsage): void {
  const rates = model.cost
```

Keep the rest of the function (longWrite/shortWrite arithmetic and assignments) unchanged.

- [ ] **Step 7: Run typecheck + full tests**

Run: `npm test`
Expected: PASS. Watch for:

- `tests/reasoning.test.ts` "MODEL_EFFORTS table is consistent" — should pass (re-export returns the same shape).
- `tests/catalog-metadata.test.ts` — muse-spark pricing test may now FAIL if the live rates differ from `{ input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 }`. If it fails, update the assertion to the generated values (the generated file is the new source of truth; the test exists to pin the value, not the other way around).
- `tests/plugin-models.test.ts` — sonnet cost assertion `{ input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }` must still hold (verified live: claude-sonnet-5 = $2/$10 · cache $0.2 (write $2.5)); flash variants `["high","max"]` must still hold (verified live).
- `tests/cost.test.ts` "all models in MODEL_COSTS are parseable" — passes on generated data.

- [ ] **Step 8: Commit**

```bash
git add src/catalog/facts.ts src/provider/reasoning.ts src/provider/pricing.ts src/provider/cost.ts tests/cost.test.ts
git commit -m "feat(facts): serve capability facts from the generated catalog file"
```

---

### Task 4: Release gate + ADR amendment

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `docs/adr/0003-release-gates.md`

- [ ] **Step 1: Extend the stale-snapshot gate to facts.ts**

In `.github/workflows/release.yml`, replace the `Fail on stale catalog snapshot` step:

```yaml
- name: Fail on stale catalog snapshot or facts
  run: |
    if git diff --exit-code -- src/catalog/snapshot.ts src/catalog/facts.ts; then
      echo "catalog snapshot and facts are fresh"
    else
      echo "::error::catalog snapshot or capability facts are stale. Run 'npm run refresh:snapshot' locally, commit src/catalog/snapshot.ts and src/catalog/facts.ts, land them on main, then re-tag ${GITHUB_REF_NAME}."
      exit 1
    fi
```

- [ ] **Step 2: Amend ADR 0003**

Append to `docs/adr/0003-release-gates.md`:

```md
## Amendment: capability facts gate (2026-08-19)

The refresh step now also regenerates `src/catalog/facts.ts` (reasoning efforts

- per-1M-token rates) from the command-code npm package's bundled `models.md`
  (the same registry that backs the CLI's `--list-models`). The stale gate
  covers both `snapshot.ts` and `facts.ts`: drift in either fails the run with
  the same local-refresh-and-commit instructions, so a stale facts file can
  neither ship nor be forgotten. See
  `docs/superpowers/specs/2026-08-19-facts-sync-design.md`.
```

- [ ] **Step 3: Verify workflow YAML is valid**

Run: `node -e "const yaml = require('js-yaml'); ..."` — if js-yaml is not installed, validate manually by re-reading the file for consistent indentation (2 spaces, step names unique).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml docs/adr/0003-release-gates.md
git commit -m "ci(facts): gate releases on stale capability facts (ADR 0003)"
```

---

### Task 5: Final verification

**Files:** none modified

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: exit 0.

- [ ] **Step 2: Snapshot + facts regenerate cleanly in a temp dir**

Run:

```bash
node scripts/refresh-snapshot.mjs --out /tmp/opencode/snap.ts --facts-out /tmp/opencode/facts.ts && npx tsc --noEmit
```

Expected: exit 0; generated files compile.

- [ ] **Step 3: git diff --check**

Run: `git diff --check && git status --short`
Expected: clean, no whitespace errors.

- [ ] **Step 4: Hand-verify the generated facts against the live page**

Run:

```bash
grep -A2 'claude-sonnet-5' src/catalog/facts.ts
grep -A2 'meta/muse-spark-1.2-contributor' src/catalog/facts.ts
grep -A2 'gpt-5.6-terra' src/catalog/facts.ts
```

Expected (verified live 2026-08-19): claude-sonnet-5 `2/10/0.2/2.5`; muse-spark-1.2-contributor `0.1/0.2/0.002/0`; gpt-5.6-terra `2/12/0.2/2.5` (drift fixed vs the old expired-discount row).

---

## Self-Review Notes

- **Spec coverage:** facts file (T2/T3), parser (T1), reasoning re-export (T3.4), pricing re-export + tier removal (T3.5-6), refresh script (T2.3), release gate + ADR (T4), tests (T1, T2.1, T3.2, T3.7). Hand-maintained residue documented in spec, no task needed (no deterministic source).
- **Type consistency:** `facts.ts` types MODEL_EFFORTS as `readonly string[]`; reasoning.ts re-exports as-is — `thinkingMetadataForModel` treats levels as strings, safe. `CommandCodeModelCost` loses `tiers` in T3.5 before `cost.ts` stops using it in T3.6 (same task).
- **Placeholder scan:** all code blocks complete; no TBDs. The only "watch for" items are conditional (catalog-metadata test value drift), with explicit resolution instructions.
