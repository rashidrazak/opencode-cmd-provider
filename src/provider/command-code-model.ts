// src/provider/command-code-model.ts — AI SDK v3 LanguageModel for Command Code
// (PLAN #8: doStream tracer bullet; doGenerate lands in #9)
//
// Port of pi's createStreamCommandCode loop (core.ts:159-741): SSE parse via
// #3's stream helpers, retry/abort/timeout via retry.ts, redaction on every
// surfaced error, v3 stream parts on the wire.
import { randomUUID } from "node:crypto"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart, ModelCallOptions } from "./aisdk-types.js"
import { resolveApiKey } from "./auth-key.js"
import { messagesToCC, toolsToJson, systemPromptToText, getEnvironmentInfo, isRecord, stringValue } from "./converters.js"
import { parseStreamEventLine, ccEventToStreamPart } from "./stream.js"
import { redactCommandCodeErrorText, commandCodeErrorMessage } from "./redact.js"
import { calculateCommandCodeCost } from "./cost.js"
import { ZERO_MODEL_COST, MODEL_COSTS } from "./pricing.js"
import { mappedReasoningEffort, thinkingMetadataForModel, isReasoningModel } from "./reasoning.js"
import { modelSupportsImageInput } from "./modalities.js"
import { isRetryableStatus, retryDelayMs, raceAbort, abortError, timeoutError, delay } from "./retry.js"
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
}

const COMMAND_CODE_CLI_VERSION = "1.15.1"
const DEFAULT_GENERATE_MAX_TOKENS = 64_000
const DEFAULT_MAX_RETRIES = 0
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
const DEFAULT_BASE_URL = "https://api.commandcode.ai"

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
    return this.options.baseURL ?? DEFAULT_BASE_URL
  }

  private costForModel(): { cost: (typeof MODEL_COSTS)[string] } {
    return { cost: MODEL_COSTS[this.modelId] ?? ZERO_MODEL_COST }
  }

  async doGenerate(_options: ModelCallOptions): Promise<never> {
    throw new Error("doGenerate implemented in #9")
  }

  async doStream(
    options: ModelCallOptions,
  ): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart>; error?: unknown }> {
    const prompt = options.prompt
    const signal = options.abortSignal
    const apiKey = resolveApiKey({
      apiKey: this.options.apiKey,
      authPaths: this.options.authPaths,
    })

    if (!apiKey) {
      return {
        stream: errorStream(
          "No Command Code API key. Run /connect and select Command Code, set the COMMANDCODE_API_KEY env var, or configure an auth file.",
        ),
      }
    }

    const reasoningEffort = mappedReasoningEffort(
      {
        reasoning: isReasoningModel(this.modelId),
        thinkingLevelMap: thinkingMetadataForModel(this.modelId)?.thinkingLevelMap,
      },
      {
        reasoning:
          (options.providerOptions?.reasoning as string | undefined) ??
          (options.providerOptions?.reasoningEffort as string | undefined),
      },
    )
    const maxTokens = Math.min(
      options.maxOutputTokens ?? DEFAULT_GENERATE_MAX_TOKENS,
      DEFAULT_GENERATE_MAX_TOKENS,
    )
    const allowImages = modelSupportsImageInput(this.modelId)

    const body = {
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
        messages: messagesToCC(prompt, { allowImages }),
        tools: toolsToJson(
          (options.tools ?? [])
            .filter((tool) => tool.type === "function")
            .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })),
        ),
        system: systemPromptToText(promptSystem(prompt)),
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      threadId: randomUUID(),
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-command-code-version": COMMAND_CODE_CLI_VERSION,
      "x-cli-environment": "production",
      "x-project-slug": projectSlugFromPath(process.cwd()),
      "x-taste-learning": "true",
      "x-co-flag": "false",
      ...this.options.headers,
      ...(options.headers ?? {}),
    }

    return {
      stream: this.runStream(body, headers, signal, options, apiKey),
    }
  }

  private runStream(
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    options: ModelCallOptions,
    apiKey: string,
  ): ReadableStream<LanguageModelV3StreamPart> {
    const timeoutMs = this.options.timeout
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES
    const maxRetryDelayMs = this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
    const fetchImpl = this.options.fetch ?? fetch
    const url = `${this.apiBase()}/alpha/generate`
    const bodyStr = JSON.stringify(body)

    return new ReadableStream<LanguageModelV3StreamPart>({
      start: async (streamController) => {
        const fail = (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error)
          streamController.enqueue({ type: "error", error: new Error(redactCommandCodeErrorText(message)) })
          streamController.close()
        }

        const handleEvent = (event: unknown): boolean => {
          if (!isRecord(event)) return false
          try {
            const parts = ccEventToStreamPart(event)
            let finished = false
            for (const part of parts) {
              if (part.type === "finish") {
                finished = true
                const usage = part.usage
                calculateCommandCodeCost(this.costForModel(), {
                  input: usage.inputTokens.total ?? 0,
                  output: usage.outputTokens.total ?? 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                })
              }
              streamController.enqueue(part)
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
          if (!apiKey) throw abortError("Aborted")

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
            streamController.enqueue({
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
