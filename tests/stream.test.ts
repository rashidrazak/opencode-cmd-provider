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
  openAIUsageToAiSdkUsage,
  createOpenAIStreamParser,
  createAnthropicStreamParser,
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
    "openAIUsageToAiSdkUsage reads prompt_tokens_details.cached_tokens (issue #158)",
    () => {
      // OpenAI-shape usage nests the cached prefix; the top-level prompt count
      // stays cache-inclusive, so `noCache` is the fresh remainder and the
      // cost path bills 50000 at the cache-read rate instead of fresh input.
      const usage = openAIUsageToAiSdkUsage({
        usage: {
          prompt_tokens: 52000,
          completion_tokens: 300,
          total_tokens: 52300,
          prompt_tokens_details: { cached_tokens: 50000 },
        },
      })
      assertEqual(usage, {
        inputTokens: { total: 52000, noCache: 2000, cacheRead: 50000, cacheWrite: 0 },
        outputTokens: { total: 300, text: 300, reasoning: 0 },
      })
    },
  ],

  [
    "openAIUsageToAiSdkUsage reads top-level cache aliases",
    () => {
      // DeepSeek reports prompt_cache_hit_tokens; the generic alias is camelCase.
      const deepseek = openAIUsageToAiSdkUsage({
        prompt_tokens: 1000,
        completion_tokens: 10,
        prompt_cache_hit_tokens: 900,
      })
      assertEqual(deepseek?.inputTokens, {
        total: 1000,
        noCache: 100,
        cacheRead: 900,
        cacheWrite: 0,
      })

      const generic = openAIUsageToAiSdkUsage({
        promptTokens: 1000,
        completionTokens: 10,
        cacheReadTokens: 900,
      })
      assertEqual(generic?.inputTokens, {
        total: 1000,
        noCache: 100,
        cacheRead: 900,
        cacheWrite: 0,
      })
    },
  ],

  [
    "openAIUsageToAiSdkUsage keeps explicit cache fields ahead of nested details",
    () => {
      const usage = openAIUsageToAiSdkUsage({
        prompt_tokens: 1000,
        completion_tokens: 10,
        cacheReadTokens: 700,
        prompt_tokens_details: { cached_tokens: 900 },
      })
      assertEqual(usage?.inputTokens, {
        total: 1000,
        noCache: 300,
        cacheRead: 700,
        cacheWrite: 0,
      })
    },
  ],

  [
    "createOpenAIStreamParser reports nested cache reads on the finish part",
    () => {
      const parser = createOpenAIStreamParser()
      const chunks = [
        { id: "gen_cache", choices: [{ delta: { content: "hi" } }] },
        {
          id: "gen_cache",
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 52000,
            completion_tokens: 300,
            total_tokens: 52300,
            prompt_tokens_details: { cached_tokens: 50000 },
          },
        },
      ]
      const parts = chunks.flatMap((c) => parser(c))
      const finish = parts[parts.length - 1] as { type: string; usage?: unknown }
      assertEqual(finish.type, "finish")
      assertEqual(finish.usage, {
        inputTokens: { total: 52000, noCache: 2000, cacheRead: 50000, cacheWrite: 0 },
        outputTokens: { total: 300, text: 300, reasoning: 0 },
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
    "createAnthropicStreamParser closes a labelled thinking block with its own id",
    () => {
      // Anthropic puts no `id` on thinking blocks, but a gateway may. When it
      // does, the id chosen at `content_block_start` has to be the one the delta
      // and stop events use: re-deriving it from the block index would open part
      // `th_9` and then feed `thinking-0`, orphaning the part the consumer saw
      // opened — the #69 failure mode (issue #71).
      const parser = createAnthropicStreamParser()
      const events = [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", id: "th_9", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Pondering" },
        },
        { type: "content_block_stop", index: 0 },
      ]
      const parts = events.flatMap((e) => parser(e))
      assertEqual(
        parts.map((p) => (p as { type: string }).type),
        ["reasoning-start", "reasoning-delta", "reasoning-end"],
      )
      assertEqual(
        parts.map((p) => (p as { id: string }).id),
        ["th_9", "th_9", "th_9"],
      )
    },
  ],

  [
    "createAnthropicStreamParser never closes a block it did not open (issue #72)",
    () => {
      // A block type this parser does not model — Anthropic's redacted_thinking,
      // a server tool block, a future addition — is still a block. Its stop must
      // not fall through to `text-end` for a part that was never opened: the
      // consumer rejects an end for an unknown id ("text part text-N not found",
      // #69).
      const parser = createAnthropicStreamParser()
      assertEqual(
        parser({
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking", data: "..." },
        }),
        [],
      )
      assertEqual(parser({ type: "content_block_stop", index: 0 }), [])
      // A stop whose start never arrived is the same shape of nothing-to-close.
      assertEqual(createAnthropicStreamParser()({ type: "content_block_stop", index: 3 }), [])
    },
  ],

  [
    "createAnthropicStreamParser opens the part a stranded delta implies (issue #72)",
    () => {
      // The start event can be lost (unparseable SSE line, a reconnect). The
      // delta's own kind says which part it belongs to, so open it rather than
      // feed the consumer a delta for an id it never saw start.
      const parser = createAnthropicStreamParser()
      assertEqual(
        parser({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        }),
        [
          { type: "text-start", id: "text-0" },
          { type: "text-delta", id: "text-0", delta: "hi" },
        ],
      )
      assertEqual(parser({ type: "content_block_stop", index: 0 }), [
        { type: "text-end", id: "text-0" },
      ])
      assertEqual(
        parser({
          type: "content_block_delta",
          index: 1,
          delta: { type: "thinking_delta", thinking: "hmm" },
        }),
        [
          { type: "reasoning-start", id: "thinking-1" },
          { type: "reasoning-delta", id: "thinking-1", delta: "hmm" },
        ],
      )
      assertEqual(parser({ type: "content_block_stop", index: 1 }), [
        { type: "reasoning-end", id: "thinking-1" },
      ])
      // A tool-argument fragment with no tool block carries neither an id nor a
      // name, so there is no call to open: drop it rather than emit an orphan
      // tool-input-delta the consumer cannot match.
      assertEqual(
        createAnthropicStreamParser()({
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"a":' },
        }),
        [],
      )
    },
  ],

  [
    "createOpenAIStreamParser buffers tool arguments until the call is named (issue #72)",
    () => {
      const parser = createOpenAIStreamParser()
      // A gateway may stream `arguments` before `function.name`. The consumer
      // rejects a tool-input-delta for a call it never saw started, so the
      // fragment waits here and is flushed once the name opens the part.
      assertEqual(
        parser({
          id: "gen_tool",
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "call_9", function: { arguments: '{"a":' } }] },
            },
          ],
        }),
        [],
      )
      assertEqual(
        parser({
          id: "gen_tool",
          choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "do_thing" } }] } }],
        }),
        [
          { type: "tool-input-start", id: "call_9", toolName: "do_thing" },
          { type: "tool-input-delta", id: "call_9", delta: '{"a":' },
        ],
      )
      assertEqual(
        parser({
          id: "gen_tool",
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
        }),
        [
          { type: "tool-input-delta", id: "call_9", delta: "1}" },
          { type: "tool-input-end", id: "call_9" },
          { type: "tool-call", toolCallId: "call_9", toolName: "do_thing", input: '{"a":1}' },
        ],
      )
      // A call whose name never arrives stays unopened: the finish flush must
      // not close it with an end/call pair the consumer never saw start.
      const stranded = createOpenAIStreamParser()
      stranded({
        id: "gen_stranded",
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_x", function: { arguments: "{}" } }] } },
        ],
      })
      const flushed = stranded({
        id: "gen_stranded",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
      assertEqual(
        flushed.filter((p) => p.type !== "finish"),
        [],
      )
    },
  ],

  [
    "stream parsers close their open parts on demand (issue #72)",
    () => {
      // The transport closes a stream on error/abort without ever seeing a
      // finish event, so the parsers expose the closers directly: an open
      // reasoning/text part must not outlive the stream that opened it.
      const openai = createOpenAIStreamParser()
      assertEqual(
        openai({ id: "gen_a", choices: [{ delta: { reasoning_content: "t" } }] }).length,
        2,
      )
      assertEqual(openai.closeStream(), [{ type: "reasoning-end", id: "gen_a" }])
      assertEqual(openai.closeStream(), [])

      const openaiText = createOpenAIStreamParser()
      openaiText({ id: "gen_b", choices: [{ delta: { content: "hi" } }] })
      assertEqual(openaiText.closeStream(), [{ type: "text-end", id: "gen_b" }])

      const anthropic = createAnthropicStreamParser()
      anthropic({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      })
      anthropic({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "..." },
      })
      anthropic({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      })
      assertEqual(anthropic.closeStream(), [
        { type: "reasoning-end", id: "thinking-0" },
        { type: "text-end", id: "text-1" },
      ])
      assertEqual(anthropic.closeStream(), [])

      // Unmodelled (redacted) and tool blocks have no close part: a tool call is
      // settled by its own tool-call part, never by a bare end.
      const unmodelled = createAnthropicStreamParser()
      unmodelled({
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking" },
      })
      unmodelled({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_1", name: "read" },
      })
      assertEqual(unmodelled.closeStream(), [])
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
