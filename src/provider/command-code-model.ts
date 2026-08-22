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
import { getApiBase, getCmdZdr } from "../env.js"
import { resolvePlan, type PlanResolutionCache } from "../deals/plan-summary.js"
import {
  redactCommandCodeErrorText,
  commandCodeErrorMessage,
  isUpgradeRequiredError,
} from "./redact.js"
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

/**
 * Internal marker (issue #56 safety net): the Provider API returned a
 * documented `403 upgrade_required` ("You're on the Go plan, the only plan
 * without API access"). The transport flips the session to the legacy
 * `/alpha/generate` transport and retries once. Never surfaced to callers.
 */
class UpgradeRequiredError extends Error {
  constructor() {
    super("Command Code Provider API requires a plan upgrade (403 upgrade_required)")
  }
}

/** One transport pass: endpoint, body, headers, event mapper, and whether a
 * documented `403 upgrade_required` on this endpoint flips the session to the
 * legacy transport. Only the Provider API descriptor flips; the legacy
 * descriptor never does, so a 403 on `/alpha/generate` flows through the
 * existing error pipeline instead of re-entering the fallback (issue #56
 * "retries once"). */
interface TransportDescriptor {
  url: string
  bodyStr: string
  headers: Record<string, string>
  eventToParts: (event: unknown) => LanguageModelV3StreamPart[]
  flipOnUpgradeRequired: boolean
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
   * Safety-net flag (issue #56): once the Provider API answers a documented
   * `403 upgrade_required`, the session is pinned to the legacy
   * `/alpha/generate` transport for the lifetime of this model instance —
   * subsequent turns stay on legacy without re-hitting the Provider API (no
   * second 403). The Provider API has no path for Go-plan users (that is
   * exactly what the 403 documents), so the plugin's legacy transport is the
   * only way to keep serving a plan-detection miss that routed a true Go user
   * there.
   */
  private pinnedToLegacy = false

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
    if (this.pinnedToLegacy) return false
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? ""}`,
      ...this.options.headers,
      ...(options.headers ?? {}),
    }
    // ZDR passthrough (issue #57): the Provider API honours the CLI's own
    // opt-in — CMD_ZDR=1 → every Provider API request carries x-cmd-zdr: 1
    // (https://commandcode.ai/docs/provider "Zero data retention (ZDR)").
    // Only the exact value "1" opts in; the legacy /alpha/generate transport
    // never sends the header (headersFor is untouched). The header's presence
    // is owned solely by the env opt-in, not by caller-supplied headers: with
    // CMD_ZDR=1 the value is forced to "1", and with it off any caller-supplied
    // x-cmd-zdr (any casing) is stripped so a non-opted-in session never emits
    // ZDR.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-cmd-zdr") delete headers[key]
    }
    if (getCmdZdr()) headers["x-cmd-zdr"] = "1"
    return headers
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
    // Safety net (issue #56): a documented `403 upgrade_required` pins this
    // session to the legacy transport and retries the same call once via
    // POST {base}/alpha/generate with the legacy CLI wire format. The legacy
    // descriptor itself never flips, so the retry is bounded to one.
    const legacyFallback: TransportDescriptor = {
      url: `${this.apiBase()}/alpha/generate`,
      bodyStr: JSON.stringify(this.bodyFor(options)),
      headers: this.headersFor(options),
      eventToParts: ccEventToStreamPart,
      flipOnUpgradeRequired: false,
    }
    return this.transportStream(
      { url, bodyStr, headers, eventToParts: parser, flipOnUpgradeRequired: true },
      signal,
      sink,
      legacyFallback,
    )
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
    return this.transportStream(
      { url, bodyStr, headers, eventToParts: ccEventToStreamPart, flipOnUpgradeRequired: false },
      signal,
      sink,
    )
  }

  /**
   * Deep internal seam: single SSE transport behind a small interface.
   * All retry/timeout/abort/redaction/stream-parsing/cost/fallback logic
   * lives here; callers supply only the endpoint URL, body, headers and
   * the event→parts mapper. Depth gives leverage (N callers) and locality
   * (fix once, fixed everywhere). The eventToParts adapter varies across
   * the seam (CC vs OpenAI vs Anthropic) while the transport stays fixed.
   *
   * The optional legacyFallback implements the issue #56 safety net: when the
   * Provider API answers a documented `403 upgrade_required` (Go plan, no API
   * access), the session is pinned to the legacy `/alpha/generate` transport
   * and the same call retries once there — the retry is bounded because only
   * the provider descriptor carries flipOnUpgradeRequired. The pin is sticky
   * for the lifetime of this model instance (no second Provider API hit on
   * later turns).
   */
  private transportStream(
    descriptor: TransportDescriptor,
    signal: AbortSignal | undefined,
    sink?: LanguageModelV3StreamPart[],
    legacyFallback?: TransportDescriptor,
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

        /**
         * Runs one full request/read pass against a transport descriptor.
         * Emits parts as they arrive and closes the stream on success or on
         * an outer abort; any other error is rethrown so the caller decides
         * (upgrade fallback vs. surface as an error part).
         */
        const runTransport = async (t: TransportDescriptor): Promise<void> => {
          /**
           * The single `finish` part is held back and emitted only after the
           * response body is fully drained. OpenAI-style Provider streams send
           * `finish_reason` on the last content chunk and the real `usage` on
           * a *separate* trailing usage-only chunk (choices:[]); emitting the
           * finish as soon as a finish_reason chunk is seen would drop that
           * trailing usage and report zeroed usage/cost. Holding the finish
           * lets a later usage-bearing finish replace the earlier one.
           */
          let heldFinish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined
          const handleEvent = (event: unknown): boolean => {
            if (!isRecord(event)) return false
            try {
              const parts = t.eventToParts(event)
              for (const part of parts) {
                if (part.type === "finish") {
                  heldFinish = part
                } else {
                  emit(part)
                }
              }
              return heldFinish !== undefined
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
                  response = await fetchImpl(t.url, {
                    method: "POST",
                    headers: t.headers,
                    body: t.bodyStr,
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
                  let parsedBody: unknown
                  let errorDetail: string | undefined
                  try {
                    parsedBody = JSON.parse(errBody)
                    errorDetail = commandCodeErrorMessage(parsedBody)
                  } catch {
                    // Preserve useful plain-text provider errors only after secret
                    // redaction; upstream/proxy bodies may echo credentials.
                  }
                  // Safety net (issue #56): a documented 403 upgrade_required
                  // on the Provider API flips the session to the legacy
                  // transport; the legacy descriptor itself never flips (so
                  // the retry is bounded to one), and any other status flows
                  // through the existing error/redaction pipeline unchanged.
                  if (
                    t.flipOnUpgradeRequired &&
                    isUpgradeRequiredError(response.status, parsedBody ?? errBody)
                  ) {
                    throw new UpgradeRequiredError()
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
                    if (buffer.trim()) {
                      if (handleEvent(parseStreamEventLine(buffer))) finished = true
                    }
                    break
                  }
                  if (controller.signal.aborted) throw abortError("Aborted")

                  buffer += decoder.decode(value, { stream: true })
                  const lines = buffer.split("\n")
                  buffer = lines.pop() ?? ""

                  for (const line of lines) {
                    if (controller.signal.aborted) throw abortError("Aborted")
                    if (handleEvent(parseStreamEventLine(line))) finished = true
                    // Do NOT break on a finish event: an OpenAI Provider stream
                    // may send the terminal `usage`-only chunk (choices:[]) after
                    // a finish_reason chunk. Keep draining so heldFinish is
                    // replaced with the usage-bearing finish before we emit it.
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

                // 403 upgrade_required is a transport flip, never a retry:
                // fall back to the legacy transport immediately (issue #56),
                // regardless of maxRetries.
                if (streamError instanceof UpgradeRequiredError) throw streamError

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

            if (heldFinish) {
              // The finish part is emitted after the body is fully drained so
              // the terminal usage chunk (OpenAI: separate usage-only chunk;
              // Anthropic: message_delta) is incorporated.
              calculateCommandCodeCost(
                this.costForModel(),
                costUsageFromAiSdkUsage(heldFinish.usage),
              )
              emit(heldFinish)
            } else if (!finished) {
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
              throw error
            }
          } finally {
            signal?.removeEventListener("abort", onOuterAbort)
          }
        }

        try {
          await runTransport(descriptor)
        } catch (error: unknown) {
          if (legacyFallback && error instanceof UpgradeRequiredError) {
            this.pinnedToLegacy = true
            try {
              await runTransport(legacyFallback)
              return
            } catch (fallbackError: unknown) {
              fail(fallbackError)
              return
            }
          }
          fail(error)
        }
      },
    })
  }
}
