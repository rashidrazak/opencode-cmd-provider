// E2E: a real OpenCode v2 host loading the built package through the documented
// local-plugin discovery path (`.opencode/plugins/<name>/`), plus a catalog
// read-back that proves Auto-registration landed in the host's own state.
// Requires: `opencode` (v2) on PATH and `npm run build` run first. Excluded from
// `npm test` like the v1 script.
//
// Skips (exit 0) when opencode is absent or is the v1 line — tests/e2e-opencode.mjs
// covers v1.
//
// Why the fixture wraps the entry: the read-back has to run *inside* the plugin's
// `setup`, after our own `setup` returns, because that is the only point where
// this process can see the host's catalog. The wrapper re-exports the built
// default export unchanged and only calls our plugin's own `setup` with logging
// around it — every assertion below is about state the host reports back, never
// about the wrapper.
//
// Two legs:
//   1. the host imports the module, decodes the dual `{ id, server, setup }`
//      default export, calls `setup(context)`, and the read-back shows the
//      provider, every Snapshot model, and the credential integration;
//   2. a headless `opencode run`. This leg is known to hang before sending a
//      request against a local/mock baseURL — the same upstream opencode bug the
//      v1 script documents (anomalyco/opencode #14956, #39977, #5674) — so a
//      hang is reported as a skip, with the host's own connection error as the
//      evidence that the model got as far as the transport.
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Which opencode to exercise. Defaults to PATH; set OPENCODE_BIN to point at a
// specific v2 install when a v1 binary is also present (tests/e2e-opencode.mjs
// takes the same variable for the v1 side).
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode"

const isoHome = mkdtempSync(join(tmpdir(), "oc-v2-e2e-home-"))
const isoEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: isoHome,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  XDG_CACHE_HOME: join(isoHome, ".cache"),
  XDG_DATA_HOME: join(isoHome, ".data"),
  XDG_CONFIG_HOME: join(isoHome, ".config"),
}

const version = spawnSync(OPENCODE, ["--version"], { env: isoEnv, encoding: "utf-8" })
if (version.error || version.status !== 0) {
  console.log(`skip - ${OPENCODE} is not runnable (${version.error?.code ?? version.status})`)
  process.exit(0)
}
const reported = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim()
if (!/\bv2\./.test(reported)) {
  console.log(
    `skip - ${OPENCODE} is not v2 (${reported || "version unknown"}); run 'npm run test:e2e' for v1`,
  )
  process.exit(0)
}
console.log(`using ${OPENCODE} (${reported})`)

const received = []
const server = createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    received.push(req.url)
    if (req.url === "/provider/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 200000 }],
        }),
      )
      return
    }
    if (req.url === "/alpha/generate") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(
        `data: ${JSON.stringify({ type: "text-delta", text: "hello from command code" })}\n\n`,
      )
      res.write(
        `data: ${JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 4 } })}\n\n`,
      )
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const base = `http://127.0.0.1:${server.address().port}`

const dir = mkdtempSync(join(tmpdir(), "oc-cc-v2-fixture-"))
const pluginDir = join(dir, ".opencode", "plugins", "commandcode")
mkdirSync(pluginDir, { recursive: true })
writeFileSync(join(dir, ".opencode", "package.json"), JSON.stringify({ private: true }))
writeFileSync(
  join(dir, "opencode.json"),
  JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
)
const entry = pathToFileURL(resolve(import.meta.dirname, "..", "dist", "index.js")).href
writeFileSync(
  join(pluginDir, "index.mjs"),
  `import plugin from ${JSON.stringify(entry)}
const original = plugin.setup
const report = (label, value) => console.error("[cmd-v2]", label, typeof value === "string" ? value : JSON.stringify(value))
export default {
  ...plugin,
  async setup(ctx) {
    await original(ctx)
    report("setup", "returned")
    try {
      const raw = await ctx.provider.get({ providerID: "commandcode" }).catch(() => undefined)
      const info = raw?.data ?? raw?.provider ?? raw
      report("provider", { id: info?.id, name: info?.name, package: info?.package, activation: info?.activation, integrationID: info?.integrationID })
    } catch (error) { report("provider-error", String(error?.message ?? error)) }
    try {
      const raw = await ctx.model.list().catch(() => undefined)
      const all = raw?.data ?? raw ?? []
      const ours = (Array.isArray(all) ? all : []).filter((model) => model.providerID === "commandcode")
      const first = ours[0] ?? {}
      report("models", { count: ours.length, first: first.id, package: first.package, variants: (first.variants ?? []).length, cost: (first.cost ?? []).length })
    } catch (error) { report("models-error", String(error?.message ?? error)) }
    try {
      const raw = await ctx.integration.list().catch(() => undefined)
      const all = raw?.data ?? raw ?? []
      const ours = (Array.isArray(all) ? all : []).find((item) => item.id === "commandcode")
      report("integration", { name: ours?.name, methods: (ours?.methods ?? []).map((method) => method.type), connections: (ours?.connections ?? []).length })
    } catch (error) { report("integration-error", String(error?.message ?? error)) }
  },
}
`,
)

const run = spawnSync(
  OPENCODE,
  [
    "run",
    "--standalone",
    "--model",
    "commandcode/claude-sonnet-5",
    "say hi",
    "--print-logs",
    "--log-level",
    "info",
  ],
  {
    cwd: dir,
    env: { ...isoEnv, COMMANDCODE_API_KEY: "user_e2e", COMMANDCODE_API_BASE: base },
    encoding: "utf-8",
    timeout: 100_000,
  },
)
server.close()

const stderr = run.stderr ?? ""
const reports = new Map()
for (const line of stderr.split("\n")) {
  const match = /\[cmd-v2\] (\S+) (.*)$/.exec(line)
  if (!match) continue
  const [, label, payload] = match
  reports.set(label, parse(label, payload))
}
function parse(label, payload) {
  if (label === "setup" || label.endsWith("-error")) return payload
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}
function report(label) {
  const value = reports.get(label)
  if (value === undefined) {
    console.error(`missing [cmd-v2] ${label} read-back; host log tail:\n${stderr.slice(-2000)}`)
    process.exit(1)
  }
  return value
}

if (!stderr.includes("loading plugin")) {
  console.error(`the host never loaded the plugin; log tail:\n${stderr.slice(-2000)}`)
  process.exit(1)
}
console.log("ok - the v2 host imports the dual default export and calls setup()")

const provider = report("provider")
if (provider.id !== "commandcode" || !String(provider.package ?? "").startsWith("aisdk:")) {
  console.error("provider was not registered as an aisdk-package provider:", provider)
  process.exit(1)
}
if (provider.integrationID !== "commandcode") {
  console.error("provider is not linked to its integration:", provider)
  process.exit(1)
}
console.log(`ok - provider auto-registered with ${provider.package}`)

const models = report("models")
if (models.count === 0) {
  console.error("no commandcode models reached the host catalog:", models)
  process.exit(1)
}
if (models.package !== provider.package) {
  console.error("model did not inherit the provider package:", models, provider)
  process.exit(1)
}
console.log(`ok - ${models.count} Snapshot models auto-registered (first: ${models.first})`)

const integration = report("integration")
if (!integration.methods?.includes("env") || !integration.methods?.includes("key")) {
  console.error("integration is missing its env/key methods:", integration)
  process.exit(1)
}
if ((integration.connections ?? 0) === 0) {
  console.error("COMMANDCODE_API_KEY did not resolve to a connection:", integration)
  process.exit(1)
}
console.log("ok - /connect integration registers env + key methods and sees the API key")

if (received.includes("/alpha/generate")) {
  if (!(run.stdout ?? "").includes("hello from command code")) {
    console.error("expected assistant text in output, got:", run.stdout)
    process.exit(1)
  }
  console.log("ok - headless v2 opencode completed a Command Code turn")
} else {
  // The known upstream hang: the model resolved and the transport was attempted
  // (the host logs its own connection error), but no request left the process.
  const attempted = /SessionStep\.attempt|Unable to connect|llm runtime/i.test(stderr)
  console.log(
    `skip - headless v2 run sent no request before exiting (upstream bug: anomalyco/opencode #14956, #5674); transport attempted: ${attempted}`,
  )
}
