// tests/parse-facts.test.ts — models.md facts parser (facts auto-sync design)
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseFactsMarkdown } from "../scripts/parse-facts.mjs"
import { assertEqual, run, throws } from "./harness.js"

const FIXTURE = join(import.meta.dirname, "fixtures", "models.md")

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
    "fine-grained contributor rates parse exactly (moved from artifact value pins, issue #108 story 8)",
    async () => {
      // These upstream *values* were once pinned against the generated
      // artifact (tests/catalog-metadata.test.ts); upstream can move them at
      // any time, so they live here over a synthetic fixture instead. The
      // artifact tests keep only the relation "every snapshot model has a
      // cost entry".
      const md = await readFile(FIXTURE, "utf-8")
      const facts = parseFactsMarkdown(md)
      assertEqual(facts.costs["meta/muse-spark-1.2-contributor"], {
        input: 0.1,
        output: 0.2,
        cacheRead: 0.002,
        cacheWrite: 0,
      })
      assertEqual(facts.costs["meta/muse-spark-1.1"], {
        input: 1.25,
        output: 4.25,
        cacheRead: 0.15,
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

  [
    "table rows missing a backticked id fail loudly",
    () => {
      const md = "| x/y | X Y | 1M | low | $1/$1 · cache $0.1 | Go | best |\n"
      throws(() => parseFactsMarkdown(md), /could not parse row: \| x\/y \|/)
    },
  ],

  [
    "non-finite parsed prices fail loudly",
    () => {
      const md = "| `x/y` | X Y | 1M | low | $1..2/$3 · cache $0.1 | Go | best |\n"
      throws(() => parseFactsMarkdown(md), /could not parse price for x\/y/)
    },
  ],
])
