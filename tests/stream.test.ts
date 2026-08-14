// tests/stream.test.ts — Command Code SSE events → AI SDK v3 stream parts (PLAN #3 Part A)
//
// The plan's original tests asserted v2-style flat stream parts. The installed
// @ai-sdk/provider (3.0.15) emits v3 shapes: text-delta/reasoning-delta carry
// `id`+`delta`, tool calls stream as tool-input-start/delta/end, finishReason
// is { unified, raw }, and usage is nested { inputTokens: {…}, outputTokens: {…} }.
// These tests assert the real v3 shapes (the shapes opencode consumes).
import {
  parseStreamEventLine,
  mapFinishReason,
  ccEventToStreamPart,
  ccUsageToAiSdkUsage,
} from "../src/provider/stream.js"
import { assert, assertEqual, rejects, run } from "./harness.js"

run([
  [
    "parseStreamEventLine skips empty/comment/event lines and [DONE]",
    () => {
      assertEqual(parseStreamEventLine(""), undefined)
      assertEqual(parseStreamEventLine(":"), undefined)
      assertEqual(parseStreamEventLine("event: whatever"), undefined)
      assertEqual(parseStreamEventLine("data: [DONE]"), undefined)
    },
  ],

  [
    "parseStreamEventLine parses data JSON",
    () => {
      assertEqual(parseStreamEventLine('data: {"type":"text-delta","text":"hi"}'), {
        type: "text-delta",
        text: "hi",
      })
    },
  ],

  [
    "parseStreamEventLine ignores malformed JSON",
    () => {
      assertEqual(parseStreamEventLine("data: {nope"), undefined)
    },
  ],

  [
    "mapFinishReason maps CC reasons to AI SDK v3 finish reasons",
    () => {
      assertEqual(mapFinishReason("stop"), { unified: "stop", raw: "stop" })
      assertEqual(mapFinishReason("tool_use"), { unified: "tool-calls", raw: "tool_use" })
      assertEqual(mapFinishReason("length"), { unified: "length", raw: "length" })
      assertEqual(mapFinishReason("max_output_tokens"), {
        unified: "length",
        raw: "max_output_tokens",
      })
      assertEqual(mapFinishReason("error"), { unified: "error", raw: "error" })
      assertEqual(mapFinishReason("weird"), { unified: "other", raw: "weird" })
    },
  ],

  [
    "text-delta maps to v3 text-delta part",
    () => {
      const parts = ccEventToStreamPart({ type: "text-delta", text: "hi" })
      assert(parts.length === 1, "one part")
      const p = parts[0] as { type: string; id?: string; delta?: string }
      assertEqual(p.type, "text-delta")
      assert(typeof p.id === "string" && p.id.length > 0, "text-delta has an id")
      assertEqual(p.delta, "hi")
    },
  ],

  [
    "reasoning-delta maps to v3 reasoning-delta part",
    () => {
      const parts = ccEventToStreamPart({ type: "reasoning-delta", text: "thinking" })
      assert(parts.length === 1, "one part")
      const p = parts[0] as { type: string; id?: string; delta?: string }
      assertEqual(p.type, "reasoning-delta")
      assert(typeof p.id === "string" && p.id.length > 0, "reasoning-delta has an id")
      assertEqual(p.delta, "thinking")
    },
  ],

  [
    "tool-call maps to v3 tool-input start/delta/end + tool-call parts",
    () => {
      const parts = ccEventToStreamPart({
        type: "tool-call",
        toolCallId: "t1",
        toolName: "read",
        input: { path: "x" },
      })
      const types = parts.map((p) => (p as { type: string }).type)
      assertEqual(types, ["tool-input-start", "tool-input-delta", "tool-input-end", "tool-call"])
      const start = parts[0] as { type: string; id?: string; toolName?: string }
      assertEqual(start.id, "t1")
      assertEqual(start.toolName, "read")
      const delta = parts[1] as { type: string; id?: string; delta?: string }
      assertEqual(delta.id, "t1")
      assertEqual(delta.delta, '{"path":"x"}')
      const call = parts[3] as {
        type: string
        toolCallId?: string
        toolName?: string
        input?: string
      }
      assertEqual(call.toolCallId, "t1")
      assertEqual(call.toolName, "read")
      assertEqual(call.input, '{"path":"x"}')
    },
  ],

  [
    "finish maps usage and finishReason to v3 shapes",
    () => {
      const parts = ccEventToStreamPart({
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 1 },
        },
      })
      assert(parts.length === 1, "one part")
      const finish = parts[0] as { type: string; finishReason?: unknown; usage?: unknown }
      assertEqual(finish.type, "finish")
      assertEqual(finish.finishReason, { unified: "stop", raw: "stop" })
      assertEqual(finish.usage, {
        inputTokens: { total: 7, noCache: 7, cacheRead: 2, cacheWrite: 1 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      })
    },
  ],

  [
    "finish with missing details falls back to total input",
    () => {
      const parts = ccEventToStreamPart({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 9, outputTokens: 2 },
      })
      const finish = parts[0] as {
        usage?: { inputTokens?: { total?: number }; outputTokens?: { total?: number } }
      }
      assertEqual(finish.usage, {
        inputTokens: { total: 9, noCache: 9, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      })
    },
  ],

  [
    "error event throws with extracted message",
    () => {
      rejects(
        Promise.resolve().then(() => {
          ccEventToStreamPart({ type: "error", error: { message: "boom" } })
        }),
        /boom/,
      )
    },
  ],

  [
    "ccUsageToAiSdkUsage handles cache details",
    () => {
      // Plan contract: the function reads `totalUsage` from the finish event.
      const usage = ccUsageToAiSdkUsage({
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 30 },
        },
      })
      assertEqual(usage, {
        inputTokens: { total: 40, noCache: 40, cacheRead: 30, cacheWrite: 30 },
        outputTokens: { total: 50, text: 50, reasoning: 0 },
      })
    },
  ],

  [
    "unknown events are ignored",
    () => {
      assertEqual(ccEventToStreamPart({ type: "heartbeat" }), [])
    },
  ],
])

// --- Mock CC server harness smoke test (used by #8/#9/#12) ---
import { startMockCc, textDelta, finishEvent, eventsEnd } from "./helpers/mock-cc.js"

run([
  [
    "mock-cc streams SSE events and records hits",
    async () => {
      const mock = await startMockCc({ stream: [textDelta("hi"), finishEvent(), eventsEnd] })
      try {
        const res = await fetch(`${mock.url}/alpha/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "test" }),
        })
        assertEqual(res.status, 200)
        const body = await res.text()
        assert(body.includes('"type":"text-delta"'), "streams text-delta")
        assert(body.includes('"type":"finish"'), "streams finish")
        assertEqual(mock.hits.generate, 1)
        assertEqual(mock.hits.models, 0)
      } finally {
        await mock.close()
      }
    },
  ],

  [
    "mock-cc models endpoint returns empty list by default",
    async () => {
      const mock = await startMockCc()
      try {
        const res = await fetch(`${mock.url}/provider/v1/models`)
        assertEqual(res.status, 200)
        assertEqual(await res.json(), { object: "list", data: [] })
        assertEqual(mock.hits.models, 1)
      } finally {
        await mock.close()
      }
    },
  ],
])
