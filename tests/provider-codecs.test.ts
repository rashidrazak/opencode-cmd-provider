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
  parseStreamEventLine,
  openAIUsageToAiSdkUsage,
  anthropicUsageToAiSdkUsage,
} from "../src/provider/stream.js"
import { calculateCommandCodeCost, costUsageFromAiSdkUsage } from "../src/provider/cost.js"
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
    "Anthropic: prompt → Messages body has stream:true and system top-level",
    () => {
      const prompt = [
        { role: "system", content: "you are helpful" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ] as any
      const body = messagesToAnthropic(prompt, { model: "claude-sonnet-5" }) as any
      assertEqual(body.model, "claude-sonnet-5")
      assertEqual(body.stream, true)
      assertEqual(body.system, "you are helpful")
      assert(Array.isArray(body.messages), "messages array")
      assert(!body.messages.some((m: any) => m.role === "system"), "no system in messages")
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
      assert(ant.system.includes("sys A") && ant.system.includes("sys B"), "anthropic system")
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
      const cu = costUsageFromAiSdkUsage(f.usage)
      calculateCommandCodeCost({ cost: { input: 1, output: 5, cacheRead: 0.5, cacheWrite: 3 } }, cu)
      assert(cu.cost.total > 0, "cost")
    },
  ],
  [
    "Anthropic streaming: message_delta → finish with same shape as OpenAI",
    () => {
      const d = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }
      const p = anthropicEventToStreamPart(d)
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
    "usage extraction feeds cost path for both providers",
    () => {
      const oa = openAIUsageToAiSdkUsage({ prompt_tokens: 100, completion_tokens: 50 } as any)
      const ant = anthropicUsageToAiSdkUsage({ input_tokens: 100, output_tokens: 50 } as any)
      assertEqual(oa?.inputTokens.total, 100)
      assertEqual(ant?.inputTokens.total, 100)
      const cu1 = costUsageFromAiSdkUsage(oa!)
      const cu2 = costUsageFromAiSdkUsage(ant!)
      calculateCommandCodeCost(
        { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
        cu1,
      )
      calculateCommandCodeCost(
        { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
        cu2,
      )
      assertEqual(cu1.cost.total, cu2.cost.total)
    },
  ],
])
