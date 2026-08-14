// tests/models.test.ts — model catalog fetch, parse, cache with offline
// fallback (PLAN #7, port of pi's test-models.ts catalog subset)
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandCodeModelsFromApiResponse, loadCommandCodeModels } from "../src/provider/models.js"
import { startMockCc } from "./helpers/mock-cc.js"
import { assert, assertEqual, throws, run } from "./harness.js"

run([
  [
    "parses the Provider API model list",
    () => {
      const models = commandCodeModelsFromApiResponse({
        object: "list",
        data: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 200000 }],
      })
      assertEqual(models.length, 1)
      assertEqual(models[0].id, "claude-sonnet-5")
      assertEqual(models[0].name, "Claude Sonnet 5 (CC)")
      assertEqual(models[0].contextWindow, 200000)
      assertEqual(models[0].reasoning, true) // known reasoning model
    },
  ],

  [
    "unknown models get no reasoning flag",
    () => {
      const models = commandCodeModelsFromApiResponse({
        object: "list",
        data: [{ id: "brand-new/model", name: "New", context_length: 1000 }],
      })
      assertEqual(models[0].reasoning, false)
    },
  ],

  [
    "rejects a malformed response",
    () => {
      throws(() => commandCodeModelsFromApiResponse({ object: "nope", data: [] }))
      throws(() => commandCodeModelsFromApiResponse({ object: "list", data: [{ id: 1 }] }))
    },
  ],

  [
    "loads live catalog and caches it",
    async () => {
      const cacheDir = await mkdtemp(join(tmpdir(), "cc-models-"))
      const cachePath = join(cacheDir, "models.json")
      const mock = await startMockCc({
        models: {
          object: "list",
          data: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 200000 }],
        },
      })
      try {
        const result = await loadCommandCodeModels({
          url: `${mock.url}/provider/v1/models`,
          cachePath,
          timeoutMs: 1000,
        })
        assertEqual(result.source, "live")
        assertEqual(result.models.length, 1)
        const cached = JSON.parse(await readFile(cachePath, "utf-8"))
        assertEqual(cached.version, 1)
      } finally {
        await mock.close()
        await rm(cacheDir, { recursive: true, force: true })
      }
    },
  ],

  [
    "falls back to cache when the endpoint is down",
    async () => {
      const cacheDir = await mkdtemp(join(tmpdir(), "cc-models-"))
      const cachePath = join(cacheDir, "models.json")
      const mock = await startMockCc({
        models: {
          object: "list",
          data: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 200000 }],
        },
      })
      await loadCommandCodeModels({
        url: `${mock.url}/provider/v1/models`,
        cachePath,
        timeoutMs: 1000,
      })
      await mock.close()
      const result = await loadCommandCodeModels({
        url: `${mock.url}/provider/v1/models`,
        cachePath,
        timeoutMs: 1000,
      })
      assertEqual(result.source, "cache")
      assertEqual(result.models.length, 1)
      await rm(cacheDir, { recursive: true, force: true })
    },
  ],

  [
    "empty result with warning when nothing works",
    async () => {
      const cacheDir = await mkdtemp(join(tmpdir(), "cc-models-"))
      const cachePath = join(cacheDir, "models.json")
      const mock = await startMockCc()
      try {
        const result = await loadCommandCodeModels({
          url: `${mock.url}/provider/v1/models`,
          cachePath,
          timeoutMs: 1000,
        })
        assertEqual(result.source, "empty")
        assert(result.warning)
      } finally {
        await mock.close()
        await rm(cacheDir, { recursive: true, force: true })
      }
    },
  ],
])
