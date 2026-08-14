/**
 * Local HTTP callback server for the Command Code browser auth flow.
 *
 * Starts a one-shot server on a CLI-compatible localhost port. The Command Code
 * Studio website POSTs the user's API key to /callback after they authenticate.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

const DEFAULT_PORT = 5959
const DEFAULT_PORT_RANGE = 10

export interface AuthCallback {
  apiKey: string
  state: string
  userId: string
  userName: string
  keyName: string
}

export interface AuthServer {
  server: Server
  port: number
  waitForCallback: Promise<AuthCallback>
}

export interface AuthServerOptions {
  startPort?: number
  portRange?: number
}

function listenOnAvailablePort(
  server: Server,
  startPort = DEFAULT_PORT,
  range = DEFAULT_PORT_RANGE,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let offset = 0

    const tryListen = () => {
      const useFallbackPort = startPort === 0 || offset >= range
      const port = useFallbackPort ? 0 : startPort + offset

      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening)
        if (err.code === "EADDRINUSE" && !useFallbackPort) {
          offset += 1
          tryListen()
          return
        }
        reject(err)
      }

      const onListening = () => {
        server.off("error", onError)
        const address = server.address() as AddressInfo
        resolve(address.port)
      }

      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(port, "127.0.0.1")
    }

    tryListen()
  })
}

function closeServer(server: Server) {
  server.close((err: NodeJS.ErrnoException | undefined) => {
    if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
      // There is nowhere useful to report this during auth cleanup.
    }
  })
}

/**
 * Start a local HTTP server that listens for the Command Code Studio
 * to POST the API key after the user authenticates in their browser.
 *
 * The server accepts exactly one valid POST to /callback and then closes.
 */
export async function startAuthServer(options: AuthServerOptions = {}): Promise<AuthServer> {
  let resolveCallback!: (value: AuthCallback) => void
  let rejectCallback!: (error: Error) => void

  const waitForCallback = new Promise<AuthCallback>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server = createServer((req, res) => {
    // CORS: allow requests from Command Code domains and localhost for dev.
    const origin = req.headers.origin || ""
    const allowedOrigins = [
      "http://localhost:3000",
      "https://staging.commandcode.ai",
      "https://commandcode.ai",
    ]
    const responseOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
    const requestedHeaders = req.headers["access-control-request-headers"]
    const allowHeaders =
      typeof requestedHeaders === "string" && requestedHeaders.length > 0
        ? requestedHeaders
        : "Content-Type"

    res.setHeader("Access-Control-Allow-Origin", responseOrigin as string)
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", allowHeaders)
    // Chrome's Private Network Access preflight may require this for an HTTPS
    // page posting to a localhost HTTP callback.
    res.setHeader("Access-Control-Allow-Private-Network", "true")
    res.setHeader("Content-Type", "application/json")

    // Handle CORS preflight.
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url !== "/callback") {
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: "Not found" }))
      return
    }

    if (req.method !== "POST") {
      res.writeHead(405)
      res.end(
        JSON.stringify({
          success: false,
          error: "Method not allowed. Use POST.",
        }),
      )
      return
    }

    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
      if (body.length > 10_000) req.destroy()
    })

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>

        if (parsed.error) {
          res.writeHead(200)
          res.end(JSON.stringify({ success: true }))
          const description =
            typeof parsed.error_description === "string"
              ? parsed.error_description
              : String(parsed.error)
          if (parsed.error === "access_denied") {
            rejectCallback(new Error(description || "Authorization was denied by the user"))
          } else {
            rejectCallback(new Error(description || String(parsed.error)))
          }
          closeServer(server)
          return
        }

        const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : ""
        const state = typeof parsed.state === "string" ? parsed.state : ""
        const userId = typeof parsed.userId === "string" ? parsed.userId : ""
        const userName = typeof parsed.userName === "string" ? parsed.userName : ""
        const keyName = typeof parsed.keyName === "string" ? parsed.keyName : ""

        if (!apiKey || !state || !userId || !userName || !keyName) {
          res.writeHead(400)
          res.end(
            JSON.stringify({
              success: false,
              error: "Missing required fields",
            }),
          )
          return
        }

        res.writeHead(200)
        res.end(JSON.stringify({ success: true }))

        resolveCallback({ apiKey, state, userId, userName, keyName })
        closeServer(server)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }))
      }
    })

    req.on("error", () => {
      res.writeHead(500)
      res.end(JSON.stringify({ success: false, error: "Request error" }))
    })
  })

  try {
    const port = await listenOnAvailablePort(
      server,
      options.startPort ?? DEFAULT_PORT,
      options.portRange ?? DEFAULT_PORT_RANGE,
    )
    return { server, port, waitForCallback }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const error = new Error(`Failed to start auth server: ${message}`)
    rejectCallback(error)
    throw error
  }
}
