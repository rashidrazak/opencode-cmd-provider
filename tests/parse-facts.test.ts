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
