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
  ccEventIsTerminal,
  createOpenAIStreamParser,
  createAnthropicStreamParser,
  finishCarriesReportedUsage,
  finishIsPauseTurn,
  addAiSdkUsage,
  ProviderStreamError,
  type StreamEventParser,
} from "./stream.js"
import { getApiBase, getCmdZdr } from "../env.js"
import { normalizePlan } from "../catalog/plans.js"
import { redactCommandCodeErrorText, commandCodeErrorMessage, readGate } from "./redact.js"
import {
  mappedReasoningEffort,
  resolveProviderReasoning,
  thinkingMetadataForModel,
  isReasoningModel,
} from "./reasoning.js"
import { modelSupportsImageInput } from "./modalities.js"
import {
  classifyHttpFailure,
  classifyStreamError,
  retryBackoffMs,
  raceAbort,
  abortError,
  timeoutError,
  delay,
  NETWORK_FAILURE,
  TRUNCATION_FAILURE,
  UPGRADE_REQUIRED_FAILURE,
  VERSION_GATE_FAILURE,
  PAUSE_TURN_LIMIT_FAILURE,
  type Failure,
} from "./retry.js"
import { projectSlugFromPath } from "./project-slug.js"
import { FACTS_PACKAGE_VERSION } from "../catalog/facts.js"

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
  // Explicit plan pin for transport selection (normalized via normalizePlan).
  // Only a pin that resolves to "go" selects the legacy transport; with no pin
  // the session starts on the Provider API and a Go account flips via the
  // documented 403 fallback. Also honoured via COMMANDCODE_PLAN env and
  // per-call providerOptions.
  plan?: string
}

/**
 * The `x-command-code-version` the legacy `/alpha/generate` transport reports
 * (issue #173). The gateway version-gates this header — an absent, unparseable
 * or too-old value answers `403 upgrade_required` with a `minVersion` — so a
 * frozen literal drifts into a hard failure as upstream moves (the pre-#173
 * `1.15.1` was ten CLI releases stale). The value is the command-code build the
 * Snapshot was refreshed from: `npm run refresh:snapshot` rewrites
 * `FACTS_PACKAGE_VERSION` from the published package's `latest` dist-tag, and
 * the release pipeline gates on that refresh (ADR-0003), so the reported
 * version moves with the published CLI instead of a frozen literal.
 * `tests/provider-version-gate.test.ts` keeps it clear of the floor the live
 * gate last recorded. The legacy gateway is the only consumer:
 * `/provider/v1/*` is not version-gated.
 */
export const COMMAND_CODE_CLI_VERSION = FACTS_PACKAGE_VERSION
const DEFAULT_GENERATE_MAX_TOKENS = 64_000
/**
 * The plugin's own ladder is short and fast on purpose (issue #171): the hosts
 * already run their own slower ladders outside the plugin (v1 1.18.30: 5
 * retries, no partial-output guard; v2 2.0.3: 4 retries, hard
 * `!outputStarted` gate), so replaying a transient failure twice here recovers
 * the common 503/429 blip without stacking a second, host-sized wait. Upstream
 * `command-code@1.54.0` sizes its ladder for the standalone CLI (10 attempts);
 * this one is deliberately smaller. Override via provider `options.maxRetries`
 * (v1) / `settings.maxRetries` (v2).
 */
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
/**
 * How many times a paused turn may be continued before the transport gives up
 * (issue #172). Upstream `command-code@1.54.0` bounds both of its paths with
 * `Ph = 5` — the first request plus five continuations — and the bound is
 * load-bearing: a `pause_turn` loops on the same request, so without it a
 * provider that keeps pausing would be re-POSTed forever. Six paused responses
 * of real work is already a very long turn.
 */
const MAX_PAUSE_CONTINUATIONS = 5

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
 * Internal marker (issue #56 safety net): the Provider API answered its
 * plan-gate `403` — the documented `upgrade_required` envelope, or the live
 * `/messages` `permission_error` phrasing that omits the code (issue #175).
 * The transport flips the session to the legacy `/alpha/generate` transport
 * and retries once. Never surfaced to callers — but it carries its failure
 * kind like every other transport-raised error, so the vocabulary in
 * `retry.ts` names the one failure the ladder never replays (issue #171).
 */
class UpgradeRequiredError extends Error implements ClassifiedTransportError {
  readonly transportError = true as const
  readonly failure = UPGRADE_REQUIRED_FAILURE
  readonly status = 403
  constructor() {
    super("Command Code Provider API requires a plan upgrade (403 upgrade_required)")
    this.name = "UpgradeRequiredError"
  }
}

/**
 * Errors the transport raises itself, which `fail` surfaces without re-wrapping
 * (issue #170). The marker carries the invariant: the message is the
 * transport's own, already redacted where it is built, and the metadata an AI
 * SDK v3 `error` part has room for — `name`, `status` — rides on the instance.
 */
interface TransportError extends Error {
  readonly transportError: true
}

/** A transport-raised error carrying the failure the ladder classifies. */
interface ClassifiedTransportError extends TransportError {
  readonly failure: Failure
}

function isTransportError(error: unknown): error is TransportError {
  return (
    error instanceof Error &&
    (error as Error & { transportError?: unknown }).transportError === true
  )
}

/** The classified failure behind a thrown error, when the transport raised it. */
function failureOf(error: unknown): Failure | undefined {
  return error instanceof Error ? (error as Partial<ClassifiedTransportError>).failure : undefined
}

/**
 * The failure behind a caught error: the transport's own classification when it
 * raised one, else the provider error event's own rule, else `fallback` — which
 * the retry loop reads as a network failure, while the event loop (where only a
 * codec error can be caught) treats its absence as fatal.
 */
function classifyCaught(error: unknown, fallback?: Failure): Failure | undefined {
  return (
    failureOf(error) ??
    (error instanceof ProviderStreamError ? classifyStreamError(error.facts) : fallback)
  )
}

/**
 * A failure the transport itself classified (issue #171). The `Failure` rides
 * on the error so the retry loop reads the cause instead of the catch site;
 * the message is the transport's own, already redacted where it is built.
 */
class TransportFailureError extends Error implements ClassifiedTransportError {
  readonly transportError = true as const
  readonly failure: Failure
  constructor(message: string, failure: Failure) {
    super(message)
    this.name = "TransportFailureError"
    this.failure = failure
  }
}

/**
 * The response body ended cleanly without a terminal event — a proxy/CDN
 * truncation, or a server that flushed partial work and ended the body. It is
 * raised instead of fabricating a `finish(stop)` with zeroed usage, which
 * masked a dropped turn as a complete answer (issue #170). The message mirrors
 * upstream `command-code@1.54.0` verbatim, and `name`/`status` ride on the
 * Error because an AI SDK v3 `error` part carries nothing else.
 */
class TruncatedStreamError extends Error implements ClassifiedTransportError {
  readonly transportError = true as const
  readonly failure = TRUNCATION_FAILURE
  readonly status = 502
  constructor() {
    // Redacted where it is built, so `fail` may surface the instance as-is even
    // if the wording ever grows a provider-supplied part.
    super(
      redactCommandCodeErrorText(
        "Stream ended unexpectedly before completion (no finish event) — response was truncated",
      ),
    )
    this.name = "TruncatedStreamError"
  }
}

/**
 * The stream declared a finish but never reported the turn's usage: an OpenAI
 * `finish_reason` chunk arrived and the trailing usage-only chunk never did.
 * Emitting that held finish would report a complete turn at zero cost, so the
 * failure is raised instead — retryable while nothing is visible, exactly like
 * a truncation, since the body cannot be trusted to have ended the turn
 * (issue #171).
 */
class MissingUsageError extends Error implements ClassifiedTransportError {
  readonly transportError = true as const
  readonly failure = TRUNCATION_FAILURE
  readonly status = 502
  constructor() {
    super(
      redactCommandCodeErrorText(
        "Stream ended before the usage report arrived (no usage chunk) — response was truncated",
      ),
    )
    this.name = "MissingUsageError"
  }
}

/**
 * The provider kept pausing the turn past `MAX_PAUSE_CONTINUATIONS` (issue
 * #172). Upstream carries the last raw `pause_turn` reason out of its loop,
 * which neither host reads as an ending — v1 resolves the unknown reason to
 * `other` (a completed turn), v2 rejects it as a retryable incomplete stream —
 * so a turn that never finished is failed here instead. Redacted where it is
 * built, like every transport-raised error.
 */
class PauseTurnLimitError extends Error implements ClassifiedTransportError {
  readonly transportError = true as const
  readonly failure = PAUSE_TURN_LIMIT_FAILURE
  constructor(limit: number) {
    super(
      redactCommandCodeErrorText(
        `Command Code kept pausing this turn after ${limit} continuations (pause_turn) — the turn did not finish`,
      ),
    )
    this.name = "PauseTurnLimitError"
  }
}

/**
 * The server refused the version this plugin reports (issue #173): the legacy
 * gateway's `403 upgrade_required` whose body names a `minVersion` (or says the
 * client is out of date). The body's own wording tells the reader to update
 * "the Command Code CLI" — a binary a plugin user is not running — so the
 * message is rebuilt here to name the plugin instead, and the server's minimum
 * when it named one. It is a fatal status, never the transport flip: nothing
 * about the plan changed, and the same build would get the same 403 on either
 * endpoint.
 */
class VersionGateError extends Error implements ClassifiedTransportError {
  readonly transportError = true as const
  readonly failure = VERSION_GATE_FAILURE
  readonly status = 403
  constructor(minimumVersion: string | undefined, reportedVersion: string) {
    const floor = minimumVersion === undefined ? "" : `, server minimum ${minimumVersion}`
    super(
      redactCommandCodeErrorText(
        `Command Code rejected this plugin as out of date (reported client version ${reportedVersion}${floor}). Update the opencode-cmd-provider plugin to continue.`,
      ),
    )
    this.name = "VersionGateError"
  }
}

/** One request the transport will POST: the serialized body and the headers to
 * send it with. Built by the descriptor, never held on it, so a paused turn's
 * continuation can ask for a different body than the request it continues
 * (issue #185). */
interface TransportRequest {
  bodyStr: string
  headers: Record<string, string>
}

/** One transport pass: endpoint, request builder, event mapper, and whether the
 * Provider API plan-gate `403` on this endpoint flips the session to the
 * legacy transport. Only the Provider API descriptor flips; the legacy
 * descriptor never does, so a 403 on `/alpha/generate` — a stale-client
 * version gate included — flows through the existing error pipeline instead of
 * re-entering the fallback (issue #56 "retries once"). */
interface TransportDescriptor {
  url: string
  /** Builds the request for one pass. The transport asks here for every request
   * it sends — the first one, a replay, and a paused turn's continuation —
   * instead of reusing one frozen body, which is what lets a continuation
   * carry the paused assistant turn (issues #185, #188). Called once per
   * attempt, so a credential rotated mid-ladder is picked up by the next
   * request (issue #171 — the Authorization header is not a per-stream constant
   * any more). `pausedTurn` is the content the response being continued
   * emitted, and is empty for a first request and for a replay. */
  requestFor: (pausedTurn: readonly LanguageModelV3StreamPart[]) => TransportRequest
  /** A parser per attempt: a replay is a new stream, so per-stream state (block
   * lifecycles, tool buffers, the OpenAI last finish reason) must not cross
   * attempts (issue #171 — the ladder can newly replay after a synthesized
   * finish, a state the "nothing follows a terminal" invariant never left
   * room for). */
  createParser: () => StreamEventParser
  /** True for events that end this transport's stream without a finish part —
   * the legacy `{"type":"abort"}` terminal. A close after one is not a
   * truncation, the parts still open are closed, and no finish is fabricated
   * for it (issue #170); the Provider API descriptors omit it. */
  isTerminalEvent?: (event: unknown) => boolean
  flipOnUpgradeRequired: boolean
}

/** The legacy codec holds no per-stream state: its "parser" is the stateless
 * mapper, wrapped so every attempt gets an independent one (issue #171). */
function statelessParser(
  mapper: (event: unknown) => LanguageModelV3StreamPart[],
): StreamEventParser {
  const parse = ((event: unknown) => mapper(event)) as StreamEventParser
  parse.closeStream = () => []
  return parse
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

  /**
   * Safety-net flag (issue #56): once the Provider API answers its plan-gate
   * `403` — the documented `upgrade_required` envelope or the code-less live
   * `/messages` body (issue #175) — the session is pinned to the legacy
   * `/alpha/generate` transport for the lifetime of this model instance —
   * subsequent turns stay on legacy without re-hitting the Provider API (no
   * second 403). The Provider API has no path for Go-plan users (that is
   * exactly what the 403 documents), so the legacy transport is how every Go
   * account is served.
   */
  private pinnedToLegacy = false

  /**
   * Transport selection honours an explicitly written plan pin and nothing
   * else (issue #159): the per-call `providerOptions.plan` → the model's
   * `plan` option → `COMMANDCODE_PLAN`. Only an explicit `go` pin selects the
   * legacy transport; with no pin — and for every other plan — the session
   * starts on the Provider API, where a Go account flips to legacy through the
   * plan-gate `403` fallback above. No plan lookup is ever
   * made to route, so this path needs neither a credential nor the network.
   */
  private shouldUseProviderTransport(options: ModelCallOptions): boolean {
    if (this.pinnedToLegacy) return false
    const pin =
      normalizePlan(this.planArgFor(options)) ?? normalizePlan(process.env.COMMANDCODE_PLAN)
    return pin !== "go"
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
    // A generation that produced a result ends the turn: `other` is not a
    // finish reason a completed turn may carry (OpenCode v2 reads it as an
    // unknown, retryable failure — ADR-0013). A stream with no finish part at
    // all ends with the legacy `abort` terminal, whose turn upstream completes
    // too.
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "unknown" }
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
    if (this.shouldUseProviderTransport(options)) {
      return { stream: this.providerRunStream(options, isClaudeModel(this.modelId)) }
    }
    return { stream: this.runStream(options) }
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
    if (this.shouldUseProviderTransport(options)) {
      stream = this.providerRunStream(options, isClaudeModel(this.modelId), parts)
    } else {
      stream = this.runStream(options, parts)
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
        // The host's own knob when it sets one (opencode's v1 `chat.params`
        // hook and the v2 call options both reach `temperature`), otherwise
        // the 0.3 this transport has always sent (issue #173). Upstream omits
        // the field entirely when it has no value, but the legacy gateway has
        // been sent 0.3 since before #55 and nothing asks it to change.
        temperature: options.temperature ?? 0.3,
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      threadId: randomUUID(),
    }
  }

  /**
   * The legacy `/alpha/generate` headers, rebuilt per attempt off the
   * descriptor (issue #171). `x-co-flag` was dropped in #173: it does not
   * exist anywhere in `command-code@1.54.0` and is inert (identical responses
   * with and without it). `User-Agent`, `x-session-id` and `traceparent` stay
   * out on purpose — there is no session channel inside `doStream`, and their
   * effect is unobservable.
   */
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
          // Forwarded only when the host set one (issue #173): upstream's own
          // request builders omit the field when it has no value, and Anthropic
          // rejects a temperature alongside extended thinking — an invented
          // 0.3 here would break reasoning models.
          temperature: options.temperature,
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
        temperature: options.temperature,
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
    options: ModelCallOptions,
    isClaude: boolean,
    sink?: LanguageModelV3StreamPart[],
  ): ReadableStream<LanguageModelV3StreamPart> {
    const url = this.providerEndpoint()
    // Safety net (issue #56): the plan-gate `403` — either envelope, issue
    // #175 — pins this session to the legacy transport and retries the same
    // call once via POST {base}/alpha/generate with the legacy CLI wire
    // format. The legacy descriptor itself never flips, so the retry is
    // bounded to one.
    const legacyBodyStr = JSON.stringify(this.bodyFor(options))
    const legacyFallback: TransportDescriptor = {
      url: `${this.apiBase()}/alpha/generate`,
      // The legacy transport re-POSTs the same bytes for a continuation
      // (upstream `command-code@1.54.0` loops on the same request), so the
      // builder ignores the paused turn and returns the body frozen once for
      // this call. Rebuilding it per pass would move its `threadId` and
      // timestamp under the continuation.
      requestFor: () => ({ bodyStr: legacyBodyStr, headers: this.headersFor(options) }),
      createParser: () => statelessParser(ccEventToStreamPart),
      isTerminalEvent: ccEventIsTerminal,
      flipOnUpgradeRequired: false,
    }
    return this.transportStream(
      {
        url,
        // Rebuilt per pass, so a continuation lands in the same request shape
        // the first attempt sent (issue #185).
        requestFor: () => ({
          bodyStr: JSON.stringify(this.providerBodyFor(options, isClaude)),
          headers: this.providerHeadersFor(options),
        }),
        // Per-stream stateful parsers complete tool calls whose arguments
        // arrive across multiple SSE events (issue #55 tool-call parity); the
        // stateless mappers are kept for direct codec use.
        createParser: isClaude ? createAnthropicStreamParser : createOpenAIStreamParser,
        flipOnUpgradeRequired: true,
      },
      options.abortSignal,
      sink,
      legacyFallback,
    )
  }

  private runStream(
    options: ModelCallOptions,
    sink?: LanguageModelV3StreamPart[],
  ): ReadableStream<LanguageModelV3StreamPart> {
    // Frozen once per call: a continuation re-POSTs these exact bytes, which
    // is upstream `command-code@1.54.0`'s own behaviour on this endpoint
    // (issue #172).
    const bodyStr = JSON.stringify(this.bodyFor(options))
    return this.transportStream(
      {
        url: `${this.apiBase()}/alpha/generate`,
        requestFor: () => ({ bodyStr, headers: this.headersFor(options) }),
        createParser: () => statelessParser(ccEventToStreamPart),
        isTerminalEvent: ccEventIsTerminal,
        flipOnUpgradeRequired: false,
      },
      options.abortSignal,
      sink,
    )
  }

  /**
   * Deep internal seam: single SSE transport behind a small interface.
   * All retry/timeout/abort/redaction/stream-parsing/fallback logic
   * lives here; callers supply only the endpoint URL, body, headers and
   * the event→parts mapper. Depth gives leverage (N callers) and locality
   * (fix once, fixed everywhere). The eventToParts adapter varies across
   * the seam (CC vs OpenAI vs Anthropic) while the transport stays fixed.
   *
   * The optional legacyFallback implements the issue #56 safety net: when the
   * Provider API answers its plan-gate `403` (Go plan, no API access — in
   * either endpoint's envelope, issue #175), the session is pinned to the
   * legacy `/alpha/generate` transport and the same call retries once there —
   * the retry is bounded because only the provider descriptor carries
   * flipOnUpgradeRequired. The pin is sticky for the lifetime of this model
   * instance (no second Provider API hit on later turns).
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
        // True once any part other than `finish` reached the consumer. A
        // retried attempt replays the request from the start, so it may only
        // happen while the consumer has seen nothing — part lifecycles cannot
        // be replayed either. Per stream: the legacy fallback replays the whole
        // call, so the flip it belongs to reads this flag too (issue #170).
        let visibleEmitted = false
        // The same question asked of the request in flight. A paused turn's
        // continuation is a fresh request whose parts append to this stream, so
        // only the parts *it* emitted make its replay unsafe; the continuations
        // before it are never re-requested (issue #172). Reset per request.
        let attemptEmitted = false
        // The content the response being continued emitted. A continuation
        // carries it back into its own request (issue #188), so it is reset at
        // every request and read only by the builder of the next one — never
        // replayed, since a replay only follows an attempt that emitted
        // nothing (issue #185).
        let responseParts: LanguageModelV3StreamPart[] = []
        const emit = (part: LanguageModelV3StreamPart) => {
          if (part.type !== "finish") {
            visibleEmitted = true
            attemptEmitted = true
            responseParts.push(part)
          }
          sink?.push(part)
          streamController.enqueue(part)
        }
        // Set once an error part has ended the stream: nothing may be emitted
        // afterwards, and the controller must not be closed twice.
        let closed = false
        /** The `error` part's payload for a failure: a transport-raised error
         * (already redacted, and carrying the `name`/`status` an AI SDK v3
         * `error` part has no room for) is surfaced as-is, everything else is
         * re-wrapped with its message redacted (issue #170). */
        const surfacedError = (error: unknown): Error =>
          isTransportError(error)
            ? error
            : new Error(
                redactCommandCodeErrorText(error instanceof Error ? error.message : String(error)),
              )
        const fail = (error: unknown) => {
          if (closed) return
          emit({ type: "error", error: surfacedError(error) })
          streamController.close()
          closed = true
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
          /** Set once the stream saw a terminal event: a finish held for
           * emission, or a terminal that carries no finish part (the legacy
           * `abort`). Cleared when a synthesized finish is replayed — nothing
           * else can follow a terminal (issues #170, #171). */
          let terminalSeen = false
          /** Set by a terminal that carries no finish part: it ends the turn
           * *and* the read, since nothing after it belongs to the turn. */
          let terminalEndsRead = false
          /** True once the turn is settled the way the transport accepts it: a
           * terminal was seen and, when it was a `finish`, the finish carried
           * the provider's usage report. A finish whose usage the codec
           * synthesized does not settle the turn, so the ladder may still
           * replay the request while nothing is visible (issue #171). */
          const turnSettled = (): boolean =>
            terminalSeen && (heldFinish === undefined || finishCarriesReportedUsage(heldFinish))
          /**
           * Clears the terminal bookkeeping a response leaves behind. Both
           * things that follow one — a replay, and a paused turn's
           * continuation — start from nothing: the parts already emitted
           * belong to the consumer, never to the response that comes next
           * (issues #170, #171, #172). Written as a closure so the compiler
           * keeps treating `heldFinish` as the value `handleEvent` stores; an
           * inline reset narrows it to `undefined` for the rest of the scope.
           */
          const clearTerminalState = () => {
            heldFinish = undefined
            terminalSeen = false
            terminalEndsRead = false
          }
          /**
           * The turn's usage: every completed response's report, folded in as
           * it arrives (upstream's `addUsage2`). The finish emitted for the
           * turn carries it, so a resumed turn reports the sum of its
           * continuations and nothing a replay replaced (issue #172).
           */
          let turnUsage: LanguageModelV3Usage | undefined
          /** Folds one response's usage into the turn's running total. */
          const accumulateUsage = (usage: LanguageModelV3Usage): LanguageModelV3Usage =>
            (turnUsage = turnUsage === undefined ? usage : addAiSdkUsage(turnUsage, usage))
          /** The parts a stateful parser still has open — the last thing the
           * consumer sees before an error part ends the stream, or before the
           * clean end of a terminal that carries no finish (issue #170). Reads
           * the current attempt's parser, replaced at every attempt. */
          let parser: StreamEventParser | undefined
          const closeOpenParts = () => {
            for (const part of parser?.closeStream() ?? []) emit(part)
          }
          /** Handles one SSE event, recording the terminal it declared: a
           * `finish` held for emission (the read keeps draining for a trailing
           * usage chunk), or a finish-less terminal that ends the turn and the
           * read together — nothing after the legacy `abort` belongs to the
           * turn. A mapper error ends the stream through `fail`. */
          const handleEvent = (event: unknown): void => {
            if (!isRecord(event) || parser === undefined) return
            try {
              const parts = parser(event)
              for (const part of parts) {
                if (part.type === "finish") {
                  heldFinish = part
                } else {
                  emit(part)
                }
              }
              if (t.isTerminalEvent?.(event) ?? false) terminalEndsRead = true
              if (terminalEndsRead || heldFinish !== undefined) terminalSeen = true
            } catch (streamError) {
              // The mapper threw on an error event. A failure the event itself
              // flagged as retryable leaves through the ladder — the read
              // loop's catch replays the request while nothing is visible
              // (issue #171) — while a fatal one is surfaced here, after
              // closing the parts this stream left open so the error part
              // stays last (issue #72).
              const failure = classifyCaught(streamError)
              if (failure?.retryable) throw streamError
              closeOpenParts()
              fail(streamError)
              terminalSeen = true
            }
          }

          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
          const controller = new AbortController()
          const onOuterAbort = () => controller.abort()
          try {
            signal?.addEventListener("abort", onOuterAbort, { once: true })
            if (signal?.aborted) throw abortError("Aborted")
            let response!: Response
            // A paused turn is continued by re-POSTing the same body — upstream
            // `command-code@1.54.0` does exactly that in both of its paths
            // (`Ph = 5`) — and appending the continuation's parts to this
            // stream: the consumer sees one turn, ended by the last response's
            // finish. Every other ending leaves through `break`. The first
            // iteration is the request itself; each later one is a
            // continuation, which is what the counter counts.
            requestLoop: for (let continuations = 0; ; continuations++) {
              clearTerminalState()
              attemptEmitted = false
              // The paused turn this request continues: the parts the previous
              // response emitted, closed parts included. Empty for the first
              // request, whose builder sees no continuation.
              const pausedTurn = responseParts
              responseParts = []
              retryLoop: for (let attempt = 0; ; attempt++) {
                // A fresh parser: a replay is a new stream, and the previous
                // attempt's per-stream state (open blocks, tool buffers, the
                // OpenAI last finish reason) belongs to a response this one
                // replaces (issue #171).
                parser = t.createParser()
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

                // Asked for before the attempt is classified: a builder that
                // refuses the request (a paused turn this build cannot resume,
                // issue #188) is a statement about the request, not about a
                // response — the ladder never replays it, and the turn's
                // already-settled bookkeeping must not swallow it either.
                const request = t.requestFor(pausedTurn)

                try {
                  try {
                    response = await fetchImpl(t.url, {
                      method: "POST",
                      // Rebuilt per attempt (issue #171): a credential or header
                      // rotated mid-ladder is picked up by the next request.
                      headers: request.headers,
                      body: request.bodyStr,
                      signal: attemptController.signal,
                    })
                  } catch (fetchError: unknown) {
                    if (controller.signal.aborted) throw abortError("Aborted")
                    throw fetchError
                  }

                  // One failure vocabulary for every non-OK response: the
                  // classification decides replay vs. surface, and the response's
                  // own Retry-After is only ever its wait (issue #171).
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
                    // One reading of the 403 body for both gates (issues #56,
                    // #173): whichever it is, it is never replayed, and only the
                    // plan gate may flip the transport.
                    const gate = readGate(response.status, parsedBody ?? errBody)
                    // The version gate (issue #173) is checked first: the server
                    // refused the version this build reports, so the fix is an
                    // updated plugin, not the legacy transport. The message names
                    // the plugin instead of the CLI the server's body blames.
                    if (gate.versionGate) {
                      throw new VersionGateError(gate.minimumVersion, COMMAND_CODE_CLI_VERSION)
                    }
                    // Safety net (issue #56): the plan-gate 403 on the Provider
                    // API flips the session to the legacy transport — the
                    // documented `upgrade_required` envelope or the live
                    // `/messages` phrasing without a code (issue #175); the
                    // legacy descriptor itself never flips (so the retry is
                    // bounded to one), and any other status flows through the
                    // existing error/redaction pipeline unchanged.
                    if (t.flipOnUpgradeRequired && gate.planGate) {
                      throw new UpgradeRequiredError()
                    }
                    const failure = classifyHttpFailure({
                      status: response.status,
                      body: parsedBody,
                      retryAfter: response.headers.get("retry-after"),
                      maxDelayMs: maxRetryDelayMs,
                    })
                    const safeBody = redactCommandCodeErrorText(errBody).slice(0, 500)
                    const detail = redactCommandCodeErrorText(
                      errorDetail ?? (safeBody || "Provider returned an error"),
                    )
                    throw new TransportFailureError(
                      failure.kind === "retry-after-cap"
                        ? `Command Code API error ${response.status}: Retry-After delay exceeds max retry delay`
                        : `Command Code API error ${response.status}: ${detail}`,
                      failure,
                    )
                  }

                  // --- Read response stream ---
                  reader = response.body?.getReader()
                  if (!reader) throw new Error("No response body")

                  const decoder = new TextDecoder()
                  let buffer = ""

                  readLoop: for (;;) {
                    if (controller.signal.aborted) throw abortError("Aborted")
                    const { done, value } = await raceAttempt(reader.read())
                    if (done) {
                      if (!closed && buffer.trim()) handleEvent(parseStreamEventLine(buffer))
                      break
                    }
                    if (controller.signal.aborted) throw abortError("Aborted")

                    buffer += decoder.decode(value, { stream: true })
                    const lines = buffer.split("\n")
                    buffer = lines.pop() ?? ""

                    for (const line of lines) {
                      if (controller.signal.aborted) throw abortError("Aborted")
                      handleEvent(parseStreamEventLine(line))
                      // Do NOT break on a finish event: an OpenAI Provider stream
                      // may send the terminal `usage`-only chunk (choices:[]) after
                      // a finish_reason chunk. Keep draining so heldFinish is
                      // replaced with the usage-bearing finish before we emit it.
                      // A finish-less terminal and an error event do end the read:
                      // nothing after them belongs to the turn (issue #170), and
                      // the error part is the last thing the consumer may see
                      // (issue #72).
                      if (closed || terminalEndsRead) break readLoop
                    }
                  }

                  // The body ended. Only a terminal event completes a turn: a
                  // clean close without one is a truncated response and must not
                  // look like a successful stop (issue #170).
                  if (!terminalSeen && !closed) throw new TruncatedStreamError()
                  // A finish the codec had to synthesize carries no usage report:
                  // it came from an OpenAI `finish_reason` chunk whose trailing
                  // usage-only chunk never arrived, so holding it would report a
                  // complete turn at zero cost. Retryable while nothing is
                  // visible, exactly like a truncation (issue #171).
                  if (
                    !closed &&
                    heldFinish !== undefined &&
                    !finishCarriesReportedUsage(heldFinish)
                  ) {
                    throw new MissingUsageError()
                  }
                  // A finish-less terminal ends the read early, so the body may
                  // still be open: release it instead of waiting for a server that
                  // has already aborted the turn.
                  await reader.cancel().catch(() => {})
                  break retryLoop
                } catch (caught: unknown) {
                  // Stream-level error (e.g. API returned 200 OK but sent an error
                  // event) or per-attempt timeout during stream reading.
                  await reader?.cancel().catch(() => {})
                  try {
                    reader?.releaseLock()
                  } catch {}
                  reader = undefined

                  // The plan-gate 403 is a transport flip, never a retry:
                  // fall back to the legacy transport immediately (issue #56),
                  // regardless of maxRetries.
                  if (caught instanceof UpgradeRequiredError) throw caught

                  if (controller.signal.aborted) throw caught

                  // The body died after an accepted terminal: the turn is already
                  // in hand — a finish that reported its usage, or a finish-less
                  // terminal — so a read failure arriving afterwards cannot change
                  // the answer. Complete the turn instead of discarding it
                  // (issue #171; the "read error after the finish part" finding it
                  // was raised from). An outer abort already left through the
                  // check above.
                  if (turnSettled() && !closed) break retryLoop

                  // A per-attempt timeout is a network failure, and the error it
                  // surfaces is the timeout's own wording — never the AbortError
                  // that carried it (the fetch path rejects with one; the read
                  // path is normalized by `raceAttempt`).
                  const streamError =
                    attemptTimedOut && !isTransportError(caught)
                      ? new TransportFailureError(timeoutError(timeoutMs).message, NETWORK_FAILURE)
                      : caught

                  // The cause decides, never the catch site: a failure the
                  // transport classified carries its own kind, the provider's
                  // error event is classified from the facts it carried, and
                  // anything else is a network failure (issue #171).
                  const failure = classifyCaught(streamError) ?? NETWORK_FAILURE
                  // Replay only a failure whose own kind is transient, and never
                  // after this request emitted visible content (a replay would
                  // duplicate what the consumer saw), after an accepted terminal
                  // settled the turn, or once the budget is spent (issues #170,
                  // #171, #172).
                  const canRetry =
                    failure.retryable && !turnSettled() && !attemptEmitted && attempt < maxRetries
                  if (canRetry) {
                    // Nothing to carry over into the replay: reaching it means
                    // nothing visible was emitted and no accepted terminal was
                    // seen, so the attempt's terminal bookkeeping is cleared
                    // rather than carried into the next request (a synthesized
                    // finish is the one terminal-shaped state a retry follows).
                    clearTerminalState()
                    const waitMs = failure.waitMs ?? retryBackoffMs(attempt, maxRetryDelayMs)
                    if (waitMs > 0) await delay(waitMs, controller.signal)
                    continue retryLoop
                  }
                  throw streamError
                } finally {
                  controller.signal.removeEventListener("abort", onOuterAbort2)
                  clearAttemptTimeout()
                }
              }

              // An error part already ended the stream; nothing else may follow it.
              if (closed) return

              // The provider paused the turn: no turn has ended, so the held
              // finish is not emitted. Its usage joins the turn's total and the
              // same body is re-POSTed for the continuation — up to
              // MAX_PAUSE_CONTINUATIONS, after which the turn is failed rather
              // than reported with the pause as its finish reason (issue #172).
              if (heldFinish === undefined || !finishIsPauseTurn(heldFinish)) break requestLoop
              if (continuations >= MAX_PAUSE_CONTINUATIONS) {
                throw new PauseTurnLimitError(MAX_PAUSE_CONTINUATIONS)
              }
              // The continuation is a new response: close whatever the paused one
              // left open before its successor opens its own parts.
              closeOpenParts()
              accumulateUsage(heldFinish.usage)
            }

            // An error part already ended the stream; nothing else may follow it.
            if (closed) return

            if (heldFinish) {
              // The finish part is emitted after the body is fully drained so
              // the terminal usage chunk (OpenAI: separate usage-only chunk;
              // Anthropic: message_delta) is incorporated — and, for a resumed
              // turn, with every continuation's usage folded in (issue #172).
              // The transport only reports that usage: OpenCode prices the turn
              // from the cost rates the model advertises (issue #176).
              const finish = { ...heldFinish, usage: accumulateUsage(heldFinish.usage) }
              emit(finish)
            } else {
              // A terminal that carries no finish part — the legacy
              // `{"type":"abort"}` event. The stream ends cleanly: no finish is
              // fabricated for it (issue #170), but the parts the server left
              // open are closed before the consumer sees the end (issue #72).
              closeOpenParts()
            }
            streamController.close()
          } catch (error: unknown) {
            // Terminal failure: close the parser's open parts before the error
            // part that ends the stream (abort, timeout, or a read error that
            // survived the retry budget) — issue #72.
            closeOpenParts()
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
            // The pin is unconditional: the plan gate is a statement about the
            // account, so later turns start on legacy either way. The flip
            // replays this call on the legacy transport from the start, which
            // only makes sense while the consumer has seen nothing — a 403
            // arriving after a paused turn's continuation would otherwise
            // append a second copy of the turn to the same stream (issue #172).
            this.pinnedToLegacy = true
            if (!visibleEmitted) {
              try {
                await runTransport(legacyFallback)
                return
              } catch (fallbackError: unknown) {
                fail(fallbackError)
                return
              }
            }
          }
          fail(error)
        }
      },
    })
  }
}
