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
  createOpenAIStreamParser,
  createAnthropicStreamParser,
  anthropicEventToStreamPart,
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
    "reasoning-start maps to v3 reasoning-start part carrying the event id",
    () => {
      const parts = ccEventToStreamPart({ type: "reasoning-start", id: "reasoning-0" })
      assert(parts.length === 1, "one part")
      const p = parts[0] as { type: string; id?: string }
      assertEqual(p.type, "reasoning-start")
      assertEqual(p.id, "reasoning-0")
    },
  ],

  [
    "reasoning-end maps to v3 reasoning-end part carrying the event id",
    () => {
      const parts = ccEventToStreamPart({ type: "reasoning-end", id: "reasoning-0" })
      assert(parts.length === 1, "one part")
      const p = parts[0] as { type: string; id?: string }
      assertEqual(p.type, "reasoning-end")
      assertEqual(p.id, "reasoning-0")
    },
  ],

  [
    "text-start maps to v3 text-start part carrying the event id",
    () => {
      const parts = ccEventToStreamPart({ type: "text-start", id: "txt-0" })
      assert(parts.length === 1, "one part")
      const p = parts[0] as { type: string; id?: string }
      assertEqual(p.type, "text-start")
      assertEqual(p.id, "txt-0")
    },
  ],

  [
    "text-end maps to v3 text-end part carrying the event id",
    () => {
      const parts = ccEventToStreamPart({ type: "text-end", id: "txt-0" })
      assert(parts.length === 1, "one part")
      const p = parts[0] as { type: string; id?: string }
      assertEqual(p.type, "text-end")
      assertEqual(p.id, "txt-0")
    },
  ],

  [
    "real reasoning+text event sequence emits start/end parts so AI SDK can assemble",
    () => {
      // Mirrors the live Command Code SSE for deepseek/deepseek-v4-flash
      // (captured 2026-08-15): reasoning-start → reasoning-deltas →
      // reasoning-end → text-start → text-deltas → text-end → finish.
      // Without the start/end parts the AI SDK's streamText consumer throws
      // "reasoning part <id> not found" / "text part <id> not found".
      const events = [
        { type: "reasoning-start", id: "reasoning-0" },
        { type: "reasoning-delta", id: "reasoning-0", text: "The" },
        { type: "reasoning-delta", id: "reasoning-0", text: " user" },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "text-start", id: "txt-0" },
        { type: "text-delta", id: "txt-0", text: "Hello" },
        { type: "text-delta", id: "txt-0", text: "!" },
        { type: "text-end", id: "txt-0" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 7, outputTokens: 2 } },
      ]
      const parts = events.flatMap((e) => ccEventToStreamPart(e))
      const byType = new Map<string, number>()
      for (const p of parts) {
        const t = (p as { type: string }).type
        byType.set(t, (byType.get(t) ?? 0) + 1)
      }
      assertEqual(byType.get("reasoning-start"), 1)
      assertEqual(byType.get("reasoning-delta"), 2)
      assertEqual(byType.get("reasoning-end"), 1)
      assertEqual(byType.get("text-start"), 1)
      assertEqual(byType.get("text-delta"), 2)
      assertEqual(byType.get("text-end"), 1)
      assertEqual(byType.get("finish"), 1)
      // Every delta/end id must reference a preceding start id (the AI SDK
      // requirement that failed in production: "reasoning part reasoning-0 not found").
      const started = new Set<string>()
      for (const p of parts) {
        const part = p as { type: string; id?: string }
        if (part.type === "reasoning-start" || part.type === "text-start")
          started.add(part.id as string)
        if (part.type === "reasoning-end" || part.type === "text-end")
          assert(started.has(part.id as string), `${part.type} id ${part.id} has no start`)
      }
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
        inputTokens: { total: 10, noCache: 7, cacheRead: 2, cacheWrite: 1 },
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
    "ccUsageToAiSdkUsage emits cache-inclusive input totals (issue #36)",
    () => {
      // Plan contract: the function reads `totalUsage` from the finish event.
      // AI SDK convention: `total` includes cached tokens; `noCache` is the
      // fresh-only remainder — otherwise downstream context usage renders low.
      const usage = ccUsageToAiSdkUsage({
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 30 },
        },
      })
      assertEqual(usage, {
        inputTokens: { total: 100, noCache: 40, cacheRead: 30, cacheWrite: 30 },
        outputTokens: { total: 50, text: 50, reasoning: 0 },
      })
    },
  ],

  [
    "ccUsageToAiSdkUsage derives noCache when details omit it",
    () => {
      const usage = ccUsageToAiSdkUsage({
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 20 },
        },
      })
      assertEqual(usage, {
        inputTokens: { total: 100, noCache: 50, cacheRead: 30, cacheWrite: 20 },
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

  [
    "createOpenAIStreamParser emits reasoning-start before reasoning-delta and reasoning-end before text or finish",
    () => {
      const parser = createOpenAIStreamParser()
      const chunkId = "gen_01M0Q3F1FQQ0EV6CQZCZ9QFPB8"
      const chunks = [
        { id: chunkId, choices: [{ delta: { reasoning_content: "Thinking step 1" } }] },
        { id: chunkId, choices: [{ delta: { reasoning_content: " and step 2" } }] },
        { id: chunkId, choices: [{ delta: { content: "Final answer" } }] },
        {
          id: chunkId,
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        },
      ]
      const parts = chunks.flatMap((c) => parser(c))
      const types = parts.map((p) => (p as { type: string }).type)
      assertEqual(types, [
        "reasoning-start",
        "reasoning-delta",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-end",
        "finish",
      ])

      const rStart = parts[0] as { type: string; id?: string }
      assertEqual(rStart.id, chunkId)
      const rDelta1 = parts[1] as { type: string; id?: string; delta?: string }
      assertEqual(rDelta1.id, chunkId)
      assertEqual(rDelta1.delta, "Thinking step 1")
      const rDelta2 = parts[2] as { type: string; id?: string; delta?: string }
      assertEqual(rDelta2.id, chunkId)
      assertEqual(rDelta2.delta, " and step 2")
      const rEnd = parts[3] as { type: string; id?: string }
      assertEqual(rEnd.id, chunkId)

      const tStart = parts[4] as { type: string; id?: string }
      assertEqual(tStart.id, chunkId)
      const tDelta = parts[5] as { type: string; id?: string; delta?: string }
      assertEqual(tDelta.id, chunkId)
      assertEqual(tDelta.delta, "Final answer")
      const tEnd = parts[6] as { type: string; id?: string }
      assertEqual(tEnd.id, chunkId)
    },
  ],

  [
    "createOpenAIStreamParser closes reasoning-end on finish when no text is emitted",
    () => {
      const parser = createOpenAIStreamParser()
      const chunkId = "gen_reasoning_only"
      const chunks = [
        { id: chunkId, choices: [{ delta: { reasoning: "Thinking only" } }] },
        {
          id: chunkId,
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ]
      const parts = chunks.flatMap((c) => parser(c))
      const types = parts.map((p) => (p as { type: string }).type)
      assertEqual(types, ["reasoning-start", "reasoning-delta", "reasoning-end", "finish"])
      assertEqual((parts[0] as { id: string }).id, chunkId)
      assertEqual((parts[2] as { id: string }).id, chunkId)
    },
  ],

  [
    "createAnthropicStreamParser handles thinking block lifecycle",
    () => {
      const parser = createAnthropicStreamParser()
      const events = [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Pondering" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]
      const parts = events.flatMap((e) => parser(e))
      const types = parts.map((p) => (p as { type: string }).type)
      assertEqual(types, [
        "reasoning-start",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-end",
        "finish",
      ])
      assertEqual((parts[0] as { id: string }).id, "thinking-0")
      assertEqual((parts[1] as { delta: string }).delta, "Pondering")
      assertEqual((parts[2] as { id: string }).id, "thinking-0")
      assertEqual((parts[3] as { id: string }).id, "text-1")
      assertEqual((parts[4] as { delta: string }).delta, "Answer")
      assertEqual((parts[5] as { id: string }).id, "text-1")
    },
  ],

  [
    "createAnthropicStreamParser closes a thinking block with the id the provider set (issue #72)",
    () => {
      const parser = createAnthropicStreamParser()
      const events = [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", id: "thrk_123", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Pondering" },
        },
        { type: "content_block_stop", index: 0 },
      ]
      const parts = events.flatMap((e) => parser(e))
      const types = parts.map((p) => (p as { type: string }).type)
      assertEqual(types, ["reasoning-start", "reasoning-delta", "reasoning-end"])
      // end id MUST equal the start id, not the index fallback
      assertEqual((parts[0] as { id: string }).id, "thrk_123")
      assertEqual((parts[2] as { id: string }).id, "thrk_123")
    },
  ],

  [
    "createOpenAIStreamParser synthesizes closes before a mid-stream error (issue #72)",
    () => {
      const parser = createOpenAIStreamParser()
      const chunks = [
        { id: "gen", choices: [{ delta: { reasoning: "partial thinking" } }] },
        { id: "gen", choices: [{ delta: { content: "partial answer" } }] },
        { error: { message: "overloaded", type: "server_error" } },
      ]
      const parts = chunks.flatMap((c) => parser(c as any))
      const types = parts.map((p) => (p as { type: string }).type)
      // reasoning and text parts are closed BEFORE the terminal error part —
      // no orphaned open parts in the failed-mid-generation scenario
      assertEqual(types, [
        "reasoning-start",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-end",
        "error",
      ])
      assert((parts[6] as { error: Error }).error instanceof Error)
    },
  ],

  [
    "stateless Anthropic codec completes the thinking lifecycle (issue #71)",
    () => {
      const start = anthropicEventToStreamPart({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", id: "thrk_9", thinking: "" },
      })
      const delta = anthropicEventToStreamPart({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Hmm" },
      })
      const stop = anthropicEventToStreamPart({ type: "content_block_stop", index: 0 }) as any[]
      const types = [
        ...start.map((p) => p.type),
        ...delta.map((p) => p.type),
        ...stop.map((p) => p.type),
      ]
      assert(
        types.includes("reasoning-start") && types.includes("reasoning-delta"),
        "start+delta must map reasoning",
      )
      assert(
        stop.some((p) => p.type === "reasoning-end"),
        "stateless content_block_stop must emit reasoning-end for thinking blocks (issue #71)",
      )
      // Stateless contract: the stop carries only `index` (no block id), so
      // the end id matches the stateless delta's index-derived id — the same
      // id a stateless consumer saw on reasoning-start/delta fallbacks.
      assertEqual((stop.find((p) => p.type === "reasoning-end") as { id: string }).id, "thinking-0")
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
