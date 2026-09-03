// tests/provider-parity.test.ts — issue #55
// Go legacy preservation + non-Go zero-leak + shared-layer parity
//
// Proves at the LanguageModel seam (doStream/doGenerate with fetch spies):
//   1. Go-plan traffic stays byte-for-byte on the pre-51 /alpha/generate wire
//      format (golden captured from the 6df7653 baseline; volatile fields
//      normalized) — both doStream and doGenerate.
//   2. Non-Go sessions never emit /alpha/generate (whole-session fetch spy).
//   3. Shared layers — tools, images, system prompt, max_tokens, reasoning,
//      cost, redaction, retry/timeout/abort — behave identically on both
//      transports (legacy /alpha/generate vs Provider API /provider/v1/*).
import { createCommandCode } from "../src/provider/index.js"
import {
  anthropicContentBlockDelta,
  anthropicMessageDelta,
  finishEvent,
  openAIChunk,
  openAIFinishChunk,
  textDelta,
  toolCall,
} from "./helpers/mock-cc.js"
import { assert, assertEqual, rejects, run } from "./harness.js"
import { calculateCommandCodeCost, costUsageFromAiSdkUsage } from "../src/provider/cost.js"
import { MODEL_COSTS } from "../src/provider/pricing.js"
import { MODEL_EFFORTS } from "../src/provider/reasoning.js"
import { assert } from "./harness.js"

type Model = ReturnType<ReturnType<typeof createCommandCode>["languageModel"]>

interface SpyCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function sseResponse(events: Array<Record<string, unknown> | "end">): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        if (evt === "end") break
        controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function makeSpy(handler: (call: SpyCall) => Response): { fetch: typeof fetch; calls: SpyCall[] } {
  const calls: SpyCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString()
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    const call: SpyCall = { url, method: (init?.method ?? "GET") as string, headers, body }
    calls.push(call)
    return handler(call)
  }
  return { fetch: fetchImpl, calls }
}

/** Routes Provider API + whoami URLs to their configured SSE streams. */
function providerHandler(
  openAIEvents: Array<Record<string, unknown> | "end">,
  anthropicEvents: Array<Record<string, unknown> | "end">,
): (call: SpyCall) => Response {
  return (call) => {
    if (call.url.includes("/alpha/whoami")) return new Response("not found", { status: 404 })
    if (call.url.includes("/provider/v1/chat/completions")) return sseResponse(openAIEvents)
    if (call.url.includes("/provider/v1/messages")) return sseResponse(anthropicEvents)
    return new Response("not found", { status: 404 })
  }
}

async function collect(
  model: Model,
  options: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const result = await model.doStream({
    mode: { type: "regular" },
    ...options,
  } as never)
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

// --- Legacy wire-format golden (issue #55 acceptance 1) ---
//
// Captured once from the pre-51 baseline (6df7653, release 1.2.2) by running
// the baseline CommandCodeLanguageModel against a fetch spy with the exact
// input below; volatile fields (config.date, config.workingDir,
// config.environment, threadId, x-project-slug) are normalized to
// placeholders. `normalizeLegacyCall` reproduces the normalization on the
// live capture, so assertEqual below is a byte-for-byte comparison of the
// wire format pre-51 vs now.
const LEGACY_INPUT_TOOLS = [
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
] as never

const LEGACY_GOLDEN = {
  url: "https://api.commandcode.ai/alpha/generate",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer user_test",
    "x-command-code-version": "1.15.1",
    "x-cli-environment": "production",
    "x-project-slug": "<slug>",
    "x-taste-learning": "true",
    "x-co-flag": "false",
  },
  body: {
    config: {
      workingDir: "<cwd>",
      date: "<date>",
      environment: "<env>",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      system: "You are a test.",
      max_tokens: 1000,
      temperature: 0.3,
      stream: true,
    },
    threadId: "<uuid>",
  },
}

function normalizeLegacyCall(call: SpyCall): unknown {
  const body = call.body as Record<string, unknown>
  const config = body.config as Record<string, unknown>
  config.date = "<date>"
  config.workingDir = "<cwd>"
  config.environment = "<env>"
  body.threadId = "<uuid>"
  const headers = { ...call.headers }
  headers["x-project-slug"] = "<slug>"
  return { url: call.url, method: call.method, headers, body }
}

async function captureLegacyCall(): Promise<{
  call: SpyCall
  parts: Array<Record<string, unknown>>
}> {
  const { fetch, calls } = makeSpy(() => sseResponse([finishEvent()]))
  const provider = createCommandCode({
    apiKey: "user_test",
    baseURL: "https://api.commandcode.ai",
    fetch,
    plan: "go",
  })
  const parts = await collect(provider.languageModel("claude-sonnet-5"), {
    prompt: [
      { role: "system", content: "You are a test." },
      { role: "user", content: "hi" },
    ],
    maxOutputTokens: 1000,
    tools: LEGACY_INPUT_TOOLS,
  })
  const call = calls.find((c) => c.method === "POST")!
  return { call, parts }
}

// --- Shared fixtures ---

const toolDefs = [
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
] as never

const expectedToolParts = [
  { type: "tool-input-start", id: "t1", toolName: "read" },
  { type: "tool-input-delta", id: "t1", delta: '{"path":"a.ts"}' },
  { type: "tool-input-end", id: "t1" },
  { type: "tool-call", toolCallId: "t1", toolName: "read", input: '{"path":"a.ts"}' },
]

const IMAGE_PROMPT = [
  {
    role: "user",
    content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png" }],
  },
] as never

const SYSTEM_PROMPT = [
  { role: "system", content: "You are a test." },
  { role: "user", content: "hi" },
] as never

run([
  // --- Acceptance 1: Go legacy preservation, byte-for-byte vs pre-51 ---
  [
    "legacy: doStream /alpha/generate wire format is byte-for-byte unchanged vs pre-51",
    async () => {
      const { call, parts } = await captureLegacyCall()
      assertEqual(normalizeLegacyCall(call), LEGACY_GOLDEN)
      // Exact top-level wire keys and header set.
      assertEqual(Object.keys(call.body as object).sort(), [
        "config",
        "memory",
        "params",
        "skills",
        "taste",
        "threadId",
      ])
      assertEqual(Object.keys(call.headers).sort(), [
        "Authorization",
        "Content-Type",
        "x-cli-environment",
        "x-co-flag",
        "x-command-code-version",
        "x-project-slug",
        "x-taste-learning",
      ])
      assert(
        parts.some((p) => p.type === "finish"),
        "stream completed",
      )
    },
  ],
  [
    "legacy: doGenerate emits the same /alpha/generate wire format",
    async () => {
      const { fetch, calls } = makeSpy(() => sseResponse([finishEvent()]))
      const model = createCommandCode({
        apiKey: "user_test",
        baseURL: "https://api.commandcode.ai",
        fetch,
        plan: "go",
      }).languageModel("claude-sonnet-5")
      const result = await model.doGenerate({
        prompt: [
          { role: "system", content: "You are a test." },
          { role: "user", content: "hi" },
        ],
        mode: { type: "regular" },
        maxOutputTokens: 1000,
        tools: LEGACY_INPUT_TOOLS,
      } as never)
      const call = calls.find((c) => c.method === "POST")!
      assertEqual(normalizeLegacyCall(call), LEGACY_GOLDEN)
      assertEqual(result.finishReason, { unified: "stop", raw: "stop" })
    },
  ],

  // --- Acceptance 2: non-Go zero /alpha/generate traffic ---
  [
    "non-Go session: zero /alpha/generate traffic across turns, models and doGenerate",
    async () => {
      await withEnvVars(
        {
          COMMANDCODE_PLAN: "goat",
          COMMANDCODE_API_KEY: undefined,
          COMMANDCODE_API_BASE: undefined,
        },
        async () => {
          const { fetch, calls } = makeSpy(
            providerHandler(
              [openAIChunk("hi"), openAIFinishChunk()],
              [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
            ),
          )
          const provider = createCommandCode({
            apiKey: "k",
            baseURL: "https://api.commandcode.ai",
            fetch,
          })
          // Two turns on the same OpenAI-route model.
          await collect(provider.languageModel("gpt-5.6-terra"), {
            prompt: [{ role: "user", content: "hi" }],
          })
          await collect(provider.languageModel("gpt-5.6-terra"), {
            prompt: [{ role: "user", content: "hi" }],
          })
          // One Anthropic-route model.
          await collect(provider.languageModel("claude-sonnet-5"), {
            prompt: [{ role: "user", content: "hi" }],
          })
          // Non-streaming doGenerate (separate instance).
          await provider.languageModel("gpt-5.6-terra").doGenerate({
            prompt: [{ role: "user", content: "hi" }],
            mode: { type: "regular" },
          } as never)
          const inference = calls.filter((c) => c.method === "POST")
          assertEqual(
            inference.filter((c) => c.url.includes("/alpha/generate")).length,
            0,
            "zero /alpha/generate in the whole session",
          )
          assertEqual(
            inference.filter((c) => c.url.includes("/provider/v1/chat/completions")).length,
            3,
          )
          assertEqual(inference.filter((c) => c.url.includes("/provider/v1/messages")).length, 1)
          assertEqual(
            calls.filter((c) => c.url.includes("/alpha/whoami")).length,
            0,
            "explicit override short-circuits whoami",
          )
        },
      )
    },
  ],

  // --- Acceptance 3: shared-layer parity ---
  [
    "parity: tool definitions are schema-identical on all three transports",
    async () => {
      // legacy
      {
        const { fetch, calls } = makeSpy((call) => {
          if (call.url.includes("/alpha/generate")) return sseResponse([finishEvent()])
          return new Response("not found", { status: 404 })
        })
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "go" })
        await collect(provider.languageModel("claude-sonnet-5"), {
          prompt: [{ role: "user", content: "use a tool" }],
          tools: toolDefs,
        })
        const body = calls[0].body as { params: { tools: unknown[] } }
        const tools = body.params.tools as Array<Record<string, unknown>>
        assertEqual(tools.length, 1)
        assertEqual(tools[0].type, "function")
        assertEqual(tools[0].name, "read")
        assertEqual(tools[0].description, "Read a file")
        const legacySchema = JSON.stringify(tools[0].input_schema)
        // OpenAI + Anthropic
        await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
          const { fetch: f2, calls: c2 } = makeSpy(
            providerHandler(
              [openAIChunk("hi"), openAIFinishChunk()],
              [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
            ),
          )
          const p2 = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch: f2 })
          await collect(p2.languageModel("gpt-5.6-terra"), {
            prompt: [{ role: "user", content: "use a tool" }],
            tools: toolDefs,
          })
          const oaBody = c2.find((c) => c.url.includes("chat/completions"))!.body as {
            tools: Array<{
              type: string
              function: { name: string; description: string; parameters: unknown }
            }>
          }
          assertEqual(oaBody.tools.length, 1)
          assertEqual(oaBody.tools[0].type, "function")
          assertEqual(oaBody.tools[0].function.name, "read")
          assertEqual(oaBody.tools[0].function.description, "Read a file")
          assertEqual(JSON.stringify(oaBody.tools[0].function.parameters), legacySchema)
          await collect(p2.languageModel("claude-sonnet-5"), {
            prompt: [{ role: "user", content: "use a tool" }],
            tools: toolDefs,
          })
          const antBody = c2.find((c) => c.url.includes("/messages"))!.body as {
            tools: Array<{ name: string; description: string; input_schema: unknown }>
          }
          assertEqual(antBody.tools.length, 1)
          assertEqual(antBody.tools[0].name, "read")
          assertEqual(antBody.tools[0].description, "Read a file")
          assertEqual(JSON.stringify(antBody.tools[0].input_schema), legacySchema)
        })
      }
    },
  ],
  [
    "parity: tool-call parts identical on legacy, OpenAI and Anthropic streams",
    async () => {
      const legacyParts = await (async () => {
        const { fetch } = makeSpy((call) => {
          if (call.url.includes("/alpha/generate"))
            return sseResponse([
              toolCall("t1", "read", { path: "a.ts" }),
              finishEvent({ finishReason: "tool_use" }),
            ])
          return new Response("not found", { status: 404 })
        })
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "go" })
        return collect(provider.languageModel("claude-sonnet-5"), {
          prompt: [{ role: "user", content: "use a tool" }],
        })
      })()
      const toolParts = (parts: Array<Record<string, unknown>>) =>
        parts.filter((p) => p.type !== "finish")
      assertEqual(toolParts(legacyParts), expectedToolParts)

      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        // OpenAI single-chunk tool call
        {
          const { fetch } = makeSpy(
            providerHandler(
              [
                openAIChunk("", {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            id: "t1",
                            type: "function",
                            function: { name: "read", arguments: '{"path":"a.ts"}' },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
                openAIFinishChunk(),
              ],
              [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
            ),
          )
          const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"), {
            prompt: [{ role: "user", content: "use a tool" }],
          })
          assertEqual(toolParts(parts), expectedToolParts)
        }
        // OpenAI multi-chunk tool call (fragmented arguments)
        {
          const { fetch } = makeSpy(
            providerHandler(
              [
                openAIChunk("", {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          { id: "t1", type: "function", function: { name: "read", arguments: "" } },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
                openAIChunk("", {
                  choices: [
                    {
                      delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] },
                      finish_reason: null,
                    },
                  ],
                }),
                openAIChunk("", {
                  choices: [
                    {
                      delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] },
                      finish_reason: null,
                    },
                  ],
                }),
                openAIFinishChunk(),
              ],
              [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
            ),
          )
          const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"), {
            prompt: [{ role: "user", content: "use a tool" }],
          })
          const start = parts.find((p) => p.type === "tool-input-start")
          const end = parts.find((p) => p.type === "tool-input-end")
          const call = parts.find((p) => p.type === "tool-call")
          assertEqual(start, expectedToolParts[0])
          assertEqual(end, expectedToolParts[2])
          assertEqual(call, expectedToolParts[3])
          const deltas = parts
            .filter((p) => p.type === "tool-input-delta")
            .map((p) => (p as { delta: string }).delta)
            .join("")
          assertEqual(deltas, '{"path":"a.ts"}')
        }
        // Anthropic tool_use block
        {
          const { fetch } = makeSpy(
            providerHandler(
              [openAIChunk("hi"), openAIFinishChunk()],
              [
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "tool_use", id: "t1", name: "read" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
                },
                { type: "content_block_stop", index: 0 },
                anthropicMessageDelta(),
              ],
            ),
          )
          const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
          const parts = await collect(provider.languageModel("claude-sonnet-5"), {
            prompt: [{ role: "user", content: "use a tool" }],
          })
          assertEqual(toolParts(parts), expectedToolParts)
        }
      })
    },
  ],
  [
    "parity: vision model forwards image input on all three transports",
    async () => {
      // legacy: claude-sonnet-5 (vision) with allowImages = modelSupportsImageInput
      {
        const { fetch, calls } = makeSpy((call) => {
          if (call.url.includes("/alpha/generate")) return sseResponse([finishEvent()])
          return new Response("not found", { status: 404 })
        })
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "go" })
        await collect(provider.languageModel("claude-sonnet-5"), { prompt: IMAGE_PROMPT })
        const body = calls[0].body as { params: { messages: Array<{ content: unknown }> } }
        const content = (body.params.messages[0].content as Array<Record<string, unknown>>)[0]
        assertEqual(content.type, "image")
        assertEqual(content.image, "data:image/png;base64,aGVsbG8=")
        assertEqual(content.mimeType, "image/png")
      }
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        // OpenAI shape
        {
          const { fetch, calls } = makeSpy(
            providerHandler(
              [openAIChunk("hi"), openAIFinishChunk()],
              [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
            ),
          )
          const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
          await collect(provider.languageModel("gpt-5.6-terra"), { prompt: IMAGE_PROMPT })
          const body = calls.find((c) => c.url.includes("chat/completions"))!.body as {
            messages: Array<{ content: unknown }>
          }
          const content = (body.messages[0].content as Array<Record<string, unknown>>)[0]
          assertEqual(content.type, "image_url")
          assertEqual((content.image_url as { url: string }).url, "data:image/png;base64,aGVsbG8=")
        }
        // Anthropic shape
        {
          const { fetch, calls } = makeSpy(
            providerHandler(
              [openAIChunk("hi"), openAIFinishChunk()],
              [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
            ),
          )
          const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
          await collect(provider.languageModel("claude-sonnet-5"), { prompt: IMAGE_PROMPT })
          const body = calls.find((c) => c.url.includes("/messages"))!.body as {
            messages: Array<{ content: unknown }>
          }
          const content = (body.messages[0].content as Array<Record<string, unknown>>)[0]
          assertEqual(content.type, "image")
          const source = content.source as Record<string, unknown>
          assertEqual(source.type, "base64")
          assertEqual(source.media_type, "image/png")
          assertEqual(source.data, "aGVsbG8=")
        }
      })
    },
  ],
  [
    "parity: text-only model rejects image input identically on both transports",
    async () => {
      const message = /Selected Command Code model does not support image content in user messages/
      // legacy
      {
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", plan: "go" })
        await rejects(
          provider.languageModel("deepseek/deepseek-v4-pro").doStream({
            prompt: IMAGE_PROMPT,
            mode: { type: "regular" },
          } as never),
          message,
        )
      }
      // provider (OpenAI route; claude-* are all vision, so Anthropic route is
      // unreachable for this case — the shared assertTextOnlyMessages helper
      // covers it at the codec seam in provider-codecs.test.ts)
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x" })
        await rejects(
          provider.languageModel("deepseek/deepseek-v4-pro").doStream({
            prompt: IMAGE_PROMPT,
            mode: { type: "regular" },
          } as never),
          message,
        )
      })
    },
  ],
  [
    "parity: system prompt lands identically on all three transports",
    async () => {
      // legacy params.system
      {
        const { fetch, calls } = makeSpy((call) => {
          if (call.url.includes("/alpha/generate")) return sseResponse([finishEvent()])
          return new Response("not found", { status: 404 })
        })
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "go" })
        await collect(provider.languageModel("claude-sonnet-5"), { prompt: SYSTEM_PROMPT })
        const body = calls[0].body as { params: { system: unknown } }
        assertEqual(body.params.system, "You are a test.")
      }
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        const { fetch, calls } = makeSpy(
          providerHandler(
            [openAIChunk("hi"), openAIFinishChunk()],
            [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
          ),
        )
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
        await collect(provider.languageModel("gpt-5.6-terra"), { prompt: SYSTEM_PROMPT })
        const oa = calls.find((c) => c.url.includes("chat/completions"))!.body as {
          messages: Array<{ role: string; content: unknown }>
        }
        assertEqual(oa.messages[0].role, "system")
        assertEqual(oa.messages[0].content, "You are a test.")
        await collect(provider.languageModel("claude-sonnet-5"), { prompt: SYSTEM_PROMPT })
        const ant = calls.find((c) => c.url.includes("/messages"))!.body as {
          system: unknown
          messages: Array<{ role: string }>
        }
        assertEqual(ant.system, "You are a test.")
        assert(
          !ant.messages.some((m) => m.role === "system"),
          "no system role in anthropic messages",
        )
      })
    },
  ],
  [
    "parity: max_tokens capped at 64_000 on all three transports",
    async () => {
      const cases: Array<[number | undefined, number]> = [
        [undefined, 64000],
        [100000, 64000],
        [1000, 1000],
      ]
      // legacy params.max_tokens
      {
        const { fetch, calls } = makeSpy((call) => {
          if (call.url.includes("/alpha/generate")) return sseResponse([finishEvent()])
          return new Response("not found", { status: 404 })
        })
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "go" })
        const model = provider.languageModel("claude-sonnet-5")
        for (const [requested, expected] of cases) {
          await collect(model, {
            prompt: [{ role: "user", content: "hi" }],
            ...(requested !== undefined ? { maxOutputTokens: requested } : {}),
          })
          const body = calls[calls.length - 1].body as { params: { max_tokens: unknown } }
          assertEqual(body.params.max_tokens, expected, `legacy max_tokens for ${requested}`)
        }
      }
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        const { fetch, calls } = makeSpy(
          providerHandler(
            [openAIChunk("hi"), openAIFinishChunk()],
            [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
          ),
        )
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
        for (const [requested, expected] of cases) {
          const opts = {
            prompt: [{ role: "user", content: "hi" }],
            ...(requested !== undefined ? { maxOutputTokens: requested } : {}),
          }
          await collect(provider.languageModel("gpt-5.6-terra"), opts)
          const oa = calls.filter((c) => c.url.includes("chat/completions")).at(-1)!.body as {
            max_tokens: unknown
          }
          assertEqual(oa.max_tokens, expected, `openAI max_tokens for ${requested}`)
          await collect(provider.languageModel("claude-sonnet-5"), opts)
          const ant = calls.filter((c) => c.url.includes("/messages")).at(-1)!.body as {
            max_tokens: unknown
          }
          assertEqual(ant.max_tokens, expected, `anthropic max_tokens for ${requested}`)
        }
      })
    },
  ],
  [
    "parity: reasoning-effort mapping identical on all three transports",
    async () => {
      // NB: block-bodied form — a parenthesized object-literal arrow followed
      // by a bare `{ ... }` block confuses the TypeScript parser (TS1005).
      const withEffort = (effort: string): Record<string, unknown> => {
        return { commandcode: { reasoningEffort: effort } }
      }
      // legacy
      {
        const { fetch, calls } = makeSpy((call) => {
          if (call.url.includes("/alpha/generate")) return sseResponse([finishEvent()])
          return new Response("not found", { status: 404 })
        })
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "go" })
        const model = provider.languageModel("claude-sonnet-5")
        await collect(model, {
          prompt: [{ role: "user", content: "hi" }],
          providerOptions: withEffort("high"),
        })
        const body = calls[0].body as { params: { reasoning_effort?: unknown } }
        assertEqual(body.params.reasoning_effort, "high")
        await collect(model, {
          prompt: [{ role: "user", content: "hi" }],
          providerOptions: withEffort("off"),
        })
        assert(
          !("reasoning_effort" in (calls[1].body as { params: object }).params),
          "off not sent on legacy",
        )
        await collect(model, {
          prompt: [{ role: "user", content: "hi" }],
          providerOptions: withEffort("minimal"),
        })
        assert(
          !("reasoning_effort" in (calls[2].body as { params: object }).params),
          "unmapped level not sent on legacy",
        )
      }
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        const { fetch, calls } = makeSpy(
          providerHandler(
            [openAIChunk("hi"), openAIFinishChunk()],
            [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
          ),
        )
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
        await collect(provider.languageModel("gpt-5.6-terra"), {
          prompt: [{ role: "user", content: "hi" }],
          providerOptions: withEffort("high"),
        })
        const oa = calls.find((c) => c.url.includes("chat/completions"))!.body as {
          reasoning_effort?: unknown
        }
        assertEqual(oa.reasoning_effort, "high")
        await collect(provider.languageModel("claude-sonnet-5"), {
          prompt: [{ role: "user", content: "hi" }],
          providerOptions: withEffort("high"),
        })
        const ant = calls.find((c) => c.url.includes("/messages"))!.body as {
          reasoning_effort?: unknown
        }
        assertEqual(ant.reasoning_effort, "high")
        await collect(provider.languageModel("gpt-5.6-terra"), {
          prompt: [{ role: "user", content: "hi" }],
          providerOptions: withEffort("minimal"),
        })
        const oaOff = calls.filter((c) => c.url.includes("chat/completions")).at(-1)!.body as {
          reasoning_effort?: unknown
        }
        assert(!("reasoning_effort" in oaOff), "unmapped level not sent on OpenAI")
        await collect(provider.languageModel("claude-sonnet-5"), {
          prompt: [{ role: "user", content: "hi" }],
          providerOptions: withEffort("off"),
        })
        const antOff = calls.filter((c) => c.url.includes("/messages")).at(-1)!.body as {
          reasoning_effort?: unknown
        }
        assert(!("reasoning_effort" in antOff), "off not sent on Anthropic")
      })
    },
  ],
  [
    "parity: same usage emits same cost on all three transports",
    async () => {
      const expectedUsage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 4, text: 4, reasoning: 0 },
      }
      const finishOf = (parts: Array<Record<string, unknown>>) =>
        parts.find((p) => p.type === "finish") as { usage?: unknown }
      // The cost entry comes from the generated facts by derivation, not a
      // pinned id (pricing-lint gate: tests/no-upstream-value-pins.test.ts).
      const parityCostId = Object.keys(MODEL_EFFORTS)[0]
      assert(parityCostId, "the generated efforts facts must not be empty")
      const costOf = (usage: unknown) => {
        const cu = costUsageFromAiSdkUsage(usage as never)
        calculateCommandCodeCost({ cost: MODEL_COSTS[parityCostId] }, cu)
        return cu.cost.total
      }
      // legacy
      let legacyCost = 0
      {
        const { fetch } = makeSpy((call) => {
          if (call.url.includes("/alpha/generate")) return sseResponse([finishEvent()])
          return new Response("not found", { status: 404 })
        })
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan: "go" })
        const parts = await collect(provider.languageModel("claude-sonnet-5"), {
          prompt: [{ role: "user", content: "hi" }],
        })
        assertEqual(finishOf(parts).usage, expectedUsage)
        legacyCost = costOf(finishOf(parts).usage)
      }
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        // OpenAI
        {
          const { fetch } = makeSpy(
            providerHandler(
              [openAIChunk("hi"), openAIFinishChunk({ prompt_tokens: 10, completion_tokens: 4 })],
              [anthropicContentBlockDelta("hi"), anthropicMessageDelta()],
            ),
          )
          const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
          const parts = await collect(provider.languageModel("gpt-5.6-terra"), {
            prompt: [{ role: "user", content: "hi" }],
          })
          assertEqual(finishOf(parts).usage, expectedUsage)
          assertEqual(costOf(finishOf(parts).usage), legacyCost)
        }
        // Anthropic
        {
          const { fetch } = makeSpy(
            providerHandler(
              [openAIChunk("hi"), openAIFinishChunk()],
              [
                anthropicContentBlockDelta("hi"),
                anthropicMessageDelta({ input_tokens: 10, output_tokens: 4 }),
              ],
            ),
          )
          const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch })
          const parts = await collect(provider.languageModel("claude-sonnet-5"), {
            prompt: [{ role: "user", content: "hi" }],
          })
          assertEqual(finishOf(parts).usage, expectedUsage)
          assertEqual(costOf(finishOf(parts).usage), legacyCost)
        }
      })
    },
  ],

  // --- Acceptance 4: redaction + retry/timeout/abort parity ---
  [
    "parity: leaked API key in error body is redacted identically on all three transports",
    async () => {
      const secret = "user_abcdefgh1234"
      const sk = "sk-1234567890abcdef1234567890abcdef"
      const errorBody = JSON.stringify({
        error: { message: `401 unauthorized: Bearer ${secret} with ${sk}` },
      })
      // Legacy needs an explicit plan:"go"; the provider endpoints resolve to
      // the Provider API via COMMANDCODE_PLAN=goat (set by the caller), with
      // the model routed per endpoint (claude-* → /messages, else
      // /chat/completions).
      const errorPartOf = async (url: string, plan: string | undefined): Promise<string> => {
        const { fetch } = makeSpy(
          () =>
            new Response(errorBody, {
              status: 401,
              headers: { "content-type": "application/json" },
            }),
        )
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan })
        const modelId = url.includes("chat/completions") ? "gpt-5.6-terra" : "claude-sonnet-5"
        const parts = await collect(provider.languageModel(modelId), {
          prompt: [{ role: "user", content: "hi" }],
        })
        const err = parts.find((p) => p.type === "error") as { error?: Error }
        assert(err, `error part for ${url}`)
        const message = err.error!.message
        assert(!message.includes(secret), `no user token leak (${url})`)
        assert(!message.includes(sk), `no sk leak (${url})`)
        assert(message.includes("[redacted]"), `redacted marker (${url})`)
        return message
      }
      const legacyMsg = await errorPartOf("/alpha/generate", "go")
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        const oaMsg = await errorPartOf("/provider/v1/chat/completions", undefined)
        const antMsg = await errorPartOf("/provider/v1/messages", undefined)
        assertEqual(oaMsg, legacyMsg)
        assertEqual(antMsg, legacyMsg)
      })
    },
  ],
  [
    "parity: retryable 429 with Retry-After retries on all three transports",
    async () => {
      // legacy needs an explicit plan:"go"; the provider endpoints resolve to
      // the Provider API via COMMANDCODE_PLAN=goat (set by the caller). Model
      // choice must match per-model routing: claude-* → /messages, else
      // /chat/completions.
      const modelFor = (endpoint: string) =>
        endpoint.includes("chat/completions") ? "gpt-5.6-terra" : "claude-sonnet-5"
      const runRetry = async (endpoint: string, plan: string | undefined): Promise<number> => {
        let attempts = 0
        const { fetch, calls } = makeSpy(() => {
          attempts++
          if (attempts === 1) {
            return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "0" },
            })
          }
          if (endpoint === "/alpha/generate") return sseResponse([finishEvent()])
          if (endpoint.includes("chat/completions"))
            return sseResponse([openAIChunk("hi"), openAIFinishChunk()])
          return sseResponse([anthropicContentBlockDelta("hi"), anthropicMessageDelta()])
        })
        const provider = createCommandCode({
          apiKey: "k",
          baseURL: "https://x",
          fetch,
          plan,
          maxRetries: 1,
        })
        const parts = await collect(provider.languageModel(modelFor(endpoint)), {
          prompt: [{ role: "user", content: "hi" }],
        })
        assert(
          parts.some((p) => p.type === "finish"),
          `finish after retry (${endpoint})`,
        )
        return calls.filter((c) => c.url.includes(endpoint)).length
      }
      assertEqual(await runRetry("/alpha/generate", "go"), 2)
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        assertEqual(await runRetry("/provider/v1/chat/completions", undefined), 2)
        assertEqual(await runRetry("/provider/v1/messages", undefined), 2)
      })
    },
  ],
  [
    "parity: non-retryable 400 is not retried on either transport",
    async () => {
      // Stream-level retries only happen while attempts remain; with the
      // default maxRetries (0) a 400 must surface after exactly one request.
      const runOnce = async (
        endpoint: string,
        plan: string | undefined,
      ): Promise<{ calls: number; message: string }> => {
        const { fetch, calls } = makeSpy(
          () =>
            new Response(JSON.stringify({ error: { message: "bad request" } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
        )
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan })
        const modelId = endpoint.includes("chat/completions") ? "gpt-5.6-terra" : "claude-sonnet-5"
        const parts = await collect(provider.languageModel(modelId), {
          prompt: [{ role: "user", content: "hi" }],
        })
        const err = parts.find((p) => p.type === "error") as { error?: Error }
        return {
          calls: calls.filter((c) => c.url.includes(endpoint)).length,
          message: err.error?.message ?? "",
        }
      }
      const legacy = await runOnce("/alpha/generate", "go")
      assertEqual(legacy.calls, 1)
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        const providerResult = await runOnce("/provider/v1/chat/completions", undefined)
        assertEqual(providerResult.calls, 1)
        assertEqual(providerResult.message, legacy.message)
      })
    },
  ],
  [
    "parity: timeoutMs applies on both transports",
    async () => {
      const neverResolvingFetch: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          )
        })
      const runTimeout = async (plan: string | undefined, modelId: string): Promise<string> => {
        const provider = createCommandCode({
          apiKey: "k",
          baseURL: "https://x",
          fetch: neverResolvingFetch,
          plan,
          timeout: 30,
        })
        const parts = await collect(provider.languageModel(modelId), {
          prompt: [{ role: "user", content: "hi" }],
        })
        const err = parts.find((p) => p.type === "error") as { error?: Error }
        assert(err, "error part on timeout")
        return err.error!.message
      }
      const legacyMsg = await runTimeout("go", "claude-sonnet-5")
      assert(legacyMsg.includes("timed out after 30ms"), legacyMsg)
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        const oaMsg = await runTimeout(undefined, "gpt-5.6-terra")
        assert(oaMsg.includes("timed out after 30ms"), oaMsg)
        assertEqual(oaMsg, legacyMsg)
      })
    },
  ],
  [
    "parity: abort mid-stream surfaces an aborted error part on both transports",
    async () => {
      // Each transport must see its own wire shape so the first part actually
      // arrives; the stream then stalls so the outer abort interrupts the read.
      const stalledSse = (call: SpyCall): Response => {
        const enc = new TextEncoder()
        const event = call.url.includes("/alpha/generate") ? textDelta("hi") : openAIChunk("hi")
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
            // never close — the outer abort must interrupt the read
          },
        })
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      const runAbort = async (plan: string | undefined, modelId: string): Promise<string> => {
        const { fetch } = makeSpy((call) => stalledSse(call))
        const provider = createCommandCode({ apiKey: "k", baseURL: "https://x", fetch, plan })
        const controller = new AbortController()
        const result = await provider.languageModel(modelId).doStream({
          prompt: [{ role: "user", content: "hi" }],
          mode: { type: "regular" },
          abortSignal: controller.signal,
        } as never)
        const reader = result.stream.getReader()
        // Guard against a silently-hanging first read (wrong wire shape would
        // otherwise exit the suite with no failure once the loop drains).
        const first = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("abort test: first part never arrived")), 5000),
          ),
        ])
        assert(
          (first.value as { type?: string }).type === "text-start" ||
            (first.value as { type?: string }).type === "text-delta",
          `expected text part, got ${(first.value as { type?: string }).type}`,
        )
        controller.abort()
        const rest: Array<Record<string, unknown>> = []
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          rest.push(value as unknown as Record<string, unknown>)
        }
        const err = rest.find((p) => p.type === "error") as { error?: Error }
        assert(err, "aborted error part")
        return err.error!.message
      }
      const legacyMsg = await runAbort("go", "claude-sonnet-5")
      assertEqual(legacyMsg, "The operation was aborted")
      await withEnvVars({ COMMANDCODE_PLAN: "goat" }, async () => {
        const oaMsg = await runAbort(undefined, "gpt-5.6-terra")
        assertEqual(oaMsg, legacyMsg)
      })
    },
  ],
])
