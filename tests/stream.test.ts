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
  anthropicUsageToAiSdkUsage,
  createOpenAIStreamParser,
  createAnthropicStreamParser,
  finishIsPauseTurn,
  addAiSdkUsage,
  isNetworkFailureFinishReason,
} from "../src/provider/stream.js"
import { assert, assertEqual, rejects, run, throws } from "./harness.js"

/**
 * Every stop reason the wire can send, in both dialects plus the legacy /
 * provider variants, with the unified reason each one means (issue #186). The
 * table is shared by the vocabulary test and the `other`-invariant test below,
 * so a reason added to the wire's vocabulary is exercised by both.
 */
const FINISH_VOCABULARY: Array<[reason: string, unified: string]> = [
  // Anthropic Messages stop_reason
  ["end_turn", "stop"],
  ["stop_sequence", "stop"],
  ["max_tokens", "length"],
  ["tool_use", "tool-calls"],
  ["refusal", "stop"],
  ["model_context_window_exceeded", "length"],
  // OpenAI Chat Completions finish_reason
  ["stop", "stop"],
  ["length", "length"],
  ["tool_calls", "tool-calls"],
  ["content_filter", "stop"],
  ["function_call", "tool-calls"],
  // legacy / provider variants
  ["tool-calls", "tool-calls"],
  ["max-tokens", "length"],
  ["max_output_tokens", "length"],
  ["max_turn_requests", "stop"],
  ["cancelled", "stop"],
  ["error", "error"],
  // mixed casing is the same reason
  ["END_TURN", "stop"],
  ["End_Turn", "stop"],
  ["MAX_TOKENS", "length"],
  ["Tool_Calls", "tool-calls"],
  ["Content_Filter", "stop"],
  ["MoDeL_CoNtExT_WiNdOw_ExCeEdEd", "length"],
  ["Refusal", "stop"],
  ["Pause_Turn", "stop"],
  // anything this build has never seen still ends the turn
  ["banana", "stop"],
]

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
      // An unrecognised reason completes the turn, exactly as upstream's
      // normaliser does — never `other`, which OpenCode v2 fails the turn on
      // (issues #184, #186).
      assertEqual(mapFinishReason("weird"), { unified: "stop", raw: "weird" })
    },
  ],

  [
    "mapFinishReason knows every stop reason the wire can send, in either dialect and case (issue #186)",
    () => {
      // One table, both dialects: the spelling each provider actually emits
      // (Anthropic on the left, OpenAI on the right) plus the legacy/provider
      // variants, matched case-insensitively the way upstream's normaliser
      // (`command-code@1.54.1` `normalizeStopReason2`, which lowercases first)
      // matches. Every entry completes the turn.
      for (const [reason, unified] of FINISH_VOCABULARY) {
        assertEqual(mapFinishReason(reason), { unified, raw: reason }, `reason ${reason}`)
      }
      // The two codecs' own terminals agree with the mapper: the reason each
      // dialect puts on the wire maps the same way (issue #186).
      assertEqual(
        ccEventToStreamPart({
          type: "finish",
          finishReason: "TOOL_CALLS",
          totalUsage: { inputTokens: 10, outputTokens: 4 },
        })[0],
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "TOOL_CALLS" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 4, text: 4, reasoning: 0 },
          },
        },
      )
      const anthropicFinish = createAnthropicStreamParser()({
        type: "message_delta",
        delta: { stop_reason: "refusal" },
        usage: { input_tokens: 10, output_tokens: 4 },
      })[0] as { finishReason: unknown }
      assertEqual(anthropicFinish.finishReason, { unified: "stop", raw: "refusal" })
      const openAIFinish = createOpenAIStreamParser()({
        id: "chatcmpl-1",
        choices: [{ delta: {}, finish_reason: "content_filter" }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })[0] as { finishReason: unknown }
      assertEqual(openAIFinish.finishReason, { unified: "stop", raw: "content_filter" })
      // Absent and non-string reasons complete the turn too, with the `unknown`
      // raw marker this mapper has always used for them.
      assertEqual(mapFinishReason(undefined), { unified: "stop", raw: "unknown" })
      assertEqual(mapFinishReason(7), { unified: "stop", raw: "unknown" })
    },
  ],

  [
    "no codec can end a turn with unified other (issue #186)",
    () => {
      // OpenCode v2 coerces a finish reason of `other` to `unknown` and fails
      // the turn as a retryable incomplete stream (ADR-0013), so no stream this
      // transport can produce may end with one. The invariant is exercised over
      // the whole vocabulary above — mixed casing and all — across the three
      // codecs the transport wires in. A codec that refuses the event outright
      // (the legacy finish guards, issue #187) emitted no turn at all, which is
      // the other way the invariant holds.
      const finishOf = (
        codec: string,
        build: () => Array<Record<string, unknown>>,
      ): Record<string, unknown> | undefined => {
        let parts: Array<Record<string, unknown>>
        try {
          parts = build()
        } catch (error) {
          assert(error instanceof Error, `${codec}: a refused event throws an Error`)
          return undefined
        }
        const finishes = parts.filter((part) => part.type === "finish")
        assert(finishes.length <= 1, `${codec}: at most one finish part`)
        return finishes[0]
      }
      for (const [reason] of FINISH_VOCABULARY) {
        const usage = { inputTokens: 10, outputTokens: 4 }
        const codecs: Array<[string, () => Array<Record<string, unknown>>]> = [
          [
            "legacy",
            () =>
              ccEventToStreamPart({
                type: "finish",
                finishReason: reason,
                totalUsage: usage,
              }) as unknown as Array<Record<string, unknown>>,
          ],
          [
            "openai",
            () =>
              createOpenAIStreamParser()({
                id: "chatcmpl-1",
                choices: [{ delta: {}, finish_reason: reason }],
                usage: { prompt_tokens: 10, completion_tokens: 4 },
              }) as unknown as Array<Record<string, unknown>>,
          ],
          [
            "anthropic",
            () =>
              createAnthropicStreamParser()({
                type: "message_delta",
                delta: { stop_reason: reason },
                usage: { input_tokens: 10, output_tokens: 4 },
              }) as unknown as Array<Record<string, unknown>>,
          ],
        ]
        for (const [codec, build] of codecs) {
          const finish = finishOf(codec, build)
          if (!finish) continue
          const unified = (finish.finishReason as { unified?: string } | undefined)?.unified
          assert(
            unified !== undefined && unified !== "other",
            `${codec} ended "${reason}" with unified ${String(unified)}`,
          )
        }
      }
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
    "anthropicUsageToAiSdkUsage treats input_tokens as cache-exclusive (issue #178)",
    () => {
      // Live /provider/v1/messages (2026-09-16): the cached prefix sits outside
      // `input_tokens`, so the OpenAI-style arithmetic reported `total 13,
      // noCache 0` for a 7155-token prompt — the fresh 13 collapsed into the
      // cache bucket and the turn under-reported. @ai-sdk/anthropic maps
      // `total = input + cacheWrite + cacheRead`, `noCache = input`.
      assertEqual(
        anthropicUsageToAiSdkUsage({
          input_tokens: 13,
          cache_creation_input_tokens: 7142,
          output_tokens: 5,
        })?.inputTokens,
        { total: 7155, noCache: 13, cacheRead: 0, cacheWrite: 7142 },
      )
      assertEqual(
        anthropicUsageToAiSdkUsage({
          input_tokens: 13,
          cache_read_input_tokens: 7142,
          output_tokens: 5,
        })?.inputTokens,
        { total: 7155, noCache: 13, cacheRead: 7142, cacheWrite: 0 },
      )
    },
  ],

  [
    "the same cached prompt maps to the same usage from either provider shape (issues #158, #178)",
    () => {
      // A 7618-token prompt that is 7296-cached. The two providers report it
      // with different arithmetic — OpenAI's prompt_tokens is inclusive,
      // Anthropic's input_tokens is not — and both must land on the same AI SDK
      // usage, which is what the cost path bills.
      const expected = { total: 7618, noCache: 322, cacheRead: 7296, cacheWrite: 0 }
      assertEqual(
        openAIUsageToAiSdkUsage({
          prompt_tokens: 7618,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 7296 },
        })?.inputTokens,
        expected,
      )
      assertEqual(
        anthropicUsageToAiSdkUsage({
          input_tokens: 322,
          cache_read_input_tokens: 7296,
          output_tokens: 8,
        })?.inputTokens,
        expected,
      )
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
    "createOpenAIStreamParser keeps one reasoning block when every chunk carries usage (GLM-5.3)",
    () => {
      // Command Code's GLM-5.3 carries a cumulative usage object on every
      // OpenAI-dialect chunk — its Z.ai upstream reports usage per SSE event.
      // Reading usage alone as the terminal closed and reopened the reasoning
      // part once per token, so the Host stored one part per token and rendered
      // the answer one word per line. Only a finish_reason, or the dialect's
      // usage-only chunk (choices:[]), may end the turn.
      const parser = createOpenAIStreamParser()
      const chunkId = "gen_glm53"
      const usage = (completion: number) => ({
        prompt_tokens: 17,
        completion_tokens: completion,
        total_tokens: 17 + completion,
      })
      const chunks = [
        {
          id: chunkId,
          choices: [{ delta: { role: "assistant" }, finish_reason: null }],
          usage: usage(0),
        },
        {
          id: chunkId,
          choices: [{ delta: { reasoning_content: "The" }, finish_reason: null }],
          usage: usage(1),
        },
        {
          id: chunkId,
          choices: [{ delta: { reasoning_content: " user" }, finish_reason: null }],
          usage: usage(2),
        },
        {
          id: chunkId,
          choices: [{ delta: { reasoning_content: " asked." }, finish_reason: null }],
          usage: usage(3),
        },
        {
          id: chunkId,
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: usage(4),
        },
      ]
      const parts = chunks.flatMap((c) => parser(c))
      assertEqual(
        parts.map((p) => (p as { type: string }).type),
        [
          "reasoning-start",
          "reasoning-delta",
          "reasoning-delta",
          "reasoning-delta",
          "reasoning-end",
          "text-start",
          "text-delta",
          "text-end",
          "finish",
        ],
      )
      // One part lifecycle each: the reasoning block stays open across the
      // per-chunk usage until the content starts, and the text block until the
      // finish_reason chunk.
      const lifecycles = parts.filter((p) =>
        [
          "reasoning-start",
          "reasoning-delta",
          "reasoning-end",
          "text-start",
          "text-delta",
          "text-end",
        ].includes((p as { type: string }).type),
      )
      for (const part of lifecycles) assertEqual((part as { id?: string }).id, chunkId)
      assertEqual(
        parts
          .filter((p) => p.type === "reasoning-delta")
          .map((p) => (p as { delta: string }).delta),
        ["The", " user", " asked."],
      )
      const finish = parts[parts.length - 1] as {
        usage?: { inputTokens: { total: number }; outputTokens: { total: number } }
      }
      assertEqual(finish.usage?.inputTokens.total, 17)
      assertEqual(finish.usage?.outputTokens.total, 4)
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
    "createAnthropicStreamParser carries a thinking block's signature on its reasoning-end (issue #189)",
    () => {
      // Anthropic's `signature_delta` has no part of its own. The signature is
      // what lets a continuation replay the block, so it rides on the part that
      // closes the block — and a block that ends without a stop event (the body
      // died mid-thought) carries it too.
      const events = [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-1" },
        },
        { type: "content_block_stop", index: 0 },
      ]
      const parser = createAnthropicStreamParser()
      const parts = events.flatMap((e) => parser(e))
      assertEqual(
        parts.map((p) => (p as { type: string }).type),
        ["reasoning-start", "reasoning-delta", "reasoning-end"],
      )
      assertEqual((parts[2] as { providerMetadata?: unknown }).providerMetadata, {
        anthropic: { signature: "sig-1" },
      })

      const open = createAnthropicStreamParser()
      open({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      })
      open({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-2" },
      })
      assertEqual(open.closeStream(), [
        {
          type: "reasoning-end",
          id: "thinking-0",
          providerMetadata: { anthropic: { signature: "sig-2" } },
        },
      ])

      // A signature for a block this parser does not model is ignored, like the
      // block itself; an unsigned thinking block keeps the plain end part.
      const unmodelled = createAnthropicStreamParser()
      unmodelled({
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "..." },
      })
      assertEqual(
        unmodelled({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-3" },
        }),
        [],
      )
      const unsigned = createAnthropicStreamParser()
      unsigned({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })
      assertEqual(unsigned({ type: "content_block_stop", index: 0 }), [
        { type: "reasoning-end", id: "thinking-0" },
      ])
    },
  ],

  [
    "createAnthropicStreamParser never closes a block it did not open (issue #72)",
    () => {
      // A block type this parser does not model — a server tool block, a future
      // addition — is still a block. Its stop must not fall through to
      // `text-end` for a part that was never opened: the consumer rejects an end
      // for an unknown id ("text part text-N not found", #69).
      const parser = createAnthropicStreamParser()
      assertEqual(
        parser({
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "srv_1", name: "web_search" },
        }),
        [],
      )
      assertEqual(parser({ type: "content_block_stop", index: 0 }), [])
      // A stop whose start never arrived is the same shape of nothing-to-close.
      assertEqual(createAnthropicStreamParser()({ type: "content_block_stop", index: 3 }), [])
    },
  ],

  [
    "createAnthropicStreamParser reports the block types it does not model (issue #192)",
    () => {
      // The block emits no part (#72), which is invisible for a turn that ends
      // and a lie for a paused turn whose continuation is rebuilt from those
      // parts — so the parser names what it dropped and the transport decides.
      const parser = createAnthropicStreamParser()
      assertEqual(parser.unmodelledBlocks?.(), [])
      parser({
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srv_1", name: "web_search" },
      })
      parser({ type: "content_block_stop", index: 0 })
      // Modelled blocks are not reported.
      parser({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })
      parser({ type: "content_block_stop", index: 1 })
      parser({ type: "content_block_start", index: 2, content_block: {} })
      // The same type twice is one entry; a block whose start carried no type
      // is still reported, as `untyped`.
      parser({
        type: "content_block_start",
        index: 3,
        content_block: { type: "server_tool_use", id: "srv_2", name: "web_search" },
      })
      parser({ type: "content_block_stop", index: 3 })
      assertEqual(parser.unmodelledBlocks?.(), ["server_tool_use", "untyped"])

      // The OpenAI-shaped parser has no content blocks at all: it reports none.
      assertEqual(createOpenAIStreamParser().unmodelledBlocks, undefined)
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
    "createAnthropicStreamParser drops the bare message_stop once message_delta finished the stream (issue #174)",
    () => {
      // The live Provider API stream closes in the mirror image of OpenAI's:
      // usage (and the real stop_reason) arrive on `message_delta`, then a bare
      // `message_stop` follows. Mapping that terminal too yields a second,
      // zeroed finish that the transport's last-wins hold prefers — the whole
      // turn's usage and reason lost.
      const parser = createAnthropicStreamParser()
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 20, output_tokens: 8 },
        },
        { type: "message_stop" },
      ]
      const parts = events.flatMap((e) => parser(e))
      assertEqual(
        parts.map((p) => (p as { type: string }).type),
        ["text-start", "text-delta", "text-end", "finish"],
      )
      assertEqual(parts[3], {
        type: "finish",
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 8, text: 8, reasoning: 0 },
        },
      })

      // The terminal stays the fallback finish for a stream that never sent
      // `message_delta` — the only finish such a stream gets.
      assertEqual(createAnthropicStreamParser()({ type: "message_stop" }), [
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        },
      ])
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

      // Tool and still-unmodelled blocks have no close part: a tool call is
      // settled by its own tool-call part, never by a bare end.
      const unmodelled = createAnthropicStreamParser()
      unmodelled({
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srv_1", name: "web_search" },
      })
      unmodelled({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_1", name: "read" },
      })
      assertEqual(unmodelled.closeStream(), [])

      // A redacted thinking block *is* modelled: it opens a reasoning part, so
      // a stream that ends mid-block closes it (issue #193).
      const redacted = createAnthropicStreamParser()
      redacted({
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "..." },
      })
      assertEqual(redacted.closeStream(), [{ type: "reasoning-end", id: "redacted-0" }])
    },
  ],

  [
    "createAnthropicStreamParser streams a redacted thinking block as reasoning (issue #193)",
    () => {
      // The block is encrypted reasoning: no deltas, the whole block is its
      // `data`, and it surfaces as a reasoning part whose start carries that
      // payload in `providerMetadata.anthropic.redactedData` — the shape the AI
      // SDK's own Anthropic provider emits, and the one a continuation reads to
      // replay the block verbatim.
      const parser = createAnthropicStreamParser()
      assertEqual(
        parser({
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking", data: "EncryptedThought==" },
        }),
        [
          {
            type: "reasoning-start",
            id: "redacted-0",
            providerMetadata: { anthropic: { redactedData: "EncryptedThought==" } },
          },
        ],
      )
      assertEqual(parser({ type: "content_block_stop", index: 0 }), [
        { type: "reasoning-end", id: "redacted-0" },
      ])
      // It is modelled, so the #192 safety net has nothing to refuse.
      assertEqual(parser.unmodelledBlocks?.(), [])

      // An id the gateway supplies is the one the end closes, like every block.
      const labelled = createAnthropicStreamParser()
      assertEqual(
        (
          labelled({
            type: "content_block_start",
            index: 0,
            content_block: { type: "redacted_thinking", id: "red_7", data: "x" },
          })[0] as { id: string }
        ).id,
        "red_7",
      )
      assertEqual(labelled({ type: "content_block_stop", index: 0 }), [
        { type: "reasoning-end", id: "red_7" },
      ])

      // A redacted block with no payload has nothing to replay, so it stays
      // unmodelled: no part, and a pause that carried it is refused (#192)
      // rather than handing the provider an empty block.
      const payloadless = createAnthropicStreamParser()
      assertEqual(
        payloadless({
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking" },
        }),
        [],
      )
      assertEqual(payloadless({ type: "content_block_stop", index: 0 }), [])
      assertEqual(payloadless.unmodelledBlocks?.(), ["redacted_thinking"])
    },
  ],

  [
    "the codecs preserve the pause_turn finish reason the transport loops on (issue #172)",
    () => {
      // `pause_turn` is a stop reason, not an ending: upstream's vocabulary
      // does not know it, so it maps to a completed turn like every other
      // reason and the raw reason is what the transport reads (issue #186
      // narrowed the unified mapping; issue #172 owns the loop). Upstream's
      // legacy consumer reads the terminal's two reason fields apart — the raw
      // one off `rawFinishReason ?? finishReason` — so a finish event that
      // reports the pause only in its raw field is a pause too, with the
      // unified reason still taken from `finishReason`.
      assertEqual(mapFinishReason("pause_turn"), { unified: "stop", raw: "pause_turn" })
      assertEqual(
        ccEventToStreamPart({
          type: "finish",
          finishReason: "end_turn",
          rawFinishReason: "pause_turn",
          totalUsage: { inputTokens: 10, outputTokens: 4 },
        }),
        [
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "pause_turn" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 4, text: 4, reasoning: 0 },
            },
          },
        ],
      )
      // With no raw field the finish maps exactly as it always did.
      assertEqual(
        ccEventToStreamPart({
          type: "finish",
          finishReason: "pause_turn",
          totalUsage: { inputTokens: 10, outputTokens: 4 },
        })[0],
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "pause_turn" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 4, text: 4, reasoning: 0 },
          },
        },
      )
      // The transport asks the codec's vocabulary rather than matching the raw
      // string at the call site: a paused finish is one thing, an ordinary one
      // is not.
      assertEqual(finishIsPauseTurn({ finishReason: { unified: "stop", raw: "pause_turn" } }), true)
      assertEqual(finishIsPauseTurn({ finishReason: { unified: "stop", raw: "unknown" } }), false)
      assertEqual(finishIsPauseTurn({ finishReason: { unified: "stop", raw: "end_turn" } }), false)
    },
  ],

  [
    "addAiSdkUsage sums every bucket a resumed turn's continuations report (issue #172)",
    () => {
      // Upstream folds a paused turn's continuations with `addUsage2`, the only
      // place the CLI sums usage: the transport emits one finish for the whole
      // turn, so its usage is the sum of the responses that made it up.
      assertEqual(
        addAiSdkUsage(
          {
            inputTokens: { total: 10, noCache: 6, cacheRead: 3, cacheWrite: 1 },
            outputTokens: { total: 4, text: 4, reasoning: 0 },
          },
          {
            inputTokens: { total: 20, noCache: 18, cacheRead: 2, cacheWrite: 0 },
            outputTokens: { total: 5, text: 0, reasoning: 5 },
          },
        ),
        {
          inputTokens: { total: 30, noCache: 24, cacheRead: 5, cacheWrite: 1 },
          outputTokens: { total: 9, text: 4, reasoning: 5 },
        },
      )
      // An absent bucket is zero, never NaN: a codec that reports no cache
      // detail still adds cleanly to one that does.
      assertEqual(
        addAiSdkUsage(
          {
            inputTokens: { total: undefined, noCache: undefined, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: undefined, reasoning: undefined },
          },
          {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 3, text: 3, reasoning: 0 },
          },
        ),
        {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 3, reasoning: 0 },
        },
      )
    },
  ],

  [
    "the legacy finish guards refuse a turn that never ended (issue #187)",
    () => {
      // A finish reporting `other` with no raw reason is upstream's own
      // truncation condition (`stopReason === "other" && rawFinishReason ===
      // undefined`), so it must not become a completed turn — and it is
      // classified, not merely refused: the failure rides on the error for the
      // ladder.
      const truncated = (() => {
        try {
          ccEventToStreamPart({
            type: "finish",
            finishReason: "other",
            totalUsage: { inputTokens: 10, outputTokens: 4 },
          })
        } catch (error) {
          return error as Error & {
            failure?: { kind?: string; retryable?: boolean }
            status?: number
          }
        }
        return undefined
      })()
      assert(truncated, "other with no raw reason throws")
      assert(truncated.message.includes("truncated"), truncated.message)
      assertEqual(truncated.failure, { kind: "truncation", retryable: true, status: 502 })
      assertEqual(truncated.status, 502)
      assertEqual((truncated as { transportError?: boolean }).transportError, true)

      // `other` **with** a raw reason is an ending: the wire told us why.
      const ended = ccEventToStreamPart({
        type: "finish",
        finishReason: "other",
        rawFinishReason: "somewhere-else",
        totalUsage: { inputTokens: 10, outputTokens: 4 },
      })[0] as { finishReason: unknown }
      assertEqual(ended.finishReason, { unified: "stop", raw: "somewhere-else" })

      // The connection-failure spellings upstream's regex accepts.
      for (const reason of [
        "network_error",
        "connection-error",
        "upstream error",
        "UPSTREAM_ERROR",
        "Network_Error",
      ]) {
        assert(isNetworkFailureFinishReason(reason), `${reason} is a connection failure`)
        throws(
          () =>
            ccEventToStreamPart({
              type: "finish",
              finishReason: reason,
              totalUsage: { inputTokens: 10, outputTokens: 4 },
            }),
          /upstream connection failed mid-stream/,
        )
      }
      // …and the ones it must not (a different separator, a suffix, an
      // unrelated failure).
      for (const reason of ["network", "upstream_error_2", "networking_error", "error"]) {
        assert(!isNetworkFailureFinishReason(reason), `${reason} is not a connection failure`)
      }
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
