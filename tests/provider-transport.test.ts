// tests/provider-transport.test.ts — Provider transport with per-model routing behind an explicit plan pin (issues #53, #159)
// Verifies documented Provider API: POST /provider/v1/messages for claude-*, POST /provider/v1/chat/completions otherwise,
// both with stream:true, Authorization: Bearer, baseURL via getApiBase/COMMANDCODE_API_BASE, incremental deltas + terminal usage→finish.
// Routing consults only an explicit pin (per-call providerOptions → model option → COMMANDCODE_PLAN): no plan lookup is made to
// choose a transport, so a Go account starts on the Provider API and flips to legacy on the documented 403 (issue #56).
import { createCommandCode } from "../src/provider/index.js"
import {
  startMockCc,
  anthropicContentBlockDelta,
  anthropicMessageDelta,
  openAIChunk,
  openAIFinishChunk,
  textDelta,
  finishEvent,
  eventsEnd,
  upgradeRequiredBody,
  liveMessagesUpgradeBody,
  headersToRecord,
  type MockCcOptions,
} from "./helpers/mock-cc.js"
import { projectSlugFromPath } from "../src/provider/project-slug.js"
import type { LanguageModelV3Prompt } from "../src/provider/aisdk-types.js"
import { assert, assertEqual, run, withEnvVars } from "./harness.js"

type Model = ReturnType<ReturnType<typeof createCommandCode>["languageModel"]>

async function collect(
  model: Model,
  prompt: LanguageModelV3Prompt,
  providerOptions?: unknown,
): Promise<Array<Record<string, unknown>>> {
  const result = await model.doStream({
    prompt,
    mode: { type: "regular" } as unknown as never,
    maxOutputTokens: 1000,
    providerOptions: providerOptions as never,
  })
  const parts: Array<Record<string, unknown>> = []
  const reader = result.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as unknown as Record<string, unknown>)
  }
  return parts
}

/** The transport's truncation failure, mirrored from upstream
 * `command-code@1.54.0` (issue #170). */
const TRUNCATION_MESSAGE =
  "Stream ended unexpectedly before completion (no finish event) — response was truncated"

/**
 * A 200 SSE response whose body dies right after the queued events were read —
 * a socket reset mid-stream, which rejects the reader rather than closing it.
 * The queued events are delivered first: the stream only errors once the
 * consumer has drained the queue.
 */
function dyingSseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        }
      },
      pull(controller) {
        controller.error(new Error("socket reset"))
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

/** Sets/clears COMMANDCODE_* env vars for the duration of fn, restoring after. */
function withEnv(plan: string | undefined, fn: () => Promise<void> | void): Promise<void> {
  return withEnvVars({ COMMANDCODE_PLAN: plan }, fn)
}

function withBaseEnv(base: string | undefined, fn: () => Promise<void> | void): Promise<void> {
  return withEnvVars({ COMMANDCODE_API_BASE: base }, fn)
}

/**
 * The `/alpha/generate` script of a turn that pauses once and finishes in its
 * continuation (issue #172): the first request reports 10/4 and `pause_turn`,
 * the second 3/5 and `end_turn`. The budget of a paused turn is what the two
 * tests using it assert — one at the `doStream` seam, one at `doGenerate`'s.
 */
function pausedLegacyTurn(): MockCcOptions {
  let requests = 0
  const options: MockCcOptions = {
    stream: [
      textDelta("first "),
      finishEvent({
        finishReason: "pause_turn",
        totalUsage: { inputTokens: 10, outputTokens: 4 },
      }),
    ],
  }
  options.onGenerate = () => {
    requests++
    if (requests === 2) {
      options.stream = [
        textDelta("second"),
        finishEvent({
          finishReason: "end_turn",
          totalUsage: { inputTokens: 3, outputTokens: 5 },
        }),
      ]
    }
  }
  return options
}

run([
  [
    "provider routing: goat plan claude-* hits /provider/v1/messages only",
    async () => {
      await withEnv("goat", async () => {
        const mock = await startMockCc({
          messagesStream: [
            anthropicContentBlockDelta("hel"),
            anthropicContentBlockDelta("lo"),
            anthropicMessageDelta({ input_tokens: 10, output_tokens: 5 }),
          ],
        })
        try {
          const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
          const parts = await collect(provider.languageModel("claude-sonnet-5"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(mock.hits.messages, 1)
          assertEqual(mock.hits.chatCompletions, 0)
          assertEqual(mock.hits.generate, 0)
          const deltas = parts
            .filter((p) => p.type === "text-delta")
            .map((p) => (p as { delta?: string }).delta)
          assertEqual(deltas, ["hel", "lo"])
          const finish = parts.find((p) => p.type === "finish") as {
            usage?: { inputTokens?: { total?: number }; outputTokens?: { total?: number } }
          }
          assert(finish, "finish present")
          assertEqual(finish.usage?.inputTokens?.total, 10)
          assertEqual(finish.usage?.outputTokens?.total, 5)
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "provider routing: goat plan non-claude hits /provider/v1/chat/completions only",
    async () => {
      await withEnv("goat", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [
            openAIChunk("hel"),
            openAIChunk("lo"),
            openAIFinishChunk({ prompt_tokens: 10, completion_tokens: 5 }),
          ],
        })
        try {
          const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(mock.hits.chatCompletions, 1)
          assertEqual(mock.hits.messages, 0)
          assertEqual(mock.hits.generate, 0)
          const deltas = parts
            .filter((p) => p.type === "text-delta")
            .map((p) => (p as { delta?: string }).delta)
          assertEqual(deltas, ["hel", "lo"])
          const finish = parts.find((p) => p.type === "finish") as {
            usage?: { inputTokens?: { total?: number }; outputTokens?: { total?: number } }
          }
          assertEqual(finish.usage?.inputTokens?.total, 10)
          assertEqual(finish.usage?.outputTokens?.total, 5)
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "provider routing: alias variants via normalizePlan all hit provider",
    async () => {
      const aliases = [
        "individual-goat",
        "pro",
        "individual-pro",
        "max",
        "max10",
        "max-10x",
        "max 10x",
        "individual-max",
        "max20",
        "max-20x",
        "ultra",
        "individual-ultra",
        "teampro",
        "team-pro",
        "provider",
        "individual-provider",
        "GOAT",
        "Pro",
        "MAX",
      ]
      for (const alias of aliases) {
        await withEnv(alias, async () => {
          const mock = await startMockCc({
            chatCompletionsStream: [openAIChunk("x"), openAIFinishChunk()],
          })
          try {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            const parts = await collect(provider.languageModel("deepseek-v4"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mock.hits.chatCompletions, 1, `alias ${alias} should hit chat/completions`)
            assertEqual(mock.hits.generate, 0, `alias ${alias} no /alpha/generate`)
            assertEqual(mock.hits.messages, 0, `alias ${alias} not messages`)
            const finish = parts.find((p) => p.type === "finish")
            assert(finish, `alias ${alias} finish`)
          } finally {
            await mock.close()
          }
        })
      }
    },
  ],
  [
    "provider routing: go plan stays on legacy /alpha/generate",
    async () => {
      await withEnv("go", async () => {
        const mock = await startMockCc({
          stream: [
            { type: "text-delta", text: "hi" },
            {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 10, outputTokens: 4 },
            },
          ],
        })
        try {
          const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
          const parts = await collect(provider.languageModel("claude-sonnet-5"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(mock.hits.generate, 1)
          assertEqual(mock.hits.chatCompletions, 0)
          assertEqual(mock.hits.messages, 0)
          assert(
            parts.some((p) => p.type === "text-delta"),
            "legacy delta",
          )
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "provider routing: individual-go alias stays legacy",
    async () => {
      await withEnv("individual-go", async () => {
        const mock = await startMockCc({
          stream: [
            { type: "text-delta", text: "hi" },
            {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            },
          ],
        })
        try {
          const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
          await collect(provider.languageModel("gpt-5.6-terra"), [{ role: "user", content: "hi" }])
          assertEqual(mock.hits.generate, 1)
          assertEqual(mock.hits.chatCompletions, 0)
          assertEqual(mock.hits.messages, 0)
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "provider routing: with no plan pin the session starts on the Provider API — no plan lookup (issue #159)",
    async () => {
      // Routing must not depend on the account's plan any more, so scrub every
      // env input and serve no billing endpoint: the Provider API is used and
      // nothing was fetched to decide it.
      await withEnvVars(
        {
          COMMANDCODE_PLAN: undefined,
          COMMANDCODE_API_KEY: undefined,
          COMMANDCODE_API_BASE: undefined,
        },
        async () => {
          {
            const mock = await startMockCc({
              chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
            })
            try {
              const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
              await collect(provider.languageModel("gpt-5.6-terra"), [
                { role: "user", content: "hi" },
              ])
              assertEqual(mock.hits.whoami, 0, "no whoami lookup to route")
              assertEqual(mock.hits.subscriptions, 0, "no billing lookup to route")
              assertEqual(mock.hits.credits, 0)
              assertEqual(mock.hits.chatCompletions, 1)
              assertEqual(mock.hits.generate, 0)
              assertEqual(mock.hits.messages, 0)
            } finally {
              await mock.close()
            }
          }
          {
            const mock = await startMockCc({
              messagesStream: [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
            })
            try {
              const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
              await collect(provider.languageModel("claude-sonnet-5"), [
                { role: "user", content: "hi" },
              ])
              assertEqual(mock.hits.messages, 1)
              assertEqual(mock.hits.generate, 0)
              assertEqual(mock.hits.whoami, 0)
            } finally {
              await mock.close()
            }
          }
        },
      )
    },
  ],
  [
    "provider routing: per-model catalogue examples",
    async () => {
      await withEnv("provider", async () => {
        // claude-* → messages
        {
          const mock = await startMockCc({
            messagesStream: [anthropicContentBlockDelta("a"), anthropicMessageDelta()],
          })
          try {
            await collect(
              createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel(
                "claude-sonnet-5",
              ),
              [{ role: "user", content: "hi" }],
            )
            assertEqual(mock.hits.messages, 1)
            assertEqual(mock.hits.chatCompletions, 0)
          } finally {
            await mock.close()
          }
        }
        {
          const mock = await startMockCc({
            messagesStream: [anthropicContentBlockDelta("a"), anthropicMessageDelta()],
          })
          try {
            await collect(
              createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel("claude-opus-5"),
              [{ role: "user", content: "hi" }],
            )
            assertEqual(mock.hits.messages, 1)
          } finally {
            await mock.close()
          }
        }
        // non-claude → chat/completions
        const nonClaude = ["gpt-5.6-terra", "Qwen/Qwen3.8-Max", "deepseek-v4", "zai-org/GLM-5.3"]
        for (const mid of nonClaude) {
          const mock = await startMockCc({
            chatCompletionsStream: [openAIChunk("a"), openAIFinishChunk()],
          })
          try {
            await collect(
              createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel(mid),
              [{ role: "user", content: "hi" }],
            )
            assertEqual(mock.hits.chatCompletions, 1, `${mid} chat`)
            assertEqual(mock.hits.messages, 0, `${mid} not messages`)
          } finally {
            await mock.close()
          }
        }
      })
    },
  ],
  [
    "provider: both endpoints stream token deltas incrementally and surface terminal usage as finish",
    async () => {
      await withEnv("pro", async () => {
        // OpenAI path
        {
          const mock = await startMockCc({
            chatCompletionsStream: [
              openAIChunk("Hello"),
              openAIChunk(" world"),
              openAIFinishChunk({ prompt_tokens: 20, completion_tokens: 8 }),
            ],
          })
          try {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
              { role: "user", content: "hi" },
            ])
            const deltas = parts
              .filter((p) => p.type === "text-delta")
              .map((p) => (p as never as { delta: string }).delta)
            assertEqual(deltas, ["Hello", " world"])
            const finish = parts.find((p) => p.type === "finish") as {
              finishReason?: { unified?: string }
              usage?: { inputTokens: { total: number }; outputTokens: { total: number } }
            }
            assertEqual(finish.finishReason?.unified, "stop")
            assertEqual(finish.usage?.inputTokens.total, 20)
            assertEqual(finish.usage?.outputTokens.total, 8)
          } finally {
            await mock.close()
          }
        }
        // Anthropic path
        {
          const mock = await startMockCc({
            messagesStream: [
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              anthropicContentBlockDelta("Hello"),
              anthropicContentBlockDelta(" world"),
              anthropicMessageDelta({ input_tokens: 20, output_tokens: 8 }),
            ],
          })
          try {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            const parts = await collect(provider.languageModel("claude-sonnet-5"), [
              { role: "user", content: "hi" },
            ])
            const deltas = parts
              .filter((p) => p.type === "text-delta")
              .map((p) => (p as never as { delta: string }).delta)
            assert(deltas.includes("Hello"), "anthropic Hello delta")
            assert(deltas.includes(" world"), "anthropic world delta")
            const finish = parts.find((p) => p.type === "finish") as {
              usage?: { inputTokens: { total: number }; outputTokens: { total: number } }
            }
            assertEqual(finish.usage?.inputTokens.total, 20)
            assertEqual(finish.usage?.outputTokens.total, 8)
          } finally {
            await mock.close()
          }
        }
      })
    },
  ],
  [
    "provider: OpenAI split terminal chunk — usage-only chunk after finish_reason is still consumed",
    async () => {
      // Real OpenAI SSE with include_usage: finish_reason arrives on a content chunk,
      // then a SEPARATE trailing usage-only chunk (choices:[]) carries the tokens.
      const mock = await startMockCc({
        chatCompletionsStream: [
          { id: "chatcmpl-test", choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
          {
            id: "chatcmpl-test",
            choices: [{ delta: { content: " world" }, finish_reason: "length" }],
          },
          // Separate terminal usage chunk
          {
            id: "chatcmpl-test",
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          },
        ],
      })
      try {
        const parts = await collect(
          createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel("gpt-5.6-terra"),
          [{ role: "user", content: "hi" }],
        )
        const deltas = parts
          .filter((p) => p.type === "text-delta")
          .map((p) => (p as never as { delta: string }).delta)
        assertEqual(deltas, ["Hello", " world"])
        const finish = parts.find((p) => p.type === "finish") as {
          finishReason?: { unified?: string }
          usage?: { inputTokens: { total: number }; outputTokens: { total: number } }
        }
        // The non-stop finish_reason is carried on the content chunk; the
        // usage-only trailing chunk must not mask it back to "stop".
        assertEqual(finish.finishReason?.unified, "length")
        // Regression: usage from the trailing split chunk must be honoured, not zeroed.
        assertEqual(finish.usage?.inputTokens.total, 20)
        assertEqual(finish.usage?.outputTokens.total, 8)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "provider: Anthropic message_delta usage survives the trailing message_stop (issue #174)",
    async () => {
      // Live /provider/v1/messages order (2026-09-16): message_start →
      // content_block_* → message_delta (usage) → message_stop (bare). The
      // parser now drops that terminal once `message_delta` finished the
      // stream; before the fix it mapped a second, zeroed finish that the
      // transport's last-wins hold preferred (OpenAI's mirror order is why the
      // hold exists), so every Claude turn reported zero usage and zero cost
      // and the real stop_reason was masked by `stop`.
      const chunks = [
        {
          type: "message_start",
          message: {
            id: "msg_1",
            role: "assistant",
            usage: { input_tokens: 20, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "ping" },
        anthropicContentBlockDelta("Hello"),
        { type: "content_block_stop", index: 0 },
        anthropicMessageDelta({
          input_tokens: 20,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
          output_tokens: 8,
        }),
        { type: "message_stop" },
      ]
      const mock = await startMockCc({ messagesStream: chunks })
      try {
        const model = createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel(
          "claude-sonnet-5",
        )
        const prompt: LanguageModelV3Prompt = [{ role: "user", content: "hi" }]
        const parts = await collect(model, prompt)
        assertEqual(
          parts.filter((p) => p.type === "finish").length,
          1,
          "exactly one finish reaches the consumer",
        )
        const finish = parts.find((p) => p.type === "finish") as {
          finishReason?: { unified?: string; raw?: string }
          usage?: {
            inputTokens: { total: number; cacheRead: number; cacheWrite: number }
            outputTokens: { total: number }
          }
        }
        assertEqual(finish.finishReason, { unified: "stop", raw: "end_turn" })
        // The defect's headline: non-zero usage rather than the zeroed terminal.
        // The cache-inclusive total is #178's mapping, so this pins non-zero
        // input plus the cache pass-through the same capture showed.
        assert((finish.usage?.inputTokens.total ?? 0) > 0, "input usage non-zero")
        assertEqual(finish.usage?.inputTokens.cacheRead, 4)
        assertEqual(finish.usage?.inputTokens.cacheWrite, 2)
        assertEqual(finish.usage?.outputTokens.total, 8)

        // The same stream through doGenerate must report the same usage.
        const gen = await model.doGenerate({ prompt, mode: { type: "regular" } } as never)
        assert((gen.usage.inputTokens.total ?? 0) > 0, "doGenerate input usage non-zero")
        assertEqual(gen.usage.outputTokens.total, 8)
        assertEqual(gen.usage, finish.usage)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "provider: Anthropic usage-less terminal finish does not mask the message_delta stop reason (issue #174)",
    async () => {
      // The bare terminal's synthesized finish carries the `stop` default. When
      // it overwrote the usage-bearing finish it also replaced a real
      // `max_tokens` stop_reason with `stop`, hiding the truncation.
      const mock = await startMockCc({
        messagesStream: [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          anthropicContentBlockDelta("Truncated"),
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
            usage: { input_tokens: 20, output_tokens: 8 },
          },
          { type: "message_stop" },
        ],
      })
      try {
        const parts = await collect(
          createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel("claude-sonnet-5"),
          [{ role: "user", content: "hi" }],
        )
        const finish = parts.find((p) => p.type === "finish") as {
          finishReason?: { unified?: string; raw?: string }
          usage?: { outputTokens: { total: number } }
        }
        assert(finish, "finish present")
        assertEqual(finish.finishReason, { unified: "length", raw: "max_tokens" })
        assertEqual(finish.usage?.outputTokens.total, 8)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "provider: OpenAI transport reports cache reads from prompt_tokens_details (issue #158)",
    async () => {
      // Reproduction at the transport boundary: the documented OpenAI-shape
      // terminal chunk nests the cached prefix in prompt_tokens_details.
      // Before #158 the parser read only top-level cache fields, reported
      // cacheRead 0, and let usageToAiSdk reclassify the whole 52000-token
      // prompt as fresh input — pricing the cached prefix at the input rate
      // and inflating the reported spend by the input/cacheRead ratio.
      //
      // The asserted usage is the whole contract at this seam: OpenCode prices
      // the reported cache split with the rates the model advertises, so the
      // transport's job is to report the split correctly (issue #176).
      // The model id is a fixture — the mock reports the usage regardless of
      // the row — and only has to route to the OpenAI endpoint.
      await withEnv("pro", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [
            openAIChunk("Hello"),
            openAIFinishChunk({
              prompt_tokens: 52000,
              completion_tokens: 300,
              total_tokens: 52300,
              prompt_tokens_details: { cached_tokens: 50000 },
            }),
          ],
        })
        try {
          const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(mock.hits.chatCompletions, 1)
          const finish = parts.find((p) => p.type === "finish") as {
            usage?: {
              inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number }
              outputTokens: { total: number }
            }
          }
          assertEqual(finish.usage, {
            inputTokens: { total: 52000, noCache: 2000, cacheRead: 50000, cacheWrite: 0 },
            outputTokens: { total: 300, text: 300, reasoning: 0 },
          })
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "provider: Anthropic transport maps cache-exclusive input_tokens to a cache-inclusive total (issue #178)",
    async () => {
      // Live /provider/v1/messages (2026-09-16): Anthropic reports
      // `input_tokens` *excluding* the cached prefix, so the shared OpenAI-style
      // arithmetic (which assumes an inclusive prompt total) collapsed
      // `noCache` to 0 and reported only the fresh remainder as the whole
      // prompt. @ai-sdk/anthropic maps `total = input + cacheWrite + cacheRead`,
      // `noCache = input`.
      const cases = [
        {
          label: "warm cache read",
          usage: { input_tokens: 322, cache_read_input_tokens: 7296, output_tokens: 8 },
          expected: {
            inputTokens: { total: 7618, noCache: 322, cacheRead: 7296, cacheWrite: 0 },
            outputTokens: { total: 8, text: 8, reasoning: 0 },
          },
        },
        {
          label: "cold cache write",
          usage: { input_tokens: 4, cache_creation_input_tokens: 1885, output_tokens: 2 },
          expected: {
            inputTokens: { total: 1889, noCache: 4, cacheRead: 0, cacheWrite: 1885 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
        },
      ]
      for (const { label, usage, expected } of cases) {
        const mock = await startMockCc({
          messagesStream: [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            anthropicContentBlockDelta("Cached"),
            { type: "content_block_stop", index: 0 },
            anthropicMessageDelta(usage),
            { type: "message_stop" },
          ],
        })
        try {
          const parts = await collect(
            createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel("claude-sonnet-5"),
            [{ role: "user", content: "hi" }],
          )
          assertEqual(mock.hits.messages, 1)
          const finish = parts.find((p) => p.type === "finish") as {
            usage?: typeof expected
          }
          assert(finish, `${label}: finish present`)
          assertEqual(finish.usage, expected, label)
        } finally {
          await mock.close()
        }
      }
    },
  ],
  [
    "provider: doGenerate non-streaming returns same content and usage as doStream aggregated",
    async () => {
      await withEnv("max", async () => {
        // OpenAI model via chat/completions
        {
          const chunks = [
            openAIChunk("Hello "),
            openAIChunk("world"),
            openAIFinishChunk({ prompt_tokens: 12, completion_tokens: 6 }),
          ]
          const mock1 = await startMockCc({ chatCompletionsStream: chunks })
          const mock2 = await startMockCc({ chatCompletionsStream: chunks })
          try {
            const provider1 = createCommandCode({ apiKey: "k", baseURL: mock1.url })
            const provider2 = createCommandCode({ apiKey: "k", baseURL: mock2.url })
            const modelDoGenerate = provider1.languageModel("gpt-5.6-terra")
            const modelDoStream = provider2.languageModel("gpt-5.6-terra")
            const prompt: LanguageModelV3Prompt = [{ role: "user", content: "hi" }]
            const gen = await modelDoGenerate.doGenerate({
              prompt,
              mode: { type: "regular" },
            } as never)
            const streamParts = await collect(modelDoStream, prompt)
            const streamText = streamParts
              .filter((p) => p.type === "text-delta")
              .map((p) => (p as { delta: string }).delta)
              .join("")
            const genText =
              (
                gen.content.find((c) => (c as { type: string }).type === "text") as
                  { text?: string } | undefined
              )?.text ?? ""
            assertEqual(genText, streamText)
            assertEqual(genText, "Hello world")
            const genUsage = gen.usage
            const streamFinish = streamParts.find((p) => p.type === "finish") as {
              usage: typeof genUsage
            }
            assertEqual(JSON.stringify(genUsage), JSON.stringify(streamFinish.usage))
          } finally {
            await mock1.close()
            await mock2.close()
          }
        }
        // Anthropic model via messages
        {
          const chunks = [
            anthropicContentBlockDelta("Hello "),
            anthropicContentBlockDelta("world"),
            anthropicMessageDelta({ input_tokens: 12, output_tokens: 6 }),
          ]
          const mock1 = await startMockCc({ messagesStream: chunks })
          const mock2 = await startMockCc({ messagesStream: chunks })
          try {
            const provider1 = createCommandCode({ apiKey: "k", baseURL: mock1.url })
            const provider2 = createCommandCode({ apiKey: "k", baseURL: mock2.url })
            const prompt: LanguageModelV3Prompt = [{ role: "user", content: "hi" }]
            const gen = await provider1
              .languageModel("claude-sonnet-5")
              .doGenerate({ prompt, mode: { type: "regular" } } as never)
            const streamParts = await collect(provider2.languageModel("claude-sonnet-5"), prompt)
            const genText =
              (
                gen.content.find((c) => (c as { type: string }).type === "text") as {
                  text?: string
                }
              )?.text ?? ""
            const streamText = streamParts
              .filter((p) => p.type === "text-delta")
              .map((p) => (p as { delta: string }).delta)
              .join("")
            assertEqual(genText, streamText)
            assertEqual(genText, "Hello world")
            const streamFinish = streamParts.find((p) => p.type === "finish") as {
              usage: typeof gen.usage
            }
            assertEqual(JSON.stringify(gen.usage), JSON.stringify(streamFinish.usage))
          } finally {
            await mock1.close()
            await mock2.close()
          }
        }
      })
    },
  ],
  [
    "provider: auth Authorization Bearer via resolveApiKey",
    async () => {
      await withEnv("provider", async () => {
        let capturedHeaders: Record<string, string> | undefined
        const mock = await startMockCc({
          chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
          onChatCompletions: (_body, headers) => {
            capturedHeaders = headers
          },
        })
        try {
          const provider = createCommandCode({ apiKey: "sk_test_12345", baseURL: mock.url })
          await collect(provider.languageModel("gpt-5.6-terra"), [{ role: "user", content: "hi" }])
          assert(capturedHeaders, "headers captured")
          assertEqual(capturedHeaders!["authorization"], "Bearer sk_test_12345")
          // provider should not send legacy x-* headers
          assert(!("x-command-code-version" in capturedHeaders!), "no legacy version header")
          assert(!("x-cli-environment" in capturedHeaders!), "no legacy env header")
        } finally {
          await mock.close()
        }

        let capturedAnthropic: Record<string, string> | undefined
        const mock2 = await startMockCc({
          messagesStream: [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
          onMessages: (_b, h) => {
            capturedAnthropic = h
          },
        })
        try {
          const provider = createCommandCode({ apiKey: "sk_other", baseURL: mock2.url })
          await collect(provider.languageModel("claude-sonnet-5"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(capturedAnthropic!["authorization"], "Bearer sk_other")
        } finally {
          await mock2.close()
        }
      })
    },
  ],
  [
    "provider: base URL via COMMANDCODE_API_BASE honoured for /provider/v1/*",
    async () => {
      await withEnv("goat", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
        })
        try {
          await withBaseEnv(mock.url, async () => {
            const provider = createCommandCode({ apiKey: "k" }) // no baseURL, should use env getApiBase()
            await collect(provider.languageModel("gpt-5.6-terra"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mock.hits.chatCompletions, 1)
          })
        } finally {
          await mock.close()
        }
        const mock2 = await startMockCc({
          messagesStream: [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
        })
        try {
          await withBaseEnv(mock2.url, async () => {
            const provider = createCommandCode({ apiKey: "k" })
            await collect(provider.languageModel("claude-sonnet-5"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mock2.hits.messages, 1)
          })
        } finally {
          await mock2.close()
        }
      })
    },
  ],
  [
    "provider: baseURL option takes precedence over COMMANDCODE_API_BASE",
    async () => {
      await withEnv("goat", async () => {
        const mockEnv = await startMockCc({
          chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
        })
        const mockOpt = await startMockCc({
          chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
        })
        try {
          await withBaseEnv(mockEnv.url, async () => {
            const provider = createCommandCode({ apiKey: "k", baseURL: mockOpt.url })
            await collect(provider.languageModel("gpt-5.6-terra"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mockOpt.hits.chatCompletions, 1, "opt base used")
            assertEqual(mockEnv.hits.chatCompletions, 0, "env base not used when opt present")
          })
        } finally {
          await mockEnv.close()
          await mockOpt.close()
        }
      })
    },
  ],
  [
    "provider: body contains stream:true and model, no leakage to legacy shape",
    async () => {
      await withEnv("teampro", async () => {
        let bodyChat: Record<string, unknown> | undefined
        const mock = await startMockCc({
          chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
          onChatCompletions: (b) => {
            bodyChat = b
          },
        })
        try {
          await collect(
            createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel("deepseek-v4"),
            [{ role: "user", content: "hi" }],
          )
          assertEqual((bodyChat as { stream?: boolean })?.stream, true)
          assertEqual((bodyChat as { model?: string })?.model, "deepseek-v4")
          assertEqual(
            (bodyChat as { stream_options?: { include_usage?: boolean } })?.stream_options
              ?.include_usage,
            true,
          )
          assert(!("config" in (bodyChat as object)), "no legacy config in provider body")
          assert(!("params" in (bodyChat as object)), "no legacy params")
        } finally {
          await mock.close()
        }

        let bodyMsg: Record<string, unknown> | undefined
        const mock2 = await startMockCc({
          messagesStream: [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
          onMessages: (b) => {
            bodyMsg = b
          },
        })
        try {
          await collect(
            createCommandCode({ apiKey: "k", baseURL: mock2.url }).languageModel("claude-sonnet-5"),
            [{ role: "user", content: "hi" }],
          )
          assertEqual((bodyMsg as { stream?: boolean })?.stream, true)
          assertEqual((bodyMsg as { model?: string })?.model, "claude-sonnet-5")
          assert("max_tokens" in (bodyMsg as object), "anthropic has max_tokens")
        } finally {
          await mock2.close()
        }
      })
    },
  ],
  [
    "provider: Claude requests carry one ephemeral cache breakpoint on the system prefix (issue #177)",
    async () => {
      // Measured live (2026-09-16): a flat system string re-billed the whole
      // ~7k prefix on every turn (7015 fresh input, 0 cache reads), while the
      // same prefix sent as a system block array with `cache_control` wrote
      // 7142 tokens cold and read them back warm for 13 fresh tokens. The
      // breakpoint is what makes the prefix reusable. The legacy
      // `/alpha/generate` body keeps its plain-string `params.system`, pinned
      // in tests/provider-parity.test.ts — the gateway injects its own 1h
      // breakpoint there, so the port would be inert.
      await withEnv("pro", async () => {
        let bodyMsg: Record<string, unknown> | undefined
        const mock = await startMockCc({
          messagesStream: [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
          onMessages: (b) => {
            bodyMsg = b
          },
        })
        try {
          await collect(
            createCommandCode({ apiKey: "k", baseURL: mock.url }).languageModel("claude-sonnet-5"),
            [
              { role: "system", content: "You are a test." },
              { role: "user", content: "hi" },
            ],
          )
          assertEqual(mock.hits.messages, 1)
          assertEqual(bodyMsg?.system, [
            { type: "text", text: "You are a test.", cache_control: { type: "ephemeral" } },
          ])
          // Exactly one breakpoint, on the system prefix: no message is
          // cache-marked, so history caching stays out of scope (#177).
          assert(
            !JSON.stringify(bodyMsg?.messages).includes("cache_control"),
            "no breakpoint in messages",
          )
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "provider: plan override via providerOptions (commandcode.plan) and per-model options",
    async () => {
      // without env, but via providerOptions
      const mock = await startMockCc({
        chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
      })
      try {
        const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
        await collect(provider.languageModel("gpt-5.6-terra"), [{ role: "user", content: "hi" }], {
          commandcode: { plan: "goat" },
        })
        assertEqual(mock.hits.chatCompletions, 1)
        assertEqual(mock.hits.generate, 0)
      } finally {
        await mock.close()
      }

      const mock2 = await startMockCc({
        messagesStream: [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
      })
      try {
        const provider = createCommandCode({ apiKey: "k", baseURL: mock2.url })
        await collect(
          provider.languageModel("claude-sonnet-5"),
          [{ role: "user", content: "hi" }],
          { commandcode: { plan: "provider" } },
        )
        assertEqual(mock2.hits.messages, 1)
      } finally {
        await mock2.close()
      }

      // via modelOptions plan field
      const mock3 = await startMockCc({
        chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
      })
      try {
        const provider = createCommandCode({
          apiKey: "k",
          baseURL: mock3.url,
          plan: "pro",
        } as never)
        await collect(provider.languageModel("gpt-5.6-terra"), [{ role: "user", content: "hi" }])
        assertEqual(mock3.hits.chatCompletions, 1)
      } finally {
        await mock3.close()
      }
    },
  ],
  [
    "provider: exactly one provider endpoint per call — no /alpha/generate traffic",
    async () => {
      await withEnv("max20", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [openAIChunk("a"), openAIFinishChunk()],
        })
        try {
          const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
          await collect(provider.languageModel("gpt-5.6-terra"), [{ role: "user", content: "hi" }])
          await collect(provider.languageModel("gpt-5.6-terra"), [{ role: "user", content: "hi" }])
          assertEqual(mock.hits.chatCompletions, 2)
          assertEqual(mock.hits.generate, 0)
          assertEqual(mock.hits.messages, 0)
        } finally {
          await mock.close()
        }
        const mock2 = await startMockCc({
          messagesStream: [anthropicContentBlockDelta("a"), anthropicMessageDelta()],
        })
        try {
          const provider = createCommandCode({ apiKey: "k", baseURL: mock2.url })
          await collect(provider.languageModel("claude-sonnet-5"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(mock2.hits.messages, 1)
          assertEqual(mock2.hits.generate, 0)
        } finally {
          await mock2.close()
        }
      })
    },
  ],
  [
    "provider: fetch spy receives correct endpoint URL",
    async () => {
      await withEnv("provider", async () => {
        const seen: string[] = []
        const fakeFetch: typeof fetch = async (input, _init) => {
          seen.push(typeof input === "string" ? input : (input as URL).toString())
          // return a minimal valid SSE that yields finish immediately
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              const enc = new TextEncoder()
              // For gpt model we expect openAI shape
              c.enqueue(enc.encode(`data: ${JSON.stringify(openAIChunk("hi"))}\n\n`))
              c.enqueue(enc.encode(`data: ${JSON.stringify(openAIFinishChunk())}\n\n`))
              c.enqueue(enc.encode(`data: [DONE]\n\n`))
              c.close()
            },
          })
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        }
        const provider = createCommandCode({
          apiKey: "k",
          baseURL: "https://api.commandcode.ai",
          fetch: fakeFetch,
        })
        await collect(provider.languageModel("gpt-5.6-terra"), [{ role: "user", content: "hi" }])
        assert(
          seen.some((u) => u.includes("/provider/v1/chat/completions")),
          "saw chat completions endpoint",
        )
        assert(!seen.some((u) => u.includes("/alpha/generate")), "no legacy endpoint")

        seen.length = 0
        const fakeFetch2: typeof fetch = async (input, _init) => {
          seen.push(typeof input === "string" ? input : (input as URL).toString())
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              const enc = new TextEncoder()
              c.enqueue(enc.encode(`data: ${JSON.stringify(anthropicContentBlockDelta("hi"))}\n\n`))
              c.enqueue(enc.encode(`data: ${JSON.stringify(anthropicMessageDelta())}\n\n`))
              c.close()
            },
          })
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        }
        const provider2 = createCommandCode({
          apiKey: "k",
          baseURL: "https://api.commandcode.ai",
          fetch: fakeFetch2,
        })
        await collect(provider2.languageModel("claude-sonnet-5"), [{ role: "user", content: "hi" }])
        assert(
          seen.some((u) => u.includes("/provider/v1/messages")),
          "saw messages endpoint",
        )
      })
    },
  ],
  [
    "transport: a live Go subscription does not route the session (issue #159)",
    async () => {
      // The billing endpoints are served and would resolve individual-go, but
      // inference never asks: routing is not plan-based any more. A real Go
      // account reaches legacy through the documented 403 fallback below.
      const mock = await startMockCc({
        whoami: { success: true, user: { id: "u" }, org: null },
        subscriptions: { success: true, data: { status: "active", planId: "individual-go" } },
        credits: { credits: { planId: "individual-go" } },
        chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
      })
      try {
        await withEnvVars(
          {
            COMMANDCODE_PLAN: undefined,
            COMMANDCODE_API_KEY: "test_key",
            COMMANDCODE_API_BASE: mock.url,
          },
          async () => {
            const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
            await collect(provider.languageModel("gpt-5.6-terra"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mock.hits.whoami, 0)
            assertEqual(mock.hits.subscriptions, 0)
            assertEqual(mock.hits.credits, 0)
            assertEqual(mock.hits.chatCompletions, 1)
            assertEqual(mock.hits.generate, 0)
            assertEqual(mock.hits.messages, 0)
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a Go account flips to legacy on 403 — the legacy metadata stays pinned (#56, #159 item 3)",
    async () => {
      let legacyHeaders: Record<string, string> | undefined
      let legacyBody: Record<string, unknown> | undefined
      const mock = await startMockCc({
        chatCompletionsStatus: 403,
        chatCompletionsErrorBody: JSON.stringify(upgradeRequiredBody()),
        stream: [textDelta("hi"), finishEvent()],
        onGenerate: (body, headers) => {
          legacyBody = body
          legacyHeaders = headers
        },
      })
      try {
        await withEnvVars(
          { COMMANDCODE_PLAN: undefined, COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: mock.url },
          async () => {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mock.hits.chatCompletions, 1, "Provider API is tried first")
            assertEqual(mock.hits.generate, 1, "403 upgrade_required → one legacy retry")
            assertEqual(mock.hits.whoami, 0, "the flip needs no plan lookup")
            assert(
              parts.some((p) => p.type === "text-delta"),
              "legacy delta emitted",
            )
            // The legacy transport carries the working directory and project
            // metadata the Provider API never sends (issue #159 item 3). Pin it
            // so the Go path's exposure stays deliberate and visible.
            const config = legacyBody?.config as Record<string, unknown> | undefined
            assertEqual(config?.workingDir, process.cwd(), "legacy body carries the absolute cwd")
            assertEqual(
              legacyHeaders?.["x-project-slug"],
              projectSlugFromPath(process.cwd()),
              "legacy headers carry the project slug",
            )
            assertEqual(legacyHeaders?.["x-taste-learning"], "true")
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a Go account flips on the live /provider/v1/messages 403 (permission_error, no code) (issue #175)",
    async () => {
      // The Anthropic endpoint answers the plan refusal in the Anthropic
      // envelope — plan phrasing with no `error.code` — so the flip may not
      // depend on the documented `upgrade_required` code.
      const mock = await startMockCc({
        messagesStatus: 403,
        messagesErrorBody: liveMessagesUpgradeBody(),
        stream: [textDelta("hi"), finishEvent()],
      })
      try {
        await withEnvVars(
          { COMMANDCODE_PLAN: undefined, COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: mock.url },
          async () => {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            const parts = await collect(provider.languageModel("claude-sonnet-5"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mock.hits.messages, 1, "Provider API /messages is tried first")
            assertEqual(mock.hits.generate, 1, "the live 403 → one legacy retry")
            assertEqual(
              mock.hits.chatCompletions,
              0,
              "the Anthropic route never hits chat/completions",
            )
            assert(
              parts.some((p) => p.type === "text-delta"),
              "legacy delta emitted",
            )
            assert(!parts.some((p) => p.type === "error"), "no error part — the retry succeeded")
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: only an explicit go pin selects legacy — every other pin uses the Provider API",
    async () => {
      for (const plan of ["pro", "max", "max20", "teampro", "provider", "individual-goat"]) {
        const mock = await startMockCc({
          whoami: { planId: "individual-go" },
          subscriptions: { success: true, data: { status: "active", planId: "individual-go" } },
          chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
        })
        try {
          await withEnvVars(
            { COMMANDCODE_PLAN: plan, COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: mock.url },
            async () => {
              const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
              await collect(provider.languageModel("gpt-5.6-terra"), [
                { role: "user", content: "hi" },
              ])
              assertEqual(mock.hits.chatCompletions, 1, `pin ${plan} → chat/completions`)
              assertEqual(mock.hits.generate, 0, `pin ${plan} no /alpha/generate`)
              assertEqual(mock.hits.subscriptions, 0, `pin ${plan} consults no billing endpoint`)
            },
          )
        } finally {
          await mock.close()
        }
      }
    },
  ],
  [
    "transport: two turns on one model instance make no plan lookup (nothing to cache)",
    async () => {
      const mock = await startMockCc({
        subscriptions: { success: true, data: { status: "active", planId: "individual-goat" } },
        chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
      })
      try {
        await withEnvVars(
          { COMMANDCODE_PLAN: undefined, COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: mock.url },
          async () => {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            const model = provider.languageModel("gpt-5.6-terra")
            await collect(model, [{ role: "user", content: "hi" }])
            await collect(model, [{ role: "user", content: "hi" }])
            assertEqual(mock.hits.chatCompletions, 2)
            assertEqual(mock.hits.whoami + mock.hits.subscriptions + mock.hits.credits, 0)
            assertEqual(mock.hits.generate, 0)
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a broken or unauthorized billing API cannot change routing — it is never called",
    async () => {
      const mock = await startMockCc({
        whoamiStatus: 500,
        subscriptionsStatus: 401,
        creditsStatus: 500,
        chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
      })
      try {
        await withEnvVars(
          { COMMANDCODE_PLAN: undefined, COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: mock.url },
          async () => {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            await collect(provider.languageModel("gpt-5.6-terra"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mock.hits.whoami, 0)
            assertEqual(mock.hits.subscriptions, 0)
            assertEqual(mock.hits.credits, 0)
            assertEqual(mock.hits.chatCompletions, 1)
            assertEqual(mock.hits.generate, 0)
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: doStream and doGenerate both start on the Provider API with no plan lookup",
    async () => {
      const mock = await startMockCc({
        chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
      })
      try {
        await withEnvVars(
          {
            COMMANDCODE_PLAN: undefined,
            COMMANDCODE_API_KEY: "k",
            // an unreachable env base cannot matter: nothing is fetched to route
            COMMANDCODE_API_BASE: "http://127.0.0.1:1",
          },
          async () => {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            await collect(provider.languageModel("gpt-5.6-terra"), [
              { role: "user", content: "hi" },
            ])
            const gen = await provider.languageModel("gpt-5.6-terra").doGenerate({
              prompt: [{ role: "user", content: "hi" }],
              mode: { type: "regular" },
            } as never)
            // two model instances (doStream + doGenerate) → two Provider API
            // calls and zero routing lookups
            assertEqual(mock.hits.chatCompletions, 2)
            assertEqual(mock.hits.whoami + mock.hits.subscriptions + mock.hits.credits, 0)
            assertEqual(mock.hits.generate, 0)
            assert(gen.content.length >= 1, "doGenerate produced content")
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: COMMANDCODE_PLAN=go is the explicit pin — legacy transport, no lookup",
    async () => {
      const mock = await startMockCc({
        whoami: { planId: "individual-goat" },
        subscriptions: { success: true, data: { status: "active", planId: "individual-goat" } },
        stream: [textDelta("hi"), finishEvent()],
      })
      try {
        await withEnvVars(
          { COMMANDCODE_PLAN: "go", COMMANDCODE_API_KEY: "k", COMMANDCODE_API_BASE: mock.url },
          async () => {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            await collect(provider.languageModel("claude-sonnet-5"), [
              { role: "user", content: "hi" },
            ])
            assertEqual(mock.hits.whoami, 0)
            assertEqual(mock.hits.subscriptions, 0)
            assertEqual(mock.hits.generate, 1)
            assertEqual(mock.hits.chatCompletions, 0)
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: planArg beats env — providerOptions plan go wins over COMMANDCODE_PLAN=goat",
    async () => {
      const mock = await startMockCc({
        stream: [textDelta("hi"), finishEvent()],
      })
      try {
        await withEnvVars(
          {
            COMMANDCODE_PLAN: "goat",
            COMMANDCODE_API_KEY: undefined,
            COMMANDCODE_API_BASE: undefined,
          },
          async () => {
            const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
            await collect(
              provider.languageModel("gpt-5.6-terra"),
              [{ role: "user", content: "hi" }],
              { commandcode: { plan: "go" } },
            )
            assertEqual(mock.hits.generate, 1)
            assertEqual(mock.hits.chatCompletions, 0)
            assertEqual(mock.hits.whoami, 0)
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: the inference fetch never asks for a plan, and an explicit go pin needs no network to route",
    async () => {
      await withEnvVars(
        {
          COMMANDCODE_PLAN: undefined,
          COMMANDCODE_API_KEY: "spy_key",
          COMMANDCODE_API_BASE: "https://api.commandcode.ai",
        },
        async () => {
          const seen: Array<{ url: string; headers: Record<string, string> }> = []
          const sse = (events: Array<Record<string, unknown>>): Response => {
            const body = new ReadableStream<Uint8Array>({
              start(c) {
                const enc = new TextEncoder()
                for (const evt of events) c.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`))
                c.enqueue(enc.encode("data: [DONE]\n\n"))
                c.close()
              },
            })
            return new Response(body, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            })
          }
          const fakeFetch: typeof fetch = async (input, init) => {
            const url = typeof input === "string" ? input : (input as URL).toString()
            seen.push({ url, headers: headersToRecord(init?.headers) })
            if (url.includes("/alpha/generate")) return sse([textDelta("hi"), finishEvent()])
            if (url.includes("/provider/v1/")) {
              return sse([openAIChunk("hi"), openAIFinishChunk()])
            }
            return new Response("not found", { status: 404 })
          }

          // No pin: Provider API, and no billing/whoami request to decide it.
          const provider = createCommandCode({ apiKey: "spy_key", fetch: fakeFetch })
          const model = provider.languageModel("gpt-5.6-terra")
          await collect(model, [{ role: "user", content: "hi" }])
          await collect(model, [{ role: "user", content: "hi" }])
          const inference = seen.filter((s) => s.url.includes("/provider/v1/chat/completions"))
          assertEqual(inference.length, 2, "provider transport chosen via spy")
          assert(!seen.some((s) => s.url.includes("/alpha/generate")), "no legacy traffic")
          assert(
            !seen.some((s) => s.url.includes("/alpha/whoami") || s.url.includes("/alpha/billing/")),
            "no plan lookup on the inference path",
          )

          // Explicit go pin: legacy, still with zero routing requests.
          const before = seen.length
          const legacyModel = createCommandCode({
            apiKey: "spy_key",
            fetch: fakeFetch,
          }).languageModel("gpt-5.6-terra")
          await collect(legacyModel, [{ role: "user", content: "hi" }], {
            commandcode: { plan: "go" },
          })
          const after = seen.slice(before)
          assertEqual(after.length, 1, "the pinned turn makes exactly one request")
          assert(after[0]!.url.includes("/alpha/generate"), "pinned go → legacy /alpha/generate")
          assertEqual(after[0]!.headers["authorization"], "Bearer spy_key")
        },
      )
    },
  ],
  [
    "transport: a mid-stream error event closes open parts before the error part (issue #72)",
    async () => {
      // The provider fails after it has already streamed reasoning. The
      // transport surfaces one error part and closes the stream, so the event
      // that carries the failure must first close every part the stream opened:
      // a consumer that keys parts by id (#69) must never be left holding an
      // open reasoning part.
      await withEnv("goat", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [
            { id: "gen_72", choices: [{ delta: { reasoning_content: "thinking" } }] },
            { error: { message: "upstream exploded", type: "server_error" } },
            eventsEnd,
          ],
          messagesStream: [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "pondering" },
            },
            { type: "error", error: { type: "overloaded_error", message: "upstream exploded" } },
            eventsEnd,
          ],
        })
        try {
          const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
          const openaiParts = await collect(provider.languageModel("gpt-5.6-terra"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(
            openaiParts.map((p) => p.type),
            ["reasoning-start", "reasoning-delta", "reasoning-end", "error"],
          )
          assertEqual((openaiParts[0] as { id: string }).id, "gen_72")
          assertEqual((openaiParts[2] as { id: string }).id, "gen_72")
          const openaiError = openaiParts[3]!.error as Error
          assert(openaiError.message.includes("upstream exploded"), openaiError.message)

          const anthropicParts = await collect(provider.languageModel("claude-sonnet-5"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(
            anthropicParts.map((p) => p.type),
            ["reasoning-start", "reasoning-delta", "reasoning-end", "error"],
          )
          assertEqual((anthropicParts[0] as { id: string }).id, "thinking-0")
          assertEqual((anthropicParts[2] as { id: string }).id, "thinking-0")
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    'transport: the legacy {"type":"abort"} terminal ends the stream cleanly (issue #170)',
    async () => {
      // The server aborted the generation: that is a terminal, not a
      // truncation. It carries no finish part of its own (upstream's consumer
      // checks `!finish && !abort`), so the transport must not fabricate one,
      // must not report a truncation, and must not replay the turn.
      const mock = await startMockCc({
        stream: [textDelta("half an ans"), { type: "abort" }, eventsEnd],
      })
      try {
        const provider = createCommandCode({
          apiKey: "test_key",
          baseURL: mock.url,
          maxRetries: 2,
          maxRetryDelayMs: 0,
        })
        const parts = await collect(
          provider.languageModel("claude-sonnet-5"),
          [{ role: "user", content: "hi" }],
          { commandcode: { plan: "go" } },
        )
        assertEqual(
          parts.map((p) => p.type),
          ["text-delta"],
        )
        assertEqual(mock.hits.generate, 1, "a clean abort is not retried")

        // The terminal ends the *read*, not just the turn: a server that keeps
        // the connection open after aborting must not hold the consumer to the
        // timeout. `timeout` is set low so a non-terminating read fails fast.
        const stalled = await startMockCc({
          stream: [textDelta("half an ans"), { type: "abort" }, "stall"],
        })
        try {
          const stalledParts = await collect(
            createCommandCode({
              apiKey: "test_key",
              baseURL: stalled.url,
              timeout: 500,
            }).languageModel("claude-sonnet-5"),
            [{ role: "user", content: "hi" }],
            { commandcode: { plan: "go" } },
          )
          assertEqual(
            stalledParts.map((p) => p.type),
            ["text-delta"],
          )
        } finally {
          await stalled.close()
        }
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: an opened text part already rules a retry replay out (issue #170)",
    async () => {
      // A bare text-start counts as visible, deliberately: part lifecycles
      // cannot be replayed either, so a re-request would append a second
      // text-start (and a second text-end) for the same id. The Anthropic
      // `content_block_start` is exactly that — a part opened before any delta.
      await withEnv("goat", async () => {
        let requests = 0
        const fetchImpl: typeof fetch = async () => {
          requests++
          return dyingSseResponse([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
          ])
        }
        const provider = createCommandCode({
          apiKey: "test_key",
          baseURL: "https://api.commandcode.ai",
          fetch: fetchImpl,
          maxRetries: 1,
          maxRetryDelayMs: 0,
        })
        const parts = await collect(provider.languageModel("claude-sonnet-5"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(requests, 1, "no re-request once a part was opened")
        assertEqual(
          parts.map((p) => p.type),
          ["text-start", "text-end", "error"],
        )
      })
    },
  ],
  [
    "transport: a mid-stream read failure after visible content is never replayed (issue #170)",
    async () => {
      // maxRetries > 0 must not re-run a request whose text the consumer has
      // already seen: the replay appends a second text-delta to the same part,
      // so the user reads FIRSTFIRST.
      await withEnv("goat", async () => {
        let requests = 0
        const fetchImpl: typeof fetch = async () => {
          requests++
          return dyingSseResponse([openAIChunk("FIRST")])
        }
        const provider = createCommandCode({
          apiKey: "test_key",
          baseURL: "https://api.commandcode.ai",
          fetch: fetchImpl,
          maxRetries: 2,
          maxRetryDelayMs: 0,
        })
        const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(requests, 1, "no re-request once content is visible")
        assertEqual(
          parts.map((p) => p.type),
          ["text-start", "text-delta", "text-end", "error"],
        )
        assertEqual(parts.filter((p) => p.type === "text-delta").length, 1)
        assertEqual((parts[1] as { delta: string }).delta, "FIRST")
        assert(
          ((parts[3] as { error: Error }).error as Error).message.includes("socket reset"),
          "the read failure is surfaced",
        )
      })
    },
  ],
  [
    "transport: a truncated stream with nothing visible is re-requested within the retry budget (issue #170)",
    async () => {
      // A clean truncation that delivered no parts yet is safe to replay: the
      // consumer saw nothing, so the retry only replaces a body that never
      // reached it. The first attempt serves an empty body, the second a
      // complete answer — the hit count proves the re-request happened.
      await withEnv("goat", async () => {
        let requests = 0
        const options: MockCcOptions = { chatCompletionsStream: [eventsEnd] }
        options.onChatCompletions = () => {
          requests++
          if (requests === 2) {
            options.chatCompletionsStream = [openAIChunk("hello"), openAIFinishChunk()]
          }
        }
        const mock = await startMockCc(options)
        try {
          const provider = createCommandCode({
            apiKey: "test_key",
            baseURL: mock.url,
            maxRetries: 1,
            maxRetryDelayMs: 0,
          })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(mock.hits.chatCompletions, 2)
          assertEqual(
            parts.map((p) => p.type),
            ["text-start", "text-delta", "text-end", "finish"],
          )
          assertEqual((parts[1] as { delta: string }).delta, "hello")
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "transport: doGenerate fails on a truncated body exactly as doStream does (issue #170)",
    async () => {
      await withEnv("goat", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [openAIChunk("half an ans"), eventsEnd],
        })
        try {
          const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
          let error: (Error & { status?: number }) | undefined
          try {
            await provider.languageModel("gpt-5.6-terra").doGenerate({
              prompt: [{ role: "user", content: "hi" }],
              mode: { type: "regular" },
            } as never)
          } catch (generateError: unknown) {
            error = generateError as Error & { status?: number }
          }
          assert(error, "doGenerate rejects a truncated body")
          assertEqual(error.name, "TruncatedStreamError")
          assertEqual(error.status, 502)
          assertEqual(error.message, TRUNCATION_MESSAGE)
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "transport: a legacy finish reporting other with no raw reason is a truncation, never a turn (issue #187)",
    async () => {
      // Upstream's own condition on the legacy terminal is `stopReason ===
      // "other" && rawFinishReason === undefined`: the response declared no
      // reason and ended without a turn, so it is retried while nothing is
      // visible and surfaced as a truncation after the budget — not reported as
      // a completed `other` turn, which OpenCode v2 fails anyway.
      const mock = await startMockCc({
        stream: [finishEvent({ finishReason: "other" })],
      })
      try {
        const provider = createCommandCode({
          apiKey: "test_key",
          baseURL: mock.url,
          maxRetries: 2,
          maxRetryDelayMs: 0,
        })
        const parts = await collect(
          provider.languageModel("gpt-5.6-terra"),
          [{ role: "user", content: "hi" }],
          { commandcode: { plan: "go" } },
        )
        assertEqual(mock.hits.generate, 3, "the truncation is replayed within the budget")
        assertEqual(
          parts.filter((p) => p.type === "finish"),
          [],
          "never a completed turn",
        )
        const failure = parts[parts.length - 1]!.error as Error & { status?: number }
        assertEqual(failure.message, TRUNCATION_MESSAGE)
        assertEqual(failure.status, 502)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a legacy finish reporting other with a raw reason still completes the turn (issue #187)",
    async () => {
      // The guard is only about a reason the wire never explained. A raw reason
      // beside `other` is the explanation, and the turn ends on it.
      const mock = await startMockCc({
        stream: [
          textDelta("an answer"),
          finishEvent({ finishReason: "other", rawFinishReason: "somewhere-else" }),
        ],
      })
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        const parts = await collect(
          provider.languageModel("gpt-5.6-terra"),
          [{ role: "user", content: "hi" }],
          { commandcode: { plan: "go" } },
        )
        assertEqual(mock.hits.generate, 1, "no replay: the turn ended")
        assertEqual(
          parts.map((p) => p.type),
          ["text-delta", "finish"],
        )
        assertEqual((parts[1] as { finishReason: unknown }).finishReason, {
          unified: "stop",
          raw: "somewhere-else",
        })
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a legacy connection-failure finish is replayed while nothing is visible (issue #187)",
    async () => {
      // `network` / `connection` / `upstream` + error is upstream's
      // `isNetworkFailureFinish`: the connection died mid-stream, so the turn is
      // a retryable transport failure rather than a completed one.
      const mock = await startMockCc({
        stream: [finishEvent({ finishReason: "upstream_error" })],
      })
      try {
        const provider = createCommandCode({
          apiKey: "test_key",
          baseURL: mock.url,
          maxRetries: 2,
          maxRetryDelayMs: 0,
        })
        const parts = await collect(
          provider.languageModel("gpt-5.6-terra"),
          [{ role: "user", content: "hi" }],
          { commandcode: { plan: "go" } },
        )
        assertEqual(mock.hits.generate, 3, "replayed within the budget")
        assertEqual(
          parts.filter((p) => p.type === "finish"),
          [],
          "never a completed turn",
        )
        const failure = parts[parts.length - 1]!.error as Error & { status?: number }
        assertEqual(
          failure.message,
          'Provider finished with reason "upstream_error" — upstream connection failed mid-stream',
        )
        assertEqual(failure.status, 502)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a legacy connection-failure finish after visible content is surfaced, never replayed (issue #187)",
    async () => {
      // Same failure, but the consumer has already seen the response's text: a
      // replay would duplicate it, so the failure is surfaced instead.
      const mock = await startMockCc({
        stream: [textDelta("half an ans"), finishEvent({ finishReason: "connection error" })],
      })
      try {
        const provider = createCommandCode({
          apiKey: "test_key",
          baseURL: mock.url,
          maxRetries: 2,
          maxRetryDelayMs: 0,
        })
        const parts = await collect(
          provider.languageModel("gpt-5.6-terra"),
          [{ role: "user", content: "hi" }],
          { commandcode: { plan: "go" } },
        )
        assertEqual(mock.hits.generate, 1, "no replay after visible content")
        assertEqual(
          parts.map((p) => p.type),
          ["text-delta", "error"],
        )
        const failure = parts[1]!.error as Error
        assert(failure.message.includes("upstream connection failed mid-stream"), failure.message)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a stream that ends without a finish event is truncated, and closes open parts first (issues #72, #170)",
    async () => {
      // A dropped connection is the other half of "failed mid-generation": the
      // body ended cleanly with no terminal event, so the turn is truncated —
      // never a synthesized finish that masks it as a successful stop (issue
      // #170) — and the parts the server never closed are closed before the
      // error part that ends the stream (issue #72).
      await withEnv("goat", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [
            { id: "gen_cut", choices: [{ delta: { content: "half an ans" } }] },
            eventsEnd,
          ],
          stream: [textDelta("half an ans"), eventsEnd],
        })
        try {
          const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(
            parts.map((p) => p.type),
            ["text-start", "text-delta", "text-end", "error"],
          )
          assertEqual((parts[0] as { id: string }).id, "gen_cut")
          assertEqual((parts[2] as { id: string }).id, "gen_cut")
          const truncation = parts[3]!.error as Error & { status?: number }
          assertEqual(truncation.message, TRUNCATION_MESSAGE)
          assertEqual(truncation.name, "TruncatedStreamError")
          assertEqual(truncation.status, 502)

          // The legacy /alpha/generate transport truncates identically: its
          // codec emits no text-start, and it has no open parts to close.
          const legacyParts = await collect(
            provider.languageModel("gpt-5.6-terra"),
            [{ role: "user", content: "hi" }],
            { commandcode: { plan: "go" } },
          )
          assertEqual(
            legacyParts.map((p) => p.type),
            ["text-delta", "error"],
          )
          assertEqual((legacyParts[1]!.error as Error).message, TRUNCATION_MESSAGE)
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "transport: a finish without its usage chunk fails the turn instead of reporting zeros (issues #170, #171)",
    async () => {
      // #170 accepted a close between the OpenAI finish_reason chunk and its
      // separate trailing usage-only chunk as a complete turn and surfaced the
      // held finish with zeroed usage. #171 reverses that: the held finish was
      // synthesized — the wire never reported the turn's usage — so emitting it
      // claims a complete, zero-cost turn for a stream that never said what it
      // spent. The failure is raised instead, as a truncation (retryable while
      // nothing is visible; here the text was already consumed, so it surfaces
      // as the error part).
      await withEnv("goat", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [
            openAIChunk("hello"),
            { id: "chatcmpl-test", choices: [{ delta: {}, finish_reason: "stop" }] },
            eventsEnd,
          ],
        })
        try {
          const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
            { role: "user", content: "hi" },
          ])
          assertEqual(
            parts.map((p) => p.type),
            ["text-start", "text-delta", "text-end", "error"],
          )
          const failure = parts[3]!.error as Error & { status?: number }
          assertEqual(failure.name, "MissingUsageError")
          assertEqual(failure.status, 502)
          assert(failure.message.includes("usage report"), failure.message)
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "transport: abort mid-reasoning closes the open part before the aborted error part (issue #72)",
    async () => {
      await withEnv("goat", async () => {
        const mock = await startMockCc({
          chatCompletionsStream: [
            { id: "gen_abort", choices: [{ delta: { reasoning_content: "thinking" } }] },
            "stall",
          ],
        })
        try {
          const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
          const controller = new AbortController()
          const result = await provider.languageModel("gpt-5.6-terra").doStream({
            prompt: [{ role: "user", content: "hi" }],
            mode: { type: "regular" },
            abortSignal: controller.signal,
          } as never)
          const parts: Array<Record<string, unknown>> = []
          const reader = result.stream.getReader()
          parts.push((await reader.read()).value as Record<string, unknown>)
          parts.push((await reader.read()).value as Record<string, unknown>)
          controller.abort()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value as unknown as Record<string, unknown>)
          }
          assertEqual(
            parts.map((p) => p.type),
            ["reasoning-start", "reasoning-delta", "reasoning-end", "error"],
          )
          assertEqual((parts[2] as { id: string }).id, "gen_abort")
          const abortErrorPart = parts[3]!.error as Error
          assertEqual(abortErrorPart.message, "The operation was aborted")
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "transport: a legacy continuation re-POSTs byte-identical bytes, with headers rebuilt per request (issue #185)",
    async () => {
      // The request builder the transport asks for every pass is what lets a
      // continuation vary its body — and the legacy transport uses that seam to
      // keep sending exactly what it always sent: the body frozen once for the
      // call, byte for byte. The headers are the other half: they are built by
      // the same call, so a credential rotated between the two requests is
      // still picked up.
      await withEnvVars({ COMMANDCODE_API_KEY: "credential-one" }, async () => {
        const rawBodies: string[] = []
        const authorizations: string[] = []
        const options = pausedLegacyTurn()
        const advanceTurn = options.onGenerate!
        options.onGenerate = (body, headers, rawBody) => {
          advanceTurn(body, headers, rawBody)
          rawBodies.push(rawBody)
          authorizations.push(headers.authorization ?? "")
          if (rawBodies.length === 1) process.env.COMMANDCODE_API_KEY = "credential-two"
        }
        const mock = await startMockCc(options)
        try {
          // No apiKey option: the credential comes from the environment, which
          // is exactly what can change under a running session.
          const provider = createCommandCode({ baseURL: mock.url })
          const parts = await collect(
            provider.languageModel("gpt-5.6-terra"),
            [{ role: "user", content: "hi" }],
            { commandcode: { plan: "go" } },
          )
          assertEqual(mock.hits.generate, 2, "the pause is continued once")
          assertEqual(rawBodies.length, 2, "one body per request")
          assertEqual(
            rawBodies[1],
            rawBodies[0],
            "the continuation re-POSTs the first request's bytes",
          )
          assertEqual(authorizations, ["Bearer credential-one", "Bearer credential-two"])
          assertEqual(
            parts.map((p) => p.type),
            ["text-delta", "text-delta", "finish"],
          )
        } finally {
          await mock.close()
        }
      })
    },
  ],
  [
    "transport: a paused legacy turn re-POSTs the body and sums its continuations' usage (issue #172)",
    async () => {
      // Upstream `command-code@1.54.0` loops on `rawFinishReason === "pause_turn"`
      // (Ph = 5), re-POSTs the same body, and folds every continuation's usage
      // with `addUsage2` — the only place upstream sums usage. The resumed turn
      // is one stream: the pause never surfaces as a finish, and the single
      // finish reports the sum.
      const mock = await startMockCc(pausedLegacyTurn())
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        const parts = await collect(
          provider.languageModel("gpt-5.6-terra"),
          [{ role: "user", content: "hi" }],
          { commandcode: { plan: "go" } },
        )
        assertEqual(mock.hits.generate, 2, "the pause is continued once")
        assertEqual(mock.hits.chatCompletions, 0)
        assertEqual(
          parts.map((p) => p.type),
          ["text-delta", "text-delta", "finish"],
          "one continuous turn, one finish",
        )
        assertEqual((parts[0] as { delta: string }).delta, "first ")
        assertEqual((parts[1] as { delta: string }).delta, "second")
        const finish = parts[2] as {
          finishReason: unknown
          usage: { inputTokens: { total: number }; outputTokens: { total: number } }
        }
        assertEqual(finish.finishReason, { unified: "stop", raw: "end_turn" })
        assertEqual(finish.usage.inputTokens.total, 13)
        assertEqual(finish.usage.outputTokens.total, 9)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: an OpenAI pause_turn chunk continues the turn on the same stream (issue #172)",
    async () => {
      // The Provider API's OpenAI shape reports the pause as a `finish_reason`
      // on the last content chunk, with the real usage on the trailing
      // usage-only chunk. The continuation's parts follow the paused response's
      // parts on the same stream, each with its own lifecycle: the pause is a
      // boundary inside the turn, not the end of it.
      let requests = 0
      const options: MockCcOptions = {
        chatCompletionsStream: [
          openAIChunk("first ", { id: "chatcmpl-1" }),
          { id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "pause_turn" }] },
          { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
        ],
      }
      options.onChatCompletions = () => {
        requests++
        if (requests === 2) {
          options.chatCompletionsStream = [
            openAIChunk("second", { id: "chatcmpl-2" }),
            {
              id: "chatcmpl-2",
              choices: [{ delta: {}, finish_reason: "end_turn" }],
              usage: { prompt_tokens: 3, completion_tokens: 5 },
            },
          ]
        }
      }
      const mock = await startMockCc(options)
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(mock.hits.chatCompletions, 2, "the pause is continued once")
        assertEqual(
          parts.map((p) => p.type),
          [
            "text-start",
            "text-delta",
            "text-end",
            "text-start",
            "text-delta",
            "text-end",
            "finish",
          ],
        )
        assertEqual((parts[0] as { id: string }).id, "chatcmpl-1")
        assertEqual((parts[3] as { id: string }).id, "chatcmpl-2")
        const finish = parts[6] as {
          finishReason: unknown
          usage: { inputTokens: { total: number }; outputTokens: { total: number } }
        }
        assertEqual(finish.finishReason, { unified: "stop", raw: "end_turn" })
        assertEqual(finish.usage.inputTokens.total, 13)
        assertEqual(finish.usage.outputTokens.total, 9)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: an Anthropic pause_turn stop reason continues the turn on the same stream (issue #172)",
    async () => {
      // The Anthropic shape reports the pause on `message_delta`'s stop_reason
      // with the response's usage beside it. The resumed turn is one stream and
      // one finish; the continuation opens its own content block, since the
      // paused response closed the block it wrote.
      const block = (text: string, stopReason: string, usage: Record<string, unknown>) => [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        anthropicContentBlockDelta(text),
        { type: "content_block_stop", index: 0 },
        anthropicMessageDelta(usage, stopReason),
      ]
      let requests = 0
      const options: MockCcOptions = {
        messagesStream: block("first ", "pause_turn", { input_tokens: 10, output_tokens: 4 }),
      }
      options.onMessages = () => {
        requests++
        if (requests === 2) {
          options.messagesStream = block("second", "end_turn", {
            input_tokens: 3,
            output_tokens: 5,
          })
        }
      }
      const mock = await startMockCc(options)
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        const parts = await collect(provider.languageModel("claude-sonnet-5"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(mock.hits.messages, 2, "the pause is continued once")
        assertEqual(mock.hits.chatCompletions, 0)
        assertEqual(
          parts.map((p) => p.type),
          [
            "text-start",
            "text-delta",
            "text-end",
            "text-start",
            "text-delta",
            "text-end",
            "finish",
          ],
        )
        assertEqual((parts[1] as { delta: string }).delta, "first ")
        assertEqual((parts[4] as { delta: string }).delta, "second")
        const finish = parts[6] as {
          finishReason: unknown
          usage: { inputTokens: { total: number }; outputTokens: { total: number } }
        }
        assertEqual(finish.finishReason, { unified: "stop", raw: "end_turn" })
        assertEqual(finish.usage.inputTokens.total, 13)
        assertEqual(finish.usage.outputTokens.total, 9)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a turn that keeps pausing stops at five continuations and fails loudly (issue #172)",
    async () => {
      // Upstream's bound is `Ph = 5` — the first request plus five
      // continuations — and it carries the last raw finish reason out. A turn
      // still paused there is not an ending: the transport fails it instead of
      // reporting `finish{other, pause_turn}` as a completed turn. The bound is
      // not transient either, so the retry ladder spends nothing on it.
      const options: MockCcOptions = {
        chatCompletionsStream: [
          openAIChunk("again ", { id: "chatcmpl-loop" }),
          { id: "chatcmpl-loop", choices: [{ delta: {}, finish_reason: "pause_turn" }] },
          { id: "chatcmpl-loop", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        ],
      }
      const mock = await startMockCc(options)
      try {
        const provider = createCommandCode({
          apiKey: "test_key",
          baseURL: mock.url,
          maxRetries: 2,
          maxRetryDelayMs: 0,
        })
        const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(mock.hits.chatCompletions, 6, "the first request plus five continuations")
        assertEqual(
          parts.filter((p) => p.type === "finish"),
          [],
          "a pause never surfaces as a finish",
        )
        assertEqual(parts.filter((p) => p.type === "text-delta").length, 6)
        const failure = parts[parts.length - 1]!.error as Error & { status?: number }
        assertEqual(failure.name, "PauseTurnLimitError")
        assert(failure.message.includes("pause_turn"), failure.message)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a retried continuation does not double-count the attempt it replaces (issue #172)",
    async () => {
      // Usage is summed across continuations only: upstream's `addUsage2` runs
      // once per completed response. A continuation whose finish was
      // synthesized — its usage chunk never arrived — is not a completed
      // response: it is retried while nothing is visible, and only the retry's
      // reported usage joins the sum.
      let requests = 0
      const options: MockCcOptions = {
        chatCompletionsStream: [
          openAIChunk("first ", { id: "chatcmpl-1" }),
          { id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "pause_turn" }] },
          { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
        ],
      }
      options.onChatCompletions = () => {
        requests++
        if (requests === 2) {
          options.chatCompletionsStream = [
            { id: "chatcmpl-2", choices: [{ delta: {}, finish_reason: "end_turn" }] },
          ]
        }
        if (requests === 3) {
          options.chatCompletionsStream = [
            openAIChunk("second", { id: "chatcmpl-3" }),
            {
              id: "chatcmpl-3",
              choices: [{ delta: {}, finish_reason: "end_turn" }],
              usage: { prompt_tokens: 3, completion_tokens: 5 },
            },
          ]
        }
      }
      const mock = await startMockCc(options)
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(mock.hits.chatCompletions, 3, "the usage-less continuation is replayed once")
        const finish = parts[parts.length - 1] as {
          type: string
          usage: { inputTokens: { total: number }; outputTokens: { total: number } }
        }
        assertEqual(finish.type, "finish")
        assertEqual(finish.usage.inputTokens.total, 13)
        assertEqual(finish.usage.outputTokens.total, 9)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a pause whose usage never arrived fails the turn instead of continuing it (issues #171, #172)",
    async () => {
      // A pause finish the codec had to synthesize — the OpenAI `finish_reason`
      // chunk whose trailing usage-only chunk never arrived — says nothing
      // about what the response it ended spent, so the sum a resumed turn must
      // report cannot be known. The #171 rule runs first: the response is not a
      // completed one, and the turn fails rather than continuing with a segment
      // billed as zero.
      const options: MockCcOptions = {
        chatCompletionsStream: [
          openAIChunk("first ", { id: "chatcmpl-1" }),
          { id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "pause_turn" }] },
        ],
      }
      const mock = await startMockCc(options)
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        const parts = await collect(provider.languageModel("gpt-5.6-terra"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(mock.hits.chatCompletions, 1, "no continuation is attempted")
        assertEqual(
          parts.filter((p) => p.type === "finish"),
          [],
          "no finish is reported",
        )
        const failure = parts[parts.length - 1]!.error as Error & { status?: number }
        assertEqual(failure.name, "MissingUsageError")
        assertEqual(failure.status, 502)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: doGenerate resumes a paused turn exactly as doStream does (issue #172)",
    async () => {
      const mock = await startMockCc(pausedLegacyTurn())
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        const result = await provider.languageModel("gpt-5.6-terra").doGenerate({
          prompt: [{ role: "user", content: "hi" }],
          mode: { type: "regular" },
          providerOptions: { commandcode: { plan: "go" } },
        } as never)
        assertEqual(mock.hits.generate, 2, "the pause is continued once")
        assertEqual(result.content, [{ type: "text", text: "first second" }])
        assertEqual(result.finishReason, { unified: "stop", raw: "end_turn" })
        assertEqual(result.usage.inputTokens.total, 13)
        assertEqual(result.usage.outputTokens.total, 9)
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a paused response's open part is closed before the continuation opens its own (issue #172)",
    async () => {
      // The paused response's text block never got its `content_block_stop` (a
      // server that flushes mid-block). The continuation opens its own block at
      // the same index, so the part the pause left open is closed first — a
      // second `text-start` for a part that never ended would orphan it.
      let requests = 0
      const options: MockCcOptions = {
        messagesStream: [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          anthropicContentBlockDelta("first "),
          anthropicMessageDelta({ input_tokens: 10, output_tokens: 4 }, "pause_turn"),
        ],
      }
      options.onMessages = () => {
        requests++
        if (requests === 2) {
          options.messagesStream = [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            anthropicContentBlockDelta("second"),
            { type: "content_block_stop", index: 0 },
            anthropicMessageDelta({ input_tokens: 3, output_tokens: 5 }),
          ]
        }
      }
      const mock = await startMockCc(options)
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        const parts = await collect(provider.languageModel("claude-sonnet-5"), [
          { role: "user", content: "hi" },
        ])
        assertEqual(mock.hits.messages, 2)
        assertEqual(
          parts.map((p) => p.type),
          [
            "text-start",
            "text-delta",
            "text-end",
            "text-start",
            "text-delta",
            "text-end",
            "finish",
          ],
        )
        assertEqual((parts[2] as { id: string }).id, "text-0")
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: a plan-gate 403 after a continuation is surfaced, never replayed on legacy (issue #172)",
    async () => {
      // The flip re-runs the whole call from the start, so it is safe only
      // while the consumer has seen nothing. A 403 arriving after a paused
      // turn's continuation would append a second copy of the turn to the same
      // stream; the failure surfaces instead — and the session is still pinned
      // to legacy for the turns that follow.
      let requests = 0
      const options: MockCcOptions = {
        chatCompletionsStream: [
          openAIChunk("first ", { id: "chatcmpl-1" }),
          { id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "pause_turn" }] },
          { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
        ],
        stream: [textDelta("later"), finishEvent()],
      }
      options.onChatCompletions = () => {
        requests++
        if (requests === 2) {
          options.chatCompletionsStatus = 403
          options.chatCompletionsErrorBody = upgradeRequiredBody()
        }
      }
      const mock = await startMockCc(options)
      try {
        const provider = createCommandCode({ apiKey: "test_key", baseURL: mock.url })
        // One model instance: the pin lives on it, so the second turn is where
        // the unconditional pin is observable.
        const model = provider.languageModel("gpt-5.6-terra")
        const parts = await collect(model, [{ role: "user", content: "hi" }])
        assertEqual(mock.hits.chatCompletions, 2)
        assertEqual(mock.hits.generate, 0, "the mid-turn flip is skipped")
        assertEqual(parts.filter((p) => p.type === "text-delta").length, 1, "no duplicated turn")
        const failure = parts[parts.length - 1]!.error as Error
        assert(failure.message.includes("plan upgrade"), failure.message)

        // The pin is unconditional: the next turn starts on legacy without
        // touching the Provider API again.
        const next = await collect(model, [{ role: "user", content: "hi" }])
        assertEqual(mock.hits.generate, 1)
        assertEqual(mock.hits.chatCompletions, 2)
        assertEqual(
          next.map((p) => p.type),
          ["text-delta", "finish"],
        )
      } finally {
        await mock.close()
      }
    },
  ],
])
