// tests/helpers/mock-cc.ts — in-process mock Command Code server (PLAN #3 Part A)
//
// Used by the stream tests here and by integration tests in #8/#9 and the
// E2E harness in #12. Emulates POST /alpha/generate (SSE) and
// GET /provider/v1/models, and records request hits.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export interface MockCcOptions {
  models?: unknown
  /** events to emit for POST /alpha/generate; last event wins for infinite repetition */
  stream?: Array<Record<string, unknown> | "end">
  status?: number
  errorBody?: string
  /** Retry-After seconds sent with a non-OK /alpha/generate response (mirrored on provider endpoints) */
  retryAfter?: number
  /** how many consecutive error responses /alpha/generate serves before falling through to stream (default: always error) */
  generateErrorCount?: number
  /** called with the parsed /alpha/generate request body and headers */
  onGenerate?: (body: Record<string, unknown>, headers: Record<string, string>) => void
  /** OpenAI chat completions SSE events for POST /provider/v1/chat/completions */
  chatCompletionsStream?: Array<Record<string, unknown> | "end">
  chatCompletionsStatus?: number
  chatCompletionsErrorBody?: string
  /** Retry-After seconds sent with a non-OK /provider/v1/chat/completions response */
  chatCompletionsRetryAfter?: number
  /** how many consecutive error responses chat/completions serves before falling through to stream */
  chatCompletionsErrorCount?: number
  onChatCompletions?: (body: Record<string, unknown>, headers: Record<string, string>) => void
  /** Anthropic messages SSE events for POST /provider/v1/messages */
  messagesStream?: Array<Record<string, unknown> | "end">
  messagesStatus?: number
  messagesErrorBody?: string
  /** Retry-After seconds sent with a non-OK /provider/v1/messages response */
  messagesRetryAfter?: number
  /** how many consecutive error responses messages serves before falling through to stream */
  messagesErrorCount?: number
  onMessages?: (body: Record<string, unknown>, headers: Record<string, string>) => void
  /** served at GET /registry (npm registry JSON: { "dist-tags": { latest } }) */
  registry?: unknown
  /** served at GET /registry as-is (non-JSON body, e.g. to exercise parse failure) */
  registryRaw?: string
  /** served at GET /models.md (raw command-code models.md text) */
  factsMd?: string
  /** served at GET /cli.mjs (raw command-code CLI bundle) */
  modalitiesBundle?: string
  /** JSON body served at GET /alpha/whoami (plan detection); 404 when unset */
  whoami?: unknown
  /** status for GET /alpha/whoami (e.g. 500 to exercise the fall-through) */
  whoamiStatus?: number
  /** called with the headers of each GET /alpha/whoami request */
  onWhoami?: (headers: Record<string, string>) => void
}

export interface MockCcHits {
  generate: number
  models: number
  chatCompletions: number
  messages: number
  whoami: number
}

export function startMockCc(
  options: MockCcOptions = {},
): Promise<{ url: string; close: () => Promise<void>; hits: MockCcHits }> {
  const hits: MockCcHits = { generate: 0, models: 0, chatCompletions: 0, messages: 0, whoami: 0 }
  const server: Server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      if (req.url === "/provider/v1/models") {
        hits.models++
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(options.models ?? { object: "list", data: [] }))
        return
      }
      if (req.url === "/alpha/whoami" && req.method === "GET") {
        hits.whoami++
        options.onWhoami?.((req.headers ?? {}) as Record<string, string>)
        if (options.whoamiStatus !== undefined && options.whoamiStatus >= 400) {
          res.writeHead(options.whoamiStatus, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: { message: "mock whoami error" } }))
          return
        }
        if (options.whoami === undefined) {
          res.writeHead(404)
          res.end("not found")
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(options.whoami))
        return
      }
      if (req.url === "/alpha/generate" && req.method === "POST") {
        hits.generate++
        options.onGenerate?.(
          body ? (JSON.parse(body) as Record<string, unknown>) : {},
          (req.headers ?? {}) as Record<string, string>,
        )
        const errorsLeft =
          options.generateErrorCount !== undefined
            ? options.generateErrorCount - (hits.generate - 1)
            : options.status && options.status >= 400
              ? Number.POSITIVE_INFINITY
              : 0
        if (errorsLeft > 0) {
          res.writeHead(options.status ?? 500, {
            "content-type": "application/json",
            ...(options.retryAfter !== undefined
              ? { "retry-after": String(options.retryAfter) }
              : {}),
          })
          res.end(options.errorBody ?? JSON.stringify({ error: { message: "mock error" } }))
          return
        }
        res.writeHead(200, { "content-type": "text/event-stream" })
        const events = options.stream ?? []
        let index = 0
        const timer = setInterval(() => {
          const evt = events[index]
          if (evt === "end" || index >= events.length || res.writableEnded) {
            clearInterval(timer)
            res.end()
            return
          }
          res.write(`data: ${JSON.stringify(evt)}\n\n`)
          index++
        }, 5)
        return
      }
      if (req.url === "/provider/v1/chat/completions" && req.method === "POST") {
        hits.chatCompletions++
        options.onChatCompletions?.(
          body ? (JSON.parse(body) as Record<string, unknown>) : {},
          (req.headers ?? {}) as Record<string, string>,
        )
        const chatErrorsLeft =
          options.chatCompletionsErrorCount !== undefined
            ? options.chatCompletionsErrorCount - (hits.chatCompletions - 1)
            : options.chatCompletionsStatus && options.chatCompletionsStatus >= 400
              ? Number.POSITIVE_INFINITY
              : 0
        if (chatErrorsLeft > 0) {
          res.writeHead(options.chatCompletionsStatus ?? 500, {
            "content-type": "application/json",
            ...(options.chatCompletionsRetryAfter !== undefined
              ? { "retry-after": String(options.chatCompletionsRetryAfter) }
              : {}),
          })
          res.end(
            options.chatCompletionsErrorBody ??
              JSON.stringify({
                error: { message: "mock chat completions error", type: "invalid_request_error" },
              }),
          )
          return
        }
        res.writeHead(200, { "content-type": "text/event-stream" })
        const events = options.chatCompletionsStream ?? []
        let index = 0
        const timer = setInterval(() => {
          const evt = events[index]
          if (evt === "end" || index >= events.length || res.writableEnded) {
            clearInterval(timer)
            res.end()
            return
          }
          res.write(`data: ${JSON.stringify(evt)}\n\n`)
          index++
        }, 5)
        return
      }
      if (req.url === "/provider/v1/messages" && req.method === "POST") {
        hits.messages++
        options.onMessages?.(
          body ? (JSON.parse(body) as Record<string, unknown>) : {},
          (req.headers ?? {}) as Record<string, string>,
        )
        const messagesErrorsLeft =
          options.messagesErrorCount !== undefined
            ? options.messagesErrorCount - (hits.messages - 1)
            : options.messagesStatus && options.messagesStatus >= 400
              ? Number.POSITIVE_INFINITY
              : 0
        if (messagesErrorsLeft > 0) {
          res.writeHead(options.messagesStatus ?? 500, {
            "content-type": "application/json",
            ...(options.messagesRetryAfter !== undefined
              ? { "retry-after": String(options.messagesRetryAfter) }
              : {}),
          })
          res.end(
            options.messagesErrorBody ??
              JSON.stringify({
                type: "error",
                error: { type: "invalid_request_error", message: "mock messages error" },
              }),
          )
          return
        }
        res.writeHead(200, { "content-type": "text/event-stream" })
        const events = options.messagesStream ?? []
        let index = 0
        const timer = setInterval(() => {
          const evt = events[index]
          if (evt === "end" || index >= events.length || res.writableEnded) {
            clearInterval(timer)
            res.end()
            return
          }
          // Anthropic SSE may include event: lines; the mock emits just data: lines
          // The body already contains type, so providerEventToStreamPart can infer.
          res.write(`data: ${JSON.stringify(evt)}\n\n`)
          index++
        }, 5)
        return
      }
      if (req.url === "/registry" && req.method === "GET") {
        if (options.registryRaw !== undefined) {
          res.writeHead(200, { "content-type": "text/plain" })
          res.end(options.registryRaw)
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(options.registry ?? { "dist-tags": { latest: "9.9.9" } }))
        return
      }
      if (req.url === "/models.md" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/markdown" })
        res.end(options.factsMd ?? "")
        return
      }
      if (req.url === "/cli.mjs" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/javascript" })
        res.end(options.modalitiesBundle ?? "")
        return
      }
      res.writeHead(404)
      res.end("not found")
    })
  })
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            try {
              ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
            } catch {}
            server.close(() => r())
          }),
        hits,
      })
    })
    server.on("error", reject)
  })
}

export function textDelta(text: string): Record<string, unknown> {
  return { type: "text-delta", text }
}
export function reasoningDelta(text: string): Record<string, unknown> {
  return { type: "reasoning-delta", text }
}
export function toolCall(id: string, name: string, input: unknown): Record<string, unknown> {
  return { type: "tool-call", toolCallId: id, toolName: name, input }
}
export function finishEvent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "finish",
    finishReason: "stop",
    totalUsage: { inputTokens: 10, outputTokens: 4 },
    ...extra,
  }
}
export const eventsEnd = "end" as const

// Provider SSE helpers — OpenAI chat/completions shape and Anthropic messages shape
export function openAIChunk(
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    choices: [{ delta: { content }, finish_reason: null }],
    ...extra,
  }
}
export function openAIFinishChunk(
  usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage,
  }
}
export function anthropicContentBlockDelta(text: string, index = 0): Record<string, unknown> {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } }
}
export function anthropicMessageDelta(
  usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 },
): Record<string, unknown> {
  return { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }
}

/**
 * Documented Provider API `403 upgrade_required` body (https://commandcode.ai/docs/provider):
 * "You're on the Go plan, the only plan without API access." Served by the
 * mock under `chatCompletionsStatus: 403`/`messagesStatus: 403` for
 * tests that emulate the issue #56 transport flip.
 */
export function upgradeRequiredBody(): string {
  return JSON.stringify({
    error: {
      code: "upgrade_required",
      message:
        "You're on the Go plan, the only plan without API access. Upgrade to GOAT or higher.",
    },
  })
}

/**
 * Documented Provider API `422 cmd_zdr_no_providers` body — the model has no
 * ZDR-capable upstream, so a request carrying `x-cmd-zdr: 1` fails (rather
 * than silently falling back to a non-ZDR provider). Served under
 * `chatCompletionsStatus: 422`/`messagesStatus: 422`. It is not handled
 * specially by the transport: it flows through the existing error/redaction
 * pipeline like any other API error (issue #57).
 */
export function zdrNoProvidersBody(): string {
  return JSON.stringify({
    error: {
      code: "cmd_zdr_no_providers",
      message:
        "x-cmd-zdr: 1 was set but the model has no zero-data-retention upstream. Remove the header or pick a different model.",
    },
  })
}

/**
 * Normalizes fetch init.headers (Headers instance, array, or plain object) to
 * a lowercase-keyed record so tests can assert on header values regardless of
 * how the fetch implementation carried them.
 */
export function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value
    return out
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}
