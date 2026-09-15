// tests/dependency-pins.test.ts — the exact-pin coupling gate.
//
// Two runtime dependencies are pinned exactly, not because pins are a style we
// like, but because upstream pins *them* exactly:
//
//   - `@opentui/solid` peer-requires `solid-js@1.9.12` — an exact version, in
//     every published release, latest included;
//   - `@opencode-ai/plugin` depends on `zod@4.1.8` — likewise exact.
//
// Floating either side installs a second copy, and both failure modes are
// real, not theoretical: Dependabot's `npm-minor-and-patch` group (PR #157)
// raised `solid-js` to 1.9.15 and let `zod` float to 4.6.2, which red the CI
// job twice over —
//
//   - solid-js: `npm ci` exits on ERESOLVE (an exact peer and a bumped root
//     cannot be one copy), so the suite never even starts;
//   - zod: with that unblocked, `tsc` fails with TS2322 in `src/plugin/index.ts`
//     — the tool schema we hand to `Hooks.tool` is built by *our* zod while
//     `@opencode-ai/plugin`'s `.d.ts` types that slot with its own nested copy,
//     and zod 4 stamps the exact version into `$ZodType` (`_zod.version.minor`),
//     so the two copies stop being assignable.
//
// The pins and the Dependabot `ignore` rules therefore move together: this gate
// fails loudly when upstream widens its requirement — the moment a human should
// revisit both — and it fails if an ignore rule disappears while its pin stays.
// It reads `package-lock.json` rather than `node_modules`, because the lock is
// what `npm ci` installs and it is present whether or not the tree is.

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
      peerDependencies?: Record<string, string>
    }
  >
}

interface Coupling {
  /** The dependency `package.json` pins. */
  readonly dep: string
  /** The installed package whose requirement forces that pin. */
  readonly owner: string
  /** Which requirement map on the owner carries it. */
  readonly field: "dependencies" | "peerDependencies"
  /** What drifting apart actually costs. */
  readonly drift: string
}

const COUPLINGS: readonly Coupling[] = [
  {
    dep: "solid-js",
    owner: "node_modules/@opentui/solid",
    field: "peerDependencies",
    drift:
      "`npm ci` fails with ERESOLVE, so CI never reaches the suite (the TUI host also rewrites `solid-js` imports to its own instance — ADR-0010 — so a second copy is not a copy we could use)",
  },
  {
    dep: "zod",
    owner: "node_modules/@opencode-ai/plugin",
    field: "dependencies",
    drift:
      "the build fails with TS2322 in src/plugin/index.ts, because the host's zod copy types `Hooks.tool` while ours builds the tool args",
  },
]

/** The exact requirement the owner package states for this dependency. */
function ownerRequirement(coupling: Coupling): string {
  const owner = lock.packages?.[coupling.owner]
  assert(
    owner,
    `${coupling.owner} is missing from package-lock.json — the coupling gate cannot check ${coupling.dep} without it`,
  )
  const requirement = owner[coupling.field]?.[coupling.dep]
  assert(
    typeof requirement === "string" && requirement.length > 0,
    `${coupling.owner} no longer declares ${coupling.field}["${coupling.dep}"] — upstream moved the requirement; revisit the ${coupling.dep} pin in package.json (and its Dependabot ignore rule)`,
  )
  return requirement
}

/**
 * The drift verdict, kept pure so the probe below can exercise it directly:
 * `undefined` when our pin is exactly what the owner asks for, otherwise the
 * explanation a failure prints.
 */
function pinDrift(pin: string | undefined, requirement: string): string | undefined {
  if (pin === requirement) return undefined
  return `package.json declares ${JSON.stringify(pin)}`
}

/** Every lock entry that resolves a copy of `dep`, at any depth. */
function resolvedCopies(dep: string): Array<[string, string]> {
  return Object.entries(lock.packages ?? {})
    .filter(([path]) => path === `node_modules/${dep}` || path.endsWith(`/node_modules/${dep}`))
    .map(([path, entry]) => [path, entry.version ?? ""] as [string, string])
}

run([
  ...COUPLINGS.map((coupling): [string, () => void] => [
    `package.json pins ${coupling.dep} to the version ${coupling.owner} requires`,
    () => {
      const requirement = ownerRequirement(coupling)
      const drift = pinDrift(pkg.dependencies?.[coupling.dep], requirement)
      assert(
        drift === undefined,
        `${coupling.owner} requires ${coupling.field}["${coupling.dep}"] = ${requirement}, but ${drift}. If upstream widened its requirement, unpin in package.json and drop the matching ignore in .github/dependabot.yml; if upstream moved the exact version, bump both in one commit. Drifting apart means ${coupling.drift}`,
      )
    },
  ]),
  ...COUPLINGS.map((coupling): [string, () => void] => [
    `the lock resolves exactly one ${coupling.dep} copy at the pinned version`,
    () => {
      const copies = resolvedCopies(coupling.dep)
      assertEqual(
        copies.map(([path]) => path),
        [`node_modules/${coupling.dep}`],
        `a second ${coupling.dep} copy in the tree is the failure mode this gate exists for: ${coupling.drift}`,
      )
      assertEqual(copies[0]?.[1], pkg.dependencies?.[coupling.dep])
    },
  ]),
  [
    "Dependabot still ignores the exactly-pinned dependencies",
    () => {
      const config = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf-8")
      for (const coupling of COUPLINGS) {
        assert(
          new RegExp(`-\\s*dependency-name:\\s*["']?${coupling.dep}["']?\\s*$`, "m").test(config),
          `.github/dependabot.yml no longer ignores ${coupling.dep} — the weekly group PR would bump a package upstream pins exactly, and ${coupling.drift}`,
        )
      }
    },
  ],
  [
    "the gate itself can smell the drift it forbids",
    () => {
      // Sensitivity check, in the spirit of tests/no-upstream-value-pins.test.ts:
      // a widened requirement must read as drift, and the exact match must not,
      // so a future regression in this file cannot silently re-open the failure
      // class it was written for.
      assertEqual(pinDrift("1.9.12", "1.9.12"), undefined)
      assert(pinDrift("1.9.15", "1.9.12") !== undefined, "a bump must read as drift")
      assert(
        pinDrift("1.9.12", "^1.9.12") !== undefined,
        "a widened requirement must read as drift",
      )
      assert(pinDrift(undefined, "1.9.12") !== undefined, "a missing pin must read as drift")
    },
  ],
])
