// tests/dependency-pins.test.ts — the peer-containment coupling gate.
//
// Two runtime dependencies cannot float freely, because the installed tree
// states what version it needs instead of leaving the choice to us:
//
//   - `solid-js`: `@opentui/solid` peer-requires `^1.9.12` (exact `1.9.12`
//     through 0.6.x), while its nested `babel-preset-solid@1.9.16`
//     peer-requires `^1.9.16` — the binding floor after PR #338;
//   - `zod`: `@opencode-ai/plugin` depends on `4.1.8` exactly.
//
// So `package.json` may only declare a range every one of those requirements
// also admits: it may narrow a caret requirement (and then ride with the weekly
// Dependabot group), never widen it, and a dependency with any exact
// requirement stays exact and stays ignored.
//
// The failure mode is concrete, not theoretical: Dependabot's
// `npm-minor-and-patch` group (PR #157) raised `solid-js` to 1.9.15 while
// upstream pinned 1.9.12, and let `zod` float to 4.6.2, which red the CI job
// twice over —
//
//   - solid-js: `npm ci` exits on ERESOLVE (an exact peer and a bumped root
//     cannot be one copy), so the suite never even starts;
//   - zod: with that unblocked, `tsc` fails with TS2322 in `src/plugin/index.ts`
//     — the tool schema we hand to `Hooks.tool` is built by *our* zod while
//     `@opencode-ai/plugin`'s `.d.ts` types that slot with its own nested copy,
//     and zod 4 stamps the exact version into `$ZodType` (`_zod.version.minor`),
//     so the two copies stop being assignable.
//
// This gate fails loudly when upstream changes a requirement — the moment a
// human should revisit the declaration — and the single-copy assertion is what
// guards a narrowed range: a declaration the peers cannot share nests a second
// copy. It reads `package-lock.json` rather than `node_modules`, because the
// lock is what `npm ci` installs and it is present whether or not the tree is.

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { assert, assertEqual, run } from "./harness.js"

const require = createRequire(import.meta.url)
const pkg = require("../package.json") as { dependencies?: Record<string, string> }
const lock = require("../package-lock.json") as {
  packages?: Record<
    string,
    {
      version?: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
  >
}

type RequirementField = "dependencies" | "optionalDependencies" | "peerDependencies"

interface Coupling {
  /** The dependency `package.json` declares. */
  readonly dep: string
  /** What drifting apart actually costs. */
  readonly drift: string
}

interface Requirement {
  /** The installed package that states it. */
  readonly owner: string
  /** Which requirement map carries it. */
  readonly field: RequirementField
  /** The range or exact version the owner states. */
  readonly range: string
}

const COUPLINGS: readonly Coupling[] = [
  {
    dep: "solid-js",
    drift:
      "a second copy is not a copy we could use (ADR-0010 rewrites `solid-js` imports to the host's single reactive runtime), and `npm ci` fails with ERESOLVE when the root copy no longer satisfies the peer",
  },
  {
    dep: "zod",
    drift:
      "the build fails with TS2322 in src/plugin/index.ts, because the host's zod copy types `Hooks.tool` while ours builds the tool args",
  },
]

const FIELDS: readonly RequirementField[] = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]

/**
 * Every requirement the installed tree states for `dep`. The root entry is
 * skipped: its `dependencies` map is our own declaration, the subject of the
 * gate rather than a constraint on it.
 */
function requirementsFor(dep: string): Requirement[] {
  const requirements: Requirement[] = []
  for (const [owner, entry] of Object.entries(lock.packages ?? {})) {
    if (owner === "") continue
    for (const field of FIELDS) {
      const range = entry[field]?.[dep]
      if (typeof range === "string" && range.length > 0) {
        requirements.push({ owner, field, range })
      }
    }
  }
  return requirements
}

type Version = readonly [number, number, number]

/**
 * The three requirement shapes this repo allows: an exact version, a caret
 * range with a patch (`^1.9.12`), or a caret range without one (`^1.3`, as
 * `solid-refresh` — vite-plugin-solid's dependency — states its solid-js
 * peer). A patchless caret reads as `.0`; anything else (`~`, `>=`, `||`, a
 * tag) returns `undefined` so the gate fails loudly instead of guessing.
 */
function parseRange(
  range: string,
): { readonly kind: "exact" | "caret"; readonly version: Version } | undefined {
  const exact = /^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  if (exact) {
    return { kind: "exact", version: [Number(exact[1]), Number(exact[2]), Number(exact[3])] }
  }
  const caret = /^\^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range)
  if (caret) {
    return {
      kind: "caret",
      version: [Number(caret[1]), Number(caret[2]), Number(caret[3] ?? "0")],
    }
  }
  return undefined
}

/**
 * npm's caret semantics: `^1.9.12` admits every `1.x.y >= 1.9.12`, while
 * `^0.2.3` stops at the next minor. Kept local so the gate stays free of a
 * semver dependency.
 */
function caretAdmits(candidate: Version, base: Version): boolean {
  const [major, minor, patch] = candidate
  const [baseMajor, baseMinor, basePatch] = base
  if (major !== baseMajor) return false
  if (major === 0 && minor !== baseMinor) return false
  return minor > baseMinor || (minor === baseMinor && patch >= basePatch)
}

/** Is one resolved version admitted by a requirement the tree states? */
function satisfies(version: string, requirement: string): boolean {
  const resolved = parseRange(version)
  const required = parseRange(requirement)
  if (!resolved || resolved.kind !== "exact" || !required) return false
  if (required.kind === "exact") return resolved.version.join(".") === required.version.join(".")
  return caretAdmits(resolved.version, required.version)
}

/**
 * The containment verdict: `true` when every version the declaration admits is
 * also admitted by the requirement. A declaration may narrow a requirement; it
 * may never widen one, and an unmodelled shape is never admitted.
 */
function admitsOnly(declared: string, requirement: string): boolean {
  const pin = parseRange(declared)
  const required = parseRange(requirement)
  if (!pin || !required) return false
  if (required.kind === "exact") {
    return pin.kind === "exact" && pin.version.join(".") === required.version.join(".")
  }
  if (pin.kind === "exact") return satisfies(declared, requirement)
  return caretAdmits(pin.version, required.version)
}

/** Every lock entry that resolves a copy of `dep`, at any depth. */
function resolvedCopies(dep: string): Array<[string, string]> {
  return Object.entries(lock.packages ?? {})
    .filter(([path]) => path === `node_modules/${dep}` || path.endsWith(`/node_modules/${dep}`))
    .map(([path, entry]) => [path, entry.version ?? ""] as [string, string])
}

run([
  ...COUPLINGS.map((coupling): [string, () => void] => [
    `package.json declares ${coupling.dep} inside every requirement the tree states`,
    () => {
      const requirements = requirementsFor(coupling.dep)
      assert(
        requirements.length > 0,
        `no installed package states a requirement for ${coupling.dep} — the lock shape changed and this gate is now blind`,
      )
      const declared = pkg.dependencies?.[coupling.dep]
      for (const { owner, field, range } of requirements) {
        assert(
          declared !== undefined && admitsOnly(declared, range),
          `${owner} requires ${field}["${coupling.dep}"] = ${range}, but package.json declares ${JSON.stringify(declared)}. Declare a range every requirement admits — narrow it, never widen it — and keep .github/dependabot.yml in step: ignore a dependency with an exact requirement; let a narrowed caret range ride with the group. A shape other than an exact version or a caret range needs this gate taught first. Drifting apart means ${coupling.drift}`,
        )
      }
    },
  ]),
  ...COUPLINGS.map((coupling): [string, () => void] => [
    `the lock resolves exactly one ${coupling.dep} copy every requirement admits`,
    () => {
      const requirements = requirementsFor(coupling.dep)
      const copies = resolvedCopies(coupling.dep)
      assertEqual(
        copies.map(([path]) => path),
        [`node_modules/${coupling.dep}`],
        `a second ${coupling.dep} copy in the tree is the failure mode this gate exists for: ${coupling.drift}`,
      )
      const resolved = copies[0]?.[1] ?? ""
      for (const { owner, field, range } of requirements) {
        assert(
          satisfies(resolved, range),
          `the lock resolves ${coupling.dep}@${resolved}, which ${owner}'s ${field} requirement ${range} does not admit`,
        )
      }
    },
  ]),
  [
    "Dependabot still ignores the exactly-pinned dependencies",
    () => {
      const config = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf-8")
      for (const coupling of COUPLINGS) {
        const exact = requirementsFor(coupling.dep).some(
          ({ range }) => parseRange(range)?.kind === "exact",
        )
        const ignored = new RegExp(
          `-\\s*dependency-name:\\s*["']?${coupling.dep}["']?\\s*$`,
          "m",
        ).test(config)
        if (exact) {
          assert(
            ignored,
            `.github/dependabot.yml no longer ignores ${coupling.dep} — the weekly group PR would bump a package the tree pins exactly, and ${coupling.drift}`,
          )
        } else {
          assert(
            !ignored,
            `.github/dependabot.yml still ignores ${coupling.dep}, but every requirement is a range we narrow and Dependabot may bump it inside the group — drop the stale ignore rule`,
          )
        }
      }
    },
  ],
  [
    "the gate itself can smell the drift it forbids",
    () => {
      // Sensitivity check, in the spirit of tests/no-upstream-value-pins.test.ts:
      // a widened or reshaped declaration must read as drift, and a narrowing
      // one must not, so a future regression in this file cannot silently
      // re-open the failure class it was written for.
      assert(admitsOnly("^1.9.18", "^1.9.12"), "a narrowed caret range is admitted")
      assert(admitsOnly("^1.9.18", "^1.3"), "a narrowed caret range admits a patchless caret")
      assert(admitsOnly("1.9.12", "^1.9.12"), "an exact version inside the caret range is admitted")
      assert(admitsOnly("1.9.12", "1.9.12"), "an identical exact requirement is admitted")
      assert(!admitsOnly("^1.9.11", "^1.9.12"), "a lower caret floor widens the requirement")
      assert(!admitsOnly("^1.2.9", "^1.3"), "a caret below the patchless caret's floor widens it")
      assert(!admitsOnly("^2.0.0", "^1.9.12"), "a different major widens the requirement")
      assert(!admitsOnly("^1.9.18", "1.9.12"), "a caret cannot replace an exact requirement")
      assert(!admitsOnly("~1.9.18", "^1.9.12"), "an unmodelled shape is never admitted")
      assert(!admitsOnly(">=1.9.0", "^1.9.12"), "an unbounded range is never admitted")
      assert(satisfies("1.9.18", "^1.9.12"), "the resolved copy is inside the caret range")
      assert(satisfies("1.9.18", "^1.3"), "the resolved copy is inside the patchless caret")
      assert(!satisfies("1.9.12", "^1.9.16"), "a resolved copy below the floor is rejected")
      assert(!satisfies("2.0.0", "^1.9.12"), "a resolved copy at another major is rejected")
    },
  ],
])
