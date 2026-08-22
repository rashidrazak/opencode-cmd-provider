// tests/provider-transport.test.ts — Provider transport with per-model routing behind explicit plan override (issue #53)
// Verifies documented Provider API: POST /provider/v1/messages for claude-*, POST /provider/v1/chat/completions otherwise,
// both with stream:true, Authorization: Bearer, baseURL via getApiBase/COMMANDCODE_API_BASE, incremental deltas + terminal usage→finish
import { createCommandCode } from "../src/provider/index.js"
import {
  startMockCc,
  anthropicContentBlockDelta,
  anthropicMessageDelta,
  openAIChunk,
  openAIFinishChunk,
  textDelta,
  finishEvent,
} from "./helpers/mock-cc.js"
import type { LanguageModelV3Prompt } from "../src/provider/aisdk-types.js"
import { assert, assertEqual, run } from "./harness.js"
import { calculateCommandCodeCost, costUsageFromAiSdkUsage } from "../src/provider/cost.js"

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

/** Sets/clears COMMANDCODE_* env vars for the duration of fn, restoring after. */
function withEnvVars(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const prev = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const p = Promise.resolve().then(() => fn() as unknown as Promise<void>)
  return p.finally(() => {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function withEnv(plan: string | undefined, fn: () => Promise<void> | void): Promise<void> {
  return withEnvVars({ COMMANDCODE_PLAN: plan }, fn)
}

function withBaseEnv(base: string | undefined, fn: () => Promise<void> | void): Promise<void> {
  return withEnvVars({ COMMANDCODE_API_BASE: base }, fn)
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
          // cost path
          const cu = costUsageFromAiSdkUsage(finish.usage as never)
          calculateCommandCodeCost(
            { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
            cu,
          )
          assert(cu.cost.total > 0, "cost calculated")
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
    "provider routing: no plan defaults to Provider API (default-flip, issue #54)",
    async () => {
      // scrub plan/key/base env so the resolution is exactly: no override →
      // key present (model option) → whoami 404 → default Provider API
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
              assertEqual(mock.hits.whoami, 1) // whoami 404 (unset) → falls to Provider
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
            const cu = costUsageFromAiSdkUsage(finish.usage as never)
            calculateCommandCodeCost(
              { cost: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 1 } },
              cu,
            )
            assert(cu.cost.total > 0, "openai cost positive")
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
            const cu = costUsageFromAiSdkUsage(finish.usage as never)
            calculateCommandCodeCost(
              { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
              cu,
            )
            assert(cu.cost.total > 0, "anthropic cost positive")
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
        const cu = costUsageFromAiSdkUsage(finish.usage as never)
        calculateCommandCodeCost(
          { cost: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 1 } },
          cu,
        )
        assert(cu.cost.total > 0, "split-usage-chunk cost positive")
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "provider: doGenerate non-streaming returns same content/usage/cost as doStream aggregated",
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
            const cu1 = costUsageFromAiSdkUsage(genUsage as never)
            const cu2 = costUsageFromAiSdkUsage(streamFinish.usage as never)
            calculateCommandCodeCost(
              { cost: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 1 } },
              cu1,
            )
            calculateCommandCodeCost(
              { cost: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 1 } },
              cu2,
            )
            assertEqual(cu1.cost.total, cu2.cost.total)
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
    "transport: whoami goat selects Provider API via cached GET /alpha/whoami (issue #54)",
    async () => {
      let whoamiHeaders: Record<string, string> | undefined
      const mock = await startMockCc({
        whoami: { planId: "goat" },
        chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
        onWhoami: (headers) => {
          whoamiHeaders = headers
        },
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
            assertEqual(mock.hits.whoami, 1)
            assertEqual(mock.hits.chatCompletions, 1)
            assertEqual(mock.hits.generate, 0)
            assertEqual(mock.hits.messages, 0)
            assert(whoamiHeaders, "whoami headers captured")
            assertEqual(whoamiHeaders!["authorization"], "Bearer test_key")
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: whoami says go selects legacy /alpha/generate",
    async () => {
      const mock = await startMockCc({
        whoami: { planId: "go" },
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
            assertEqual(mock.hits.whoami, 1)
            assertEqual(mock.hits.generate, 1)
            assertEqual(mock.hits.chatCompletions, 0)
            assertEqual(mock.hits.messages, 0)
            assert(
              parts.some((p) => p.type === "text-delta"),
              "legacy delta emitted",
            )
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: non-go whoami plans (pro/max/max20/teampro/provider) all select Provider API",
    async () => {
      for (const planId of ["pro", "max", "max20", "teampro", "provider"]) {
        const mock = await startMockCc({
          whoami: { planId },
          chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
        })
        try {
          await withEnvVars(
            {
              COMMANDCODE_PLAN: undefined,
              COMMANDCODE_API_KEY: "k",
              COMMANDCODE_API_BASE: mock.url,
            },
            async () => {
              const provider = createCommandCode({ apiKey: "k", baseURL: mock.url })
              await collect(provider.languageModel("gpt-5.6-terra"), [
                { role: "user", content: "hi" },
              ])
              assertEqual(mock.hits.chatCompletions, 1, `whoami ${planId} → chat/completions`)
              assertEqual(mock.hits.generate, 0, `whoami ${planId} no /alpha/generate`)
            },
          )
        } finally {
          await mock.close()
        }
      }
    },
  ],
  [
    "transport: whoami fetched at most once per model instance (two turns → one fetch)",
    async () => {
      const mock = await startMockCc({
        whoami: { planId: "goat" },
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
            assertEqual(mock.hits.whoami, 1)
            assertEqual(mock.hits.chatCompletions, 2)
            assertEqual(mock.hits.generate, 0)
          },
        )
      } finally {
        await mock.close()
      }
    },
  ],
  [
    "transport: non-OK whoami (500) falls through to Provider API — not go",
    async () => {
      const mock = await startMockCc({
        whoamiStatus: 500,
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
            assertEqual(mock.hits.whoami, 1)
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
    "transport: whoami non-OK via model base falls through to Provider — not go (doStream + doGenerate)",
    async () => {
      const mock = await startMockCc({
        chatCompletionsStream: [openAIChunk("hi"), openAIFinishChunk()],
      })
      try {
        await withEnvVars(
          {
            COMMANDCODE_PLAN: undefined,
            COMMANDCODE_API_KEY: "k",
            // env base is unreachable, but the model's baseURL option wins for
            // whoami too, so the fetch reaches the mock (which serves 404)
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
            // two model instances (doStream + doGenerate) → two whoami attempts,
            // both 404 → Provider transport
            assertEqual(mock.hits.whoami, 2)
            assertEqual(mock.hits.chatCompletions, 2)
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
    "transport: COMMANDCODE_PLAN=go env beats whoami — no whoami fetch, legacy transport",
    async () => {
      const mock = await startMockCc({
        whoami: { planId: "goat" },
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
    "transport: fetch spy observes whoami and transport choice (issue #54)",
    async () => {
      await withEnvVars(
        {
          COMMANDCODE_PLAN: undefined,
          COMMANDCODE_API_KEY: "spy_key",
          // no baseURL option on the model: whoami URL comes from getApiBase(env)
          COMMANDCODE_API_BASE: "https://api.commandcode.ai",
        },
        async () => {
          const seen: Array<{ url: string; headers: Record<string, string> }> = []
          const fakeFetch: typeof fetch = async (input, init) => {
            const url = typeof input === "string" ? input : (input as URL).toString()
            seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
            if (url.includes("/alpha/whoami")) {
              return new Response(JSON.stringify({ planId: "goat" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            }
            const body = new ReadableStream<Uint8Array>({
              start(c) {
                const enc = new TextEncoder()
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
          const provider = createCommandCode({ apiKey: "spy_key", fetch: fakeFetch })
          const model = provider.languageModel("gpt-5.6-terra")
          await collect(model, [{ role: "user", content: "hi" }])
          await collect(model, [{ role: "user", content: "hi" }])
          const whoamiCalls = seen.filter((s) => s.url.includes("/alpha/whoami"))
          assertEqual(whoamiCalls.length, 1, "whoami observed exactly once across two turns")
          assertEqual(whoamiCalls[0].url, "https://api.commandcode.ai/alpha/whoami")
          assertEqual(whoamiCalls[0].headers["authorization"], "Bearer spy_key")
          const inference = seen.filter((s) => s.url.includes("/provider/v1/chat/completions"))
          assertEqual(inference.length, 2, "provider transport chosen via spy")
          assert(!seen.some((s) => s.url.includes("/alpha/generate")), "no legacy traffic")
        },
      )
    },
  ],
])
