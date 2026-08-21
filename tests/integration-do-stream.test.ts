// tests/integration-do-stream.test.ts — doStream tracer bullet (PLAN #8)
//
// Asserts the real AI SDK v3 shapes the model emits: text-delta parts carry
// { id, delta }, tool calls stream tool-input-start/delta/end + a final
// tool-call part whose `input` is stringified JSON, finishReason is
// { unified, raw }, and usage is nested { inputTokens, outputTokens }.
import { createCommandCode } from "../src/provider/index.js"
import { startMockCc, textDelta, reasoningDelta, toolCall, finishEvent } from "./helpers/mock-cc.js"
import type { LanguageModelV3Prompt } from "../src/provider/aisdk-types.js"
import { assert, assertEqual, run } from "./harness.js"

type Model = ReturnType<ReturnType<typeof createCommandCode>["languageModel"]>

async function collect(
  model: Model,
  prompt: LanguageModelV3Prompt,
): Promise<Array<Record<string, unknown>>> {
  const result = await model.doStream({ prompt, mode: { type: "regular" }, maxOutputTokens: 1000 })
  const parts: Array<Record<string, unknown>> = []
  const reader = result.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as unknown as Record<string, unknown>)
  }
  return parts
}

run([
  [
    "streams text deltas and finish",
    async () => {
      const mock = await startMockCc({ stream: [textDelta("hel"), textDelta("lo"), finishEvent()] })
      try {
        const provider = createCommandCode({ apiKey: "user_test", baseURL: mock.url })
        const model = provider.languageModel("claude-sonnet-5")
        const parts = await collect(model, [{ role: "user", content: "hi" }])
        const texts = parts
          .filter((p) => p.type === "text-delta")
          .map((p) => (p as { delta?: string }).delta)
        assertEqual(texts, ["hel", "lo"])
        const finish = parts.find((p) => p.type === "finish") as {
          finishReason?: unknown
          usage?: unknown
        }
        assertEqual(finish.finishReason, { unified: "stop", raw: "stop" })
        assertEqual(finish.usage, {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        })
      } finally {
        await mock.close()
      }
    },
  ],

  [
    "finish usage includes cached input tokens (issue #36)",
    async () => {
      const mock = await startMockCc({
        stream: [
          textDelta("hi"),
          finishEvent({
            totalUsage: {
              inputTokens: 100,
              outputTokens: 50,
              inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 30 },
            },
          }),
        ],
      })
      try {
        const provider = createCommandCode({ apiKey: "user_test", baseURL: mock.url })
        const parts = await collect(provider.languageModel("claude-sonnet-5"), [
          { role: "user", content: "hi" },
        ])
        const finish = parts.find((p) => p.type === "finish") as { usage?: unknown }
        assertEqual(finish.usage, {
          inputTokens: { total: 100, noCache: 40, cacheRead: 30, cacheWrite: 30 },
          outputTokens: { total: 50, text: 50, reasoning: 0 },
        })
      } finally {
        await mock.close()
      }
    },
  ],

  [
    "streams reasoning deltas before text",
    async () => {
      const mock = await startMockCc({
        stream: [reasoningDelta("think"), textDelta("answer"), finishEvent()],
      })
      try {
        const provider = createCommandCode({ apiKey: "user_test", baseURL: mock.url })
        const parts = await collect(provider.languageModel("claude-sonnet-5"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(parts[0].type, "reasoning-delta")
        assertEqual((parts[1] as { delta?: string }).delta, "answer")
      } finally {
        await mock.close()
      }
    },
  ],

  [
    "streams tool calls",
    async () => {
      const mock = await startMockCc({
        stream: [
          toolCall("t1", "read", { path: "a.ts" }),
          finishEvent({ finishReason: "tool_use" }),
        ],
      })
      try {
        const provider = createCommandCode({ apiKey: "user_test", baseURL: mock.url })
        const parts = await collect(provider.languageModel("claude-sonnet-5"), [
          { role: "user", content: "hi" },
        ])
        const call = parts.find((p) => p.type === "tool-call") as {
          toolName?: string
          input?: string
        }
        assertEqual(call.toolName, "read")
        assertEqual(call.input, '{"path":"a.ts"}')
        const finish = parts.find((p) => p.type === "finish") as { finishReason?: unknown }
        assertEqual(finish.finishReason, { unified: "tool-calls", raw: "tool_use" })
      } finally {
        await mock.close()
      }
    },
  ],

  [
    "sends the CC payload shape",
    async () => {
      const received: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = []
      const mock = await startMockCc({
        stream: [finishEvent()],
        onGenerate: (body, headers) => received.push({ body, headers }),
      })
      try {
        const provider = createCommandCode({ apiKey: "user_test", baseURL: mock.url })
        await collect(provider.languageModel("claude-sonnet-5"), [{ role: "user", content: "hi" }])
        assertEqual(received.length, 1)
        const { body, headers } = received[0]
        const params = body.params as Record<string, unknown>
        assertEqual(params.model, "claude-sonnet-5")
        assertEqual(params.stream, true)
        assertEqual(params.max_tokens, 1000) // min(maxOutputTokens, model max, 64k)
        assertEqual((params.messages as Array<{ role: string }>)[0].role, "user")
        assertEqual(headers["authorization"], "Bearer user_test")
        assertEqual(headers["x-command-code-version"], "1.15.1")
        assertEqual(headers["x-cli-environment"], "production")
      } finally {
        await mock.close()
      }
    },
  ],

  [
    "doStream surfaces a helpful no-key error",
    async () => {
      const mock = await startMockCc({ stream: [finishEvent()] })
      try {
        const model = createCommandCode({ baseURL: mock.url, authPaths: [] }).languageModel(
          "claude-sonnet-5",
        )
        const result = await model.doStream({
          prompt: [{ role: "user", content: "hi" }],
          mode: { type: "regular" },
        })
        const reader = result.stream.getReader()
        const part = (await reader.read()).value as { type?: string; error?: Error }
        assertEqual(part.type, "error")
        assert((part.error?.message ?? "").includes("COMMANDCODE_API_KEY"))
      } finally {
        await mock.close()
      }
    },
  ],
])
