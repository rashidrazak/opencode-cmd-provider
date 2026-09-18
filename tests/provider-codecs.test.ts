// tests/provider-codecs.test.ts — Provider API codecs (issue #52)
// OpenAI Chat Completions + Anthropic Messages request/stream shapes
import {
  messagesToOpenAI,
  messagesToAnthropic,
  openAITools,
  anthropicTools,
  toolsToJson,
  systemPromptToText,
} from "../src/provider/converters.js"
import {
  openAIEventToStreamPart,
  anthropicEventToStreamPart,
  createAnthropicStreamParser,
  parseStreamEventLine,
  openAIUsageToAiSdkUsage,
  anthropicUsageToAiSdkUsage,
} from "../src/provider/stream.js"
import { assert, assertEqual, run } from "./harness.js"

run([
  [
    "OpenAI: prompt → Chat Completions body has stream:true and messages",
    () => {
      const prompt = [
        { role: "system", content: "you are helpful" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ] as any
      const body = messagesToOpenAI(prompt, { model: "gpt-5.6-terra" }) as any
      assertEqual(body.model, "gpt-5.6-terra")
      assertEqual(body.stream, true)
      assert(Array.isArray(body.messages), "messages array")
      assert(
        body.messages.some((m: any) => m.role === "system"),
        "system message",
      )
      assertEqual(body.max_tokens, 64000)
      assertEqual(body.stream_options, { include_usage: true })
    },
  ],
  [
    "Anthropic: prompt → Messages body has stream:true and one cached system block",
    () => {
      const prompt = [
        { role: "system", content: "you are helpful" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ] as any
      const body = messagesToAnthropic(prompt, { model: "claude-sonnet-5" }) as any
      assertEqual(body.model, "claude-sonnet-5")
      assertEqual(body.stream, true)
      // The system prefix is a content block carrying one ephemeral cache
      // breakpoint: without it every turn re-bills the whole prefix as fresh
      // input (issue #177).
      assertEqual(body.system, [
        { type: "text", text: "you are helpful", cache_control: { type: "ephemeral" } },
      ])
      assert(Array.isArray(body.messages), "messages array")
      assert(!body.messages.some((m: any) => m.role === "system"), "no system in messages")

      // No system prompt at all → no `system` field, not an empty block array.
      const withoutSystem = messagesToAnthropic(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }] as any,
        { model: "claude-sonnet-5" },
      ) as any
      assert(!("system" in withoutSystem), "no system field without a system prompt")
    },
  ],
  [
    "OpenAI: max_tokens is capped at 64000",
    () => {
      const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as any
      assertEqual(
        (messagesToOpenAI(prompt, { model: "gpt-5.6-terra", maxOutputTokens: 1000 }) as any)
          .max_tokens,
        1000,
      )
      assertEqual(
        (messagesToOpenAI(prompt, { model: "gpt-5.6-terra", maxOutputTokens: 100000 }) as any)
          .max_tokens,
        64000,
      )
      assertEqual(
        (messagesToAnthropic(prompt, { model: "claude-sonnet-5", maxOutputTokens: 500 }) as any)
          .max_tokens,
        500,
      )
    },
  ],
  [
    "temperature is forwarded only when the caller sets one (issue #173)",
    () => {
      const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as any
      const oa = (opts: Record<string, unknown>) =>
        messagesToOpenAI(prompt, { model: "gpt-5.6-terra", ...opts }) as any
      const ant = (opts: Record<string, unknown>) =>
        messagesToAnthropic(prompt, { model: "claude-sonnet-5", ...opts }) as any
      assertEqual(oa({ temperature: 0.7 }).temperature, 0.7)
      assertEqual(ant({ temperature: 0.7 }).temperature, 0.7)
      // 0 is a value, not an absent one.
      assertEqual(oa({ temperature: 0 }).temperature, 0)
      assertEqual(ant({ temperature: 0 }).temperature, 0)
      // Unset means absent: no invented default on the Provider API bodies,
      // where Anthropic rejects a temperature alongside extended thinking.
      assert(!("temperature" in oa({})), "no temperature field when unset (OpenAI)")
      assert(!("temperature" in ant({})), "no temperature field when unset (Anthropic)")
    },
  ],
  [
    "tool calling remains byte-equivalent via toJsonSchema",
    () => {
      const tools = {
        read: {
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      }
      const cc = toolsToJson(tools as any) as any[]
      const oa = openAITools(tools as any) as any[]
      const ant = anthropicTools(tools as any) as any[]
      assertEqual(
        JSON.stringify((cc[0] as any).input_schema),
        JSON.stringify((oa[0] as any).function.parameters),
      )
      assertEqual(
        JSON.stringify((cc[0] as any).input_schema),
        JSON.stringify((ant[0] as any).input_schema),
      )
    },
  ],
  [
    "system prompt flows through both codecs",
    () => {
      const prompt = [
        { role: "system", content: "sys A" },
        { role: "system", content: "sys B" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ] as any
      const oa = messagesToOpenAI(prompt, { model: "gpt-5.6-terra" }) as any
      const sys = oa.messages.find((m: any) => m.role === "system")
      assert(
        sys.content.includes("sys A") && sys.content.includes("sys B"),
        "openAI system flattened",
      )
      const ant = messagesToAnthropic(prompt, { model: "claude-sonnet-5" }) as any
      const antSystem = ant.system.map((block: any) => block.text).join("\n")
      assert(antSystem.includes("sys A") && antSystem.includes("sys B"), "anthropic system")
    },
  ],
  [
    "images flow through when allowed and throw when not",
    () => {
      const prompt = [
        { role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png" }] },
      ] as any
      let threw = false
      try {
        messagesToOpenAI(prompt, { model: "gpt-5.6-terra", allowImages: false })
      } catch (e: any) {
        threw = /does not support image/.test(e.message)
      }
      assert(threw, "openAI throws without allowImages")
      threw = false
      try {
        messagesToAnthropic(prompt, { model: "claude-sonnet-5", allowImages: false })
      } catch (e: any) {
        threw = /does not support image/.test(e.message)
      }
      assert(threw, "anthropic throws without allowImages")

      const oa = messagesToOpenAI(prompt, { model: "gpt-5.6-terra", allowImages: true }) as any
      const oaImg = (oa.messages.find((m: any) => m.role === "user") as any).content.find(
        (c: any) => c.type === "image_url",
      )
      assert(
        oaImg && oaImg.image_url.url.includes("data:image/png;base64,aGVsbG8="),
        "openAI image_url",
      )

      const ant = messagesToAnthropic(prompt, {
        model: "claude-sonnet-5",
        allowImages: true,
      }) as any
      const antImg = (ant.messages.find((m: any) => m.role === "user") as any).content.find(
        (c: any) => c.type === "image",
      )
      assertEqual(antImg.source.type, "base64")
      assertEqual(antImg.source.data, "aGVsbG8=")
    },
  ],
  [
    "non-image file parts are rejected on both Provider codecs",
    () => {
      // A `file` part with a non-image media type must NOT be silently encoded
      // as an image (Provider API is text + images only; audio/file/document
      // are rejected by the upstream schema).
      const prompt = [
        { role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "audio/mp3" }] },
      ] as any

      let threw = false
      try {
        messagesToOpenAI(prompt, { model: "gpt-5.6-terra", allowImages: true })
      } catch (e: any) {
        threw = /non-image|file|audio/i.test(e.message)
      }
      assert(threw, "openAI rejects a non-image file part")

      threw = false
      try {
        messagesToAnthropic(prompt, { model: "claude-sonnet-5", allowImages: true })
      } catch (e: any) {
        threw = /non-image|file|audio/i.test(e.message)
      }
      assert(threw, "anthropic rejects a non-image file part")

      // A `file` part with no media type at all cannot be verified as an image — reject it too.
      const noMime = [{ role: "user", content: [{ type: "file", data: "aGVsbG8=" }] }] as any
      threw = false
      try {
        messagesToOpenAI(noMime, { model: "gpt-5.6-terra", allowImages: true })
      } catch (e: any) {
        threw = /non-image|file/.test(e.message)
      }
      assert(threw, "openAI rejects a file part with no media type")

      // An image/* file part still forwards correctly (unchanged).
      const img = [
        { role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png" }] },
      ] as any
      const oa = messagesToOpenAI(img, { model: "gpt-5.6-terra", allowImages: true }) as any
      const oaImg = (oa.messages.find((m: any) => m.role === "user") as any).content.find(
        (c: any) => c.type === "image_url",
      )
      assert(
        oaImg && oaImg.image_url.url.includes("data:image/png;base64,aGVsbG8="),
        "image/* file still forwarded as image_url",
      )
    },
  ],
  [
    "tool call + result pairs flow through both codecs",
    () => {
      const prompt = [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "tc1", toolName: "read", result: "ok" }],
        },
      ] as any
      const oa = messagesToOpenAI(prompt, { model: "gpt-5.6-terra" }) as any
      assert(
        oa.messages.some((m: any) => m.tool_calls),
        "openAI tool_calls",
      )
      assert(
        oa.messages.some((m: any) => m.role === "tool"),
        "openAI tool result",
      )

      const ant = messagesToAnthropic(prompt, { model: "claude-sonnet-5" }) as any
      assert(
        ant.messages.some(
          (m: any) => m.role === "assistant" && m.content.some((c: any) => c.type === "tool_use"),
        ),
      )
      assert(ant.messages.some((m: any) => m.content.some((c: any) => c.type === "tool_result")))
    },
  ],
  [
    "reasoning-effort mapping flows through codecs",
    () => {
      const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as any
      const oa = messagesToOpenAI(prompt, {
        model: "claude-sonnet-5",
        providerOptions: { commandcode: { reasoningEffort: "high" } },
      }) as any
      assertEqual(oa.reasoning_effort, "high")
      const oaOff = messagesToOpenAI(prompt, {
        model: "claude-sonnet-5",
        providerOptions: { commandcode: { reasoningEffort: "off" } },
      }) as any
      assert(!("reasoning_effort" in oaOff), "off not emitted")

      const ant = messagesToAnthropic(prompt, {
        model: "gpt-5.6-terra",
        providerOptions: { reasoning: "low" },
      }) as any
      assertEqual(ant.reasoning_effort, "low")
    },
  ],
  [
    "OpenAI: assistant reasoning replays as reasoning_content for reasoning models",
    () => {
      // DeepSeek V4.x requires the full prior reasoning_content on tool-use
      // continuations (HTTP 400 without it); GLM-5.3 and Qwen3.8 preserve
      // thinking for accuracy and cache hits. The reasoning is read back from
      // the same parts the stream parser emits for these models.
      const prompt = [
        { role: "user", content: [{ type: "text", text: "read the file" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I should call read first" },
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "tc1", toolName: "read", result: "ok" }],
        },
      ] as any
      const body = messagesToOpenAI(prompt, { model: "deepseek/deepseek-v4.1-flash" }) as any
      const assistant = body.messages.find((m: any) => m.role === "assistant")
      assert(assistant, "assistant message kept")
      assertEqual(assistant.reasoning_content, "I should call read first")
      assertEqual(assistant.content, null)
      assert(Array.isArray(assistant.tool_calls), "tool calls kept")

      // A reasoning model with no reasoning in history sends no new field.
      const plain = messagesToOpenAI(
        [{ role: "assistant", content: [{ type: "text", text: "hello" }] }] as any,
        { model: "deepseek/deepseek-v4.1-flash" },
      ) as any
      const plainAssistant = plain.messages.find((m: any) => m.role === "assistant")
      assert(!("reasoning_content" in plainAssistant), "no reasoning_content without reasoning")
      assertEqual(plainAssistant.content, "hello")
    },
  ],
  [
    "OpenAI: non-reasoning models keep history unchanged (no reasoning_content)",
    () => {
      const prompt = [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "leftover thought" },
            { type: "text", text: "answer" },
          ],
        },
      ] as any
      const body = messagesToOpenAI(prompt, { model: "moonshotai/Kimi-K2.5" }) as any
      const assistant = body.messages.find((m: any) => m.role === "assistant")
      assert(!("reasoning_content" in assistant), "no reasoning_content for non-reasoning model")
      assertEqual(assistant.content, "answer")
    },
  ],
  [
    "Anthropic: completed-turn reasoning is still not replayed as history",
    () => {
      // The Anthropic dialect needs a provider signature on a replayed thinking
      // block; history parts carry none, so the turn text and tool calls go
      // back without a thinking block (only the pause-resume path replays one,
      // with the streamed signature).
      const prompt = [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "hmm" },
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: {} },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "tc1", toolName: "read", result: "ok" }],
        },
      ] as any
      const body = messagesToAnthropic(prompt, { model: "claude-sonnet-5" }) as any
      const assistant = body.messages.find((m: any) => m.role === "assistant")
      assert(
        assistant.content.every((c: any) => c.type !== "thinking"),
        "no thinking block in history",
      )
    },
  ],
  [
    "OpenAI streaming: text-delta and terminal usage → finish",
    () => {
      const c1 = {
        id: "chatcmpl-1",
        choices: [{ delta: { content: "Hello" }, finish_reason: null }],
      }
      const p1 = openAIEventToStreamPart(c1)
      assertEqual((p1[0] as any).type, "text-delta")
      assertEqual((p1[0] as any).delta, "Hello")

      const fin = {
        id: "chatcmpl-1",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
      const pf = openAIEventToStreamPart(fin)
      const f = pf.find((p: any) => p.type === "finish") as any
      assert(f, "finish")
      assertEqual(f.usage.inputTokens.total, 10)
      assertEqual(f.usage.outputTokens.total, 5)
    },
  ],
  [
    "Anthropic streaming: message_delta → finish with same shape as OpenAI",
    () => {
      // Content blocks belong to the stateful parser (issue #71); the stateless
      // mapper maps only events that are complete in one message, of which the
      // terminal `message_delta` below is the one carrying usage.
      const parser = createAnthropicStreamParser()
      const start = parser({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      }) as any[]
      assertEqual(start[0].type, "text-start")
      const p = parser({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      })
      assertEqual((p[0] as any).delta, "Hi")

      const fin = {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      const pf = anthropicEventToStreamPart(fin) as any[]
      const f = pf.find((p: any) => p.type === "finish") as any
      assertEqual(f.usage.inputTokens.total, 10)
      assertEqual(f.usage.outputTokens.total, 5)

      const oaFin = openAIEventToStreamPart({
        choices: [{ finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }).find((p: any) => p.type === "finish") as any
      assertEqual(JSON.stringify(f.usage), JSON.stringify(oaFin.usage))
      assertEqual(f.finishReason.unified, oaFin.finishReason.unified)
    },
  ],
  [
    "stateless Anthropic codec leaves content blocks to the stateful parser",
    () => {
      // `content_block_stop` names only the block index, so a per-event mapper
      // cannot choose between text-end, reasoning-end and tool-input-end — and
      // cannot complete a tool call whose `input_json_delta` fragments span
      // events. #71 removed the half-lifecycle this mapper used to emit (starts
      // and deltas with no matching end, plus a dead second delta branch); this
      // pins the seam so re-adding it is a deliberate act.
      const contentEvents = [
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", id: "th_1" } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t_1" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Hmm" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"a":1}' },
        },
        { type: "content_block_stop", index: 0 },
      ]
      for (const event of contentEvents) {
        assertEqual(anthropicEventToStreamPart(event).length, 0)
      }

      // The events it does own still map: terminal finish and the error throw.
      const finish = anthropicEventToStreamPart({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as any[]
      assertEqual(finish[0].type, "finish")
      assertEqual(finish[0].finishReason.unified, "tool-calls")
    },
  ],
  [
    "malformed SSE lines are ignored or throw redacted errors",
    () => {
      assertEqual(parseStreamEventLine("data: {nope"), undefined)
      assertEqual(parseStreamEventLine(""), undefined)
      assertEqual(openAIEventToStreamPart({} as any).length, 0)
      assertEqual(anthropicEventToStreamPart({ type: "unknown" }).length, 0)

      const key = "sk-1234567890abcdef1234567890abcdef"
      let threw = false
      try {
        openAIEventToStreamPart({ error: { message: `key ${key}` } })
      } catch (e: any) {
        threw = true
        assert(!e.message.includes(key), "no leak openAI")
      }
      assert(threw, "openAI throws redacted")

      threw = false
      try {
        anthropicEventToStreamPart({ type: "error", error: { message: `Bearer ${key}` } })
      } catch (e: any) {
        threw = true
        assert(!e.message.includes(key), "no leak anthropic")
      }
      assert(threw, "anthropic throws redacted")
    },
  ],
  [
    "usage extraction matches for both providers",
    () => {
      const oa = openAIUsageToAiSdkUsage({ prompt_tokens: 100, completion_tokens: 50 } as any)
      const ant = anthropicUsageToAiSdkUsage({ input_tokens: 100, output_tokens: 50 } as any)
      assertEqual(oa?.inputTokens.total, 100)
      assertEqual(ant?.inputTokens.total, 100)
      // The same turn reported on either wire format maps to the same AI SDK
      // usage — the transport forwards it and OpenCode prices it (issue #176).
      assertEqual(oa, ant)
    },
  ],
])
