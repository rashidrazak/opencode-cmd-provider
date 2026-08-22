// src/provider/command-code-model.ts — AI SDK v3 LanguageModel for Command Code
// (PLAN #8: doStream tracer bullet; doGenerate lands in #9)
//
// Port of pi's createStreamCommandCode loop (core.ts:159-741): SSE parse via
// #3's stream helpers, retry/abort/timeout via retry.ts, redaction on every
// surfaced error, v3 stream parts on the wire.
import { randomUUID } from "node:crypto"
import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3FinishReason,
  LanguageModelV3Content,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type {
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  ModelCallOptions,
} from "./aisdk-types.js"
import { resolveApiKey } from "./auth-key.js"
import {
  messagesToCC,
  messagesToAnthropic,
  messagesToOpenAI,
  toolsToJson,
  systemPromptToText,
  getEnvironmentInfo,
  isRecord,
  stringValue,
} from "./converters.js"
import {
  parseStreamEventLine,
  ccEventToStreamPart,
  createOpenAIStreamParser,
  createAnthropicStreamParser,
} from "./stream.js"
import { getApiBase } from "../env.js"
import { resolvePlan, type PlanResolutionCache } from "../deals/plan-summary.js"
import { redactCommandCodeErrorText, commandCodeErrorMessage } from "./redact.js"
import { calculateCommandCodeCost, costUsageFromAiSdkUsage } from "./cost.js"
import { ZERO_MODEL_COST, MODEL_COSTS } from "./pricing.js"
import {
  mappedReasoningEffort,
  resolveProviderReasoning,
  thinkingMetadataForModel,
  isReasoningModel,
} from "./reasoning.js"
import { modelSupportsImageInput } from "./modalities.js"
import {
  isRetryableStatus,
  retryDelayMs,
  raceAbort,
  abortError,
  timeoutError,
  delay,
} from "./retry.js"
import { projectSlugFromPath } from "./project-slug.js"

export interface CommandCodeModelOptions {
  name?: string
  baseURL?: string
  apiKey?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
  timeout?: number
  maxRetries?: number
  maxRetryDelayMs?: number
  authPaths?: readonly string[]
  // Optional explicit plan override for provider transport (normalized via normalizePlan).
  // Also honoured via COMMANDCODE_PLAN env and per-call providerOptions.
  plan?: string
}

const COMMAND_CODE_CLI_VERSION = "1.15.1"
const DEFAULT_GENERATE_MAX_TOKENS = 64_000
const DEFAULT_MAX_RETRIES = 0
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
const DEFAULT_BASE_URL = "https://api.commandcode.ai"

function isClaudeModel(modelId: string): boolean {
  return modelId.startsWith("claude-")
}

function planFromProviderOptions(providerOptions: unknown): string | undefined {
  if (!isRecord(providerOptions)) return undefined
  const top = stringValue((providerOptions as Record<string, unknown>).plan)
  if (top) return top
  const topEnv = stringValue((providerOptions as Record<string, unknown>).COMMANDCODE_PLAN)
  if (topEnv) return topEnv
  for (const key of ["commandcode", "commandCode", "cmd", "command-code"]) {
    const ns = (providerOptions as Record<string, unknown>)[key]
    if (isRecord(ns)) {
      const v = stringValue(ns.plan) ?? stringValue(ns.COMMANDCODE_PLAN)
      if (v) return v
    }
  }
  return undefined
}

function promptSystem(prompt: LanguageModelV3Prompt): unknown {
  const system = prompt.filter((m) => m.role === "system").map((m) => m.content)
  return system.length > 0 ? system.join("\n") : undefined
}

function errorStream(message: string): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "error", error: new Error(message) })
      controller.close()
    },
  })
}

export class CommandCodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = "commandcode"
  readonly modelId: string
  readonly supportsStructuredOutputs = false
  readonly supportsParallelCalls = false
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(
    private readonly options: CommandCodeModelOptions,
    modelId: string,
  ) {
    this.modelId = modelId
  }

  private apiBase(): string {
    return this.options.baseURL ?? getApiBase()
  }

  private costForModel(): { cost: (typeof MODEL_COSTS)[string] } {
    return { cost: MODEL_COSTS[this.modelId] ?? ZERO_MODEL_COST }
  }

  /**
   * Per-instance whoami cache: the `GET /alpha/whoami` fetch happens at most
   * once for the lifetime of this model instance and is reused across turns.
   */
  private readonly planCache: PlanResolutionCache = {}

  /**
   * Resolves the transport plan through the shared plan-resolution seam:
   * explicit override (providerOptions plan, model option `plan`) →
   * COMMANDCODE_PLAN env → cached whoami → default Provider API. Only a
   * resolved `go` selects the legacy transport; every other resolution
   * selects the Provider API. The whoami fetch is cached for the lifetime of
   * this instance (see planCache) and honours the same resolved key, base URL
   * and injected fetch as inference.
   */
  private async shouldUseProviderTransport(options: ModelCallOptions): Promise<boolean> {
    const plan = await resolvePlan(this.planArgFor(options), process.env, {
      defaultPlan: "provider",
      cache: this.planCache,
      apiKey: resolveApiKey({
        apiKey: this.options.apiKey,
        authPaths: this.options.authPaths,
      }),
      baseURL: this.options.baseURL,
      fetch: this.options.fetch,
    })
    return plan !== "go"
  }

  private planArgFor(options: ModelCallOptions): string | undefined {
    return planFromProviderOptions(options.providerOptions) ?? this.options.plan
  }

  private providerEndpoint(): string {
    return isClaudeModel(this.modelId)
      ? `${this.apiBase()}/provider/v1/messages`
      : `${this.apiBase()}/provider/v1/chat/completions`
  }

  async doGenerate(options: ModelCallOptions): Promise<LanguageModelV3GenerateResult> {
    const { parts, error } = await this.runOnce(options)
    if (error) throw error

    const content: LanguageModelV3Content[] = []
    let text = ""
    let reasoning = ""
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: "unknown" }
    let usage: LanguageModelV3Usage | undefined
    for (const part of parts) {
      switch (part.type) {
        case "text-delta":
          text += part.delta
          break
        case "reasoning-delta":
          reasoning += part.delta
          break
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
          break
        case "finish":
          finishReason = part.finishReason
          usage = part.usage
          break
        case "error":
          throw part.error
        default:
          break
      }
    }
    if (text) content.push({ type: "text", text })
    if (reasoning) content.push({ type: "reasoning", text: reasoning })
    if (!usage) {
      usage = {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      }
    }
    return { content, finishReason, usage, warnings: [] }
  }

  async doStream(
    options: ModelCallOptions,
  ): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart>; error?: unknown }> {
    if (await this.shouldUseProviderTransport(options)) {
      const isClaude = isClaudeModel(this.modelId)
      const body = this.providerBodyFor(options, isClaude)
      const headers = this.providerHeadersFor(options)
      return {
        stream: this.providerRunStream(body, headers, options.abortSignal, options, isClaude),
      }
    }
    return {
      stream: this.runStream(
        this.bodyFor(options),
        this.headersFor(options),
        options.abortSignal,
        options,
      ),
    }
  }

  /**
   * Runs one request/parse pass and collects the v3 parts (doGenerate).
   * Stream errors surface as error parts; the first error part is also
   * returned so doGenerate can throw it.
   */
  private async runOnce(
    options: ModelCallOptions,
  ): Promise<{ parts: LanguageModelV3StreamPart[]; error?: Error }> {
    const apiKey = resolveApiKey({
      apiKey: this.options.apiKey,
      authPaths: this.options.authPaths,
    })
    if (!apiKey) {
      return {
        parts: [],
        error: new Error(
          "No Command Code API key. Run /connect and select Command Code, set the COMMANDCODE_API_KEY env var, or configure an auth file.",
        ),
      }
    }
    const parts: LanguageModelV3StreamPart[] = []
    let stream: ReadableStream<LanguageModelV3StreamPart>
    if (await this.shouldUseProviderTransport(options)) {
      const isClaude = isClaudeModel(this.modelId)
      const body = this.providerBodyFor(options, isClaude)
      const headers = this.providerHeadersFor(options)
      stream = this.providerRunStream(body, headers, options.abortSignal, options, isClaude, parts)
    } else {
      stream = this.runStream(
        this.bodyFor(options),
        this.headersFor(options),
        options.abortSignal,
        options,
        parts,
      )
    }
    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    await reader.cancel().catch(() => {})
    const errorPart = parts.find((p) => p.type === "error")
    return {
      parts,
      error: errorPart && errorPart.type === "error" ? (errorPart.error as Error) : undefined,
    }
  }

  private bodyFor(options: ModelCallOptions): unknown {
    const reasoningEffort = mappedReasoningEffort(
      {
        reasoning: isReasoningModel(this.modelId),
        thinkingLevelMap: thinkingMetadataForModel(this.modelId)?.thinkingLevelMap,
      },
      {
        reasoning: resolveProviderReasoning(options.providerOptions, "commandcode"),
      },
    )
    const maxTokens = Math.min(
      options.maxOutputTokens ?? DEFAULT_GENERATE_MAX_TOKENS,
      DEFAULT_GENERATE_MAX_TOKENS,
    )
    const allowImages = modelSupportsImageInput(this.modelId)

    return {
      config: {
        workingDir: process.cwd(),
        date: new Date().toISOString().split("T")[0],
        environment: getEnvironmentInfo(),
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
        model: this.modelId,
        messages: messagesToCC(options.prompt, { allowImages }),
        tools: toolsToJson(
          (options.tools ?? [])
            .filter((tool) => tool.type === "function")
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
        ),
        system: systemPromptToText(promptSystem(options.prompt)),
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      threadId: randomUUID(),
    }
  }

  private headersFor(options: ModelCallOptions): Record<string, string> {
    const apiKey = resolveApiKey({
      apiKey: this.options.apiKey,
      authPaths: this.options.authPaths,
    })
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? ""}`,
      "x-command-code-version": COMMAND_CODE_CLI_VERSION,
      "x-cli-environment": "production",
      "x-project-slug": projectSlugFromPath(process.cwd()),
      "x-taste-learning": "true",
      "x-co-flag": "false",
      ...this.options.headers,
      ...(options.headers ?? {}),
    }
  }

  private providerBodyFor(options: ModelCallOptions, isClaude: boolean): unknown {
    const allowImages = modelSupportsImageInput(this.modelId)
    if (isClaude) {
      return (messagesToAnthropic as unknown as (prompt: unknown, opts: unknown) => unknown)(
        options.prompt as unknown,
        {
          model: this.modelId,
          maxOutputTokens: options.maxOutputTokens,
          providerOptions: options.providerOptions,
          tools: options.tools as unknown,
          allowImages,
        },
      )
    }
    return (messagesToOpenAI as unknown as (prompt: unknown, opts: unknown) => unknown)(
      options.prompt as unknown,
      {
        model: this.modelId,
        maxOutputTokens: options.maxOutputTokens,
        providerOptions: options.providerOptions,
        tools: options.tools as unknown,
        allowImages,
      },
    )
  }

  private providerHeadersFor(options: ModelCallOptions): Record<string, string> {
    const apiKey = resolveApiKey({
      apiKey: this.options.apiKey,
      authPaths: this.options.authPaths,
    })
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? ""}`,
      ...this.options.headers,
      ...(options.headers ?? {}),
    }
  }

  private providerRunStream(
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    options: ModelCallOptions,
    isClaude: boolean,
    sink?: LanguageModelV3StreamPart[],
  ): ReadableStream<LanguageModelV3StreamPart> {
    const url = this.providerEndpoint()
    const bodyStr = JSON.stringify(body)
    // Per-stream stateful parsers complete tool calls whose arguments arrive
    // across multiple SSE events (issue #55 tool-call parity); the stateless
    // mappers are kept for direct codec use.
    const parser: (event: unknown) => LanguageModelV3StreamPart[] = isClaude
      ? createAnthropicStreamParser()
      : createOpenAIStreamParser()
    return this.transportStream(url, bodyStr, headers, signal, sink, parser)
  }

  private runStream(
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    options: ModelCallOptions,
    sink?: LanguageModelV3StreamPart[],
  ): ReadableStream<LanguageModelV3StreamPart> {
    const url = `${this.apiBase()}/alpha/generate`
    const bodyStr = JSON.stringify(body)
    return this.transportStream(url, bodyStr, headers, signal, sink, ccEventToStreamPart)
  }

  /**
   * Deep internal seam: single SSE transport behind a small interface.
   * All retry/timeout/abort/redaction/stream-parsing/cost/fallback logic
   * lives here; callers supply only the endpoint URL, body, headers and
   * the event→parts mapper. Depth gives leverage (N callers) and locality
   * (fix once, fixed everywhere). The eventToParts adapter varies across
   * the seam (CC vs OpenAI vs Anthropic) while the transport stays fixed.
   */
  private transportStream(
    url: string,
    bodyStr: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    sink: LanguageModelV3StreamPart[] | undefined,
    eventToParts: (event: unknown) => LanguageModelV3StreamPart[],
  ): ReadableStream<LanguageModelV3StreamPart> {
    const timeoutMs = this.options.timeout
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES
    const maxRetryDelayMs = this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
    const fetchImpl = this.options.fetch ?? fetch

    return new ReadableStream<LanguageModelV3StreamPart>({
      start: async (streamController) => {
        const emit = (part: LanguageModelV3StreamPart) => {
          sink?.push(part)
          streamController.enqueue(part)
        }
        const fail = (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          const part: LanguageModelV3StreamPart = {
            type: "error",
            error: new Error(redactCommandCodeErrorText(message)),
          }
          sink?.push(part)
          streamController.enqueue(part)
          streamController.close()
        }

        const key = resolveApiKey({
          apiKey: this.options.apiKey,
          authPaths: this.options.authPaths,
        })
        if (!key) {
          fail(
            "No Command Code API key. Run /connect and select Command Code, set the COMMANDCODE_API_KEY env var, or configure an auth file.",
          )
          return
        }

        const handleEvent = (event: unknown): boolean => {
          if (!isRecord(event)) return false
          try {
            const parts = eventToParts(event)
            let finished = false
            for (const part of parts) {
              if (part.type === "finish") {
                finished = true
                calculateCommandCodeCost(this.costForModel(), costUsageFromAiSdkUsage(part.usage))
              }
              emit(part)
            }
            return finished
          } catch (streamError) {
            fail(streamError)
            return true
          }
        }

        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        const controller = new AbortController()
        const onOuterAbort = () => controller.abort()
        try {
          signal?.addEventListener("abort", onOuterAbort, { once: true })
          if (signal?.aborted) throw abortError("Aborted")
          let response!: Response
          let finished = false
          retryLoop: for (let attempt = 0; ; attempt++) {
            const attemptController = new AbortController()
            let attemptTimedOut = false
            let attemptTimeoutId: ReturnType<typeof setTimeout> | undefined

            const clearAttemptTimeout = () => {
              if (attemptTimeoutId !== undefined) {
                clearTimeout(attemptTimeoutId)
                attemptTimeoutId = undefined
              }
            }

            if (timeoutMs !== undefined) {
              attemptTimeoutId = setTimeout(() => {
                attemptTimedOut = true
                attemptController.abort()
              }, timeoutMs)
            }
            const onOuterAbort2 = () => attemptController.abort()
            controller.signal.addEventListener("abort", onOuterAbort2, { once: true })
            const raceAttempt = <T>(promise: Promise<T>): Promise<T> =>
              raceAbort(promise, attemptController.signal).catch((error: unknown) => {
                if (attemptTimedOut) throw timeoutError(timeoutMs)
                throw error
              })

            try {
              try {
                response = await fetchImpl(url, {
                  method: "POST",
                  headers,
                  body: bodyStr,
                  signal: attemptController.signal,
                })
              } catch (fetchError: unknown) {
                if (controller.signal.aborted) throw abortError("Aborted")
                if (attemptTimedOut) {
                  if (attempt < maxRetries) continue retryLoop
                  throw timeoutError(timeoutMs)
                }
                throw fetchError
              }

              // --- HTTP-level retry ---
              if (!response.ok && isRetryableStatus(response.status)) {
                const retryAfter = response.headers.get("retry-after")
                const waitMs = retryDelayMs(attempt, retryAfter, maxRetryDelayMs)
                if (waitMs < 0) {
                  throw new Error(
                    `Command Code API error ${response.status}: Retry-After delay exceeds max retry delay`,
                  )
                }
                if (attempt < maxRetries) {
                  await response.text().catch(() => "")
                  if (waitMs > 0) await delay(waitMs, controller.signal)
                  continue retryLoop
                }
              }

              if (!response.ok) {
                const errBody = await raceAttempt(response.text().catch(() => ""))
                let errorDetail: string | undefined
                try {
                  const parsedBody: unknown = JSON.parse(errBody)
                  errorDetail = commandCodeErrorMessage(parsedBody)
                } catch {
                  // Preserve useful plain-text provider errors only after secret
                  // redaction; upstream/proxy bodies may echo credentials.
                }
                const safeBody = redactCommandCodeErrorText(errBody).slice(0, 500)
                const detail = redactCommandCodeErrorText(
                  errorDetail ?? (safeBody || "Provider returned an error"),
                )
                throw new Error(`Command Code API error ${response.status}: ${detail}`)
              }

              // --- Read response stream ---
              reader = response.body?.getReader()
              if (!reader) throw new Error("No response body")

              const decoder = new TextDecoder()
              let buffer = ""

              readLoop: for (;;) {
                if (controller.signal.aborted) throw abortError("Aborted")
                const { done, value } = await raceAbort(reader.read(), attemptController.signal)
                if (done) {
                  if (buffer.trim()) handleEvent(parseStreamEventLine(buffer))
                  break
                }
                if (controller.signal.aborted) throw abortError("Aborted")

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""

                for (const line of lines) {
                  if (controller.signal.aborted) throw abortError("Aborted")
                  if (handleEvent(parseStreamEventLine(line))) {
                    finished = true
                    break readLoop
                  }
                }
              }

              // Stream completed successfully.
              break retryLoop
            } catch (streamError: unknown) {
              // Stream-level error (e.g. API returned 200 OK but sent an error
              // event) or per-attempt timeout during stream reading.
              await reader?.cancel().catch(() => {})
              try {
                reader?.releaseLock()
              } catch {}
              reader = undefined

              if (controller.signal.aborted) throw streamError

              // Never retry after visible content was emitted (including timeout mid-stream).
              const canRetry = !finished && attempt < maxRetries
              if (canRetry) {
                finished = false
                const waitMs = attemptTimedOut ? 0 : retryDelayMs(attempt, null, maxRetryDelayMs)
                if (waitMs > 0) await delay(waitMs, controller.signal)
                continue retryLoop
              }
              if (attemptTimedOut) throw timeoutError(timeoutMs)
              throw streamError
            } finally {
              controller.signal.removeEventListener("abort", onOuterAbort2)
              clearAttemptTimeout()
            }
          }

          if (!finished) {
            // The server closed the stream without a finish event; the AI SDK
            // expects a finish part to terminate a stream.
            emit({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            })
          }
          streamController.close()
        } catch (error: unknown) {
          if (controller.signal.aborted) {
            // Outer abort: emit a proper AbortError part (AI SDK contract).
            fail(abortError())
          } else {
            fail(error)
          }
        } finally {
          signal?.removeEventListener("abort", onOuterAbort)
        }
      },
    })
  }
}
