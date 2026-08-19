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
  /** called with the parsed /alpha/generate request body and headers */
  onGenerate?: (body: Record<string, unknown>, headers: Record<string, string>) => void
  /** served at GET /registry (npm registry JSON: { "dist-tags": { latest } }) */
  registry?: unknown
  /** served at GET /models.md (raw command-code models.md text) */
  factsMd?: string
}

export interface MockCcHits {
  generate: number
  models: number
}

export function startMockCc(
  options: MockCcOptions = {},
): Promise<{ url: string; close: () => Promise<void>; hits: MockCcHits }> {
  const hits: MockCcHits = { generate: 0, models: 0 }
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
      if (req.url === "/alpha/generate" && req.method === "POST") {
        hits.generate++
        options.onGenerate?.(
          JSON.parse(body) as Record<string, unknown>,
          (req.headers ?? {}) as Record<string, string>,
        )
        if (options.status && options.status >= 400) {
          res.writeHead(options.status, { "content-type": "application/json" })
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
      if (req.url === "/registry" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(options.registry ?? { "dist-tags": { latest: "9.9.9" } }))
        return
      }
      if (req.url === "/models.md" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/markdown" })
        res.end(options.factsMd ?? "")
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
        close: () => new Promise((r) => server.close(() => r())),
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
