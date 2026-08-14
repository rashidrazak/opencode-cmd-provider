// tests/integration-do-generate.test.ts — doGenerate non-streaming (PLAN #9)
//
// Asserts real AI SDK v3 shapes: content array with { type: "text" } parts,
// tool calls as { type: "tool-call" } parts with stringified `input`,
// finishReason { unified, raw }, nested usage.
import { createCommandCode } from "../src/provider/index.js"
import { startMockCc, textDelta, reasoningDelta, toolCall, finishEvent } from "./helpers/mock-cc.js"
import type { LanguageModelV3Prompt } from "../src/provider/aisdk-types.js"
import { assertEqual, rejects, run } from "./harness.js"

const prompt: LanguageModelV3Prompt = [{ role: "user", content: "hi" }]

run([
  [
    "doGenerate aggregates text + reasoning + usage",
    async () => {
      const mock = await startMockCc({
        stream: [reasoningDelta("think"), textDelta("Hello "), textDelta("world"), finishEvent()],
      })
      try {
        const model = createCommandCode({ apiKey: "user_test", baseURL: mock.url }).languageModel(
          "claude-sonnet-5",
        )
        const result = await model.doGenerate({ prompt })
        const texts = (result.content ?? [])
          .filter((p) => (p as { type?: string }).type === "text")
          .map((p) => (p as { text?: string }).text)
        assertEqual(texts, ["Hello world"])
        const reasoning = (result.content ?? [])
          .filter((p) => (p as { type?: string }).type === "reasoning")
          .map((p) => (p as { text?: string }).text)
        assertEqual(reasoning, ["think"])
        assertEqual(result.finishReason, { unified: "stop", raw: "stop" })
        assertEqual(result.usage, {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        })
      } finally {
        await mock.close()
      }
    },
  ],

  [
    "doGenerate aggregates tool calls",
    async () => {
      const mock = await startMockCc({
        stream: [toolCall("t1", "read", { path: "x" }), finishEvent({ finishReason: "tool_use" })],
      })
      try {
        const model = createCommandCode({ apiKey: "user_test", baseURL: mock.url }).languageModel(
          "claude-sonnet-5",
        )
        const result = await model.doGenerate({ prompt })
        assertEqual(result.finishReason, { unified: "tool-calls", raw: "tool_use" })
        const calls = (result.content ?? []).filter(
          (p) => (p as { type?: string }).type === "tool-call",
        )
        assertEqual(calls.length, 1)
        const call = calls[0] as { toolName?: string; input?: string }
        assertEqual(call.toolName, "read")
        assertEqual(call.input, '{"path":"x"}')
      } finally {
        await mock.close()
      }
    },
  ],

  [
    "doGenerate surfaces stream errors",
    async () => {
      const mock = await startMockCc({ stream: [{ type: "error", error: { message: "nope" } }] })
      try {
        const model = createCommandCode({ apiKey: "user_test", baseURL: mock.url }).languageModel(
          "claude-sonnet-5",
        )
        await rejects(model.doGenerate({ prompt }), /nope/)
      } finally {
        await mock.close()
      }
    },
  ],
])
