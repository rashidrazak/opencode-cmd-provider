// tests/host-credential.test.ts — the v1 Host's resolved credential, read from
// the plugin's SDK client (issue #203, ADR-0015). Pure fake-client tests: no
// HTTP, no live credential store.
import { hostCredentialFromV1, type V1ProviderListClient } from "../src/deals/host-credential.js"
import { planSummaryTool } from "../src/deals/plan-summary.js"
import { assert, assertEqual, run } from "./harness.js"

/** The shape `GET /provider` resolves to through the hey-api client. */
function client(payload: unknown): V1ProviderListClient {
  return { provider: { list: async () => payload } }
}

function providerList(entry: Record<string, unknown> | undefined) {
  return { data: { all: entry ? [entry] : [], default: {}, connected: [] } }
}

const STORE_ENTRY = {
  id: "commandcode",
  name: "Command Code",
  source: "config",
  env: ["COMMANDCODE_API_KEY"],
  key: "store_key",
  options: { baseURL: "https://api.commandcode.ai" },
}

interface Call {
  url: string
  headers: Record<string, string>
}

function recordingFetch(
  bodies: Record<string, unknown>,
  calls: Call[] = [],
): { calls: Call[]; fetch: typeof fetch } {
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> })
    const path = url.replace("http://mock", "")
    if (!(path in bodies)) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(bodies[path]), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetch: impl }
}

run([
  [
    "v1 host credential: the store key with host provenance (issue #203)",
    async () => {
      assertEqual(
        await hostCredentialFromV1(client(providerList(STORE_ENTRY)), "commandcode", {}),
        {
          key: "store_key",
          source: "host",
        },
      )
    },
  ],
  [
    "v1 host credential: an env-supplied key is reported as the environment",
    async () => {
      // The v1 Host fills `key` from the provider's env names; matching the key
      // against them is what separates env provenance from the auth store.
      const entry = { ...STORE_ENTRY, key: "env_key" }
      assertEqual(
        await hostCredentialFromV1(client(providerList(entry)), "commandcode", {
          COMMANDCODE_API_KEY: "env_key",
        }),
        { key: "env_key", source: "environment" },
      )
      // Same key, no env var of that name: the store supplied it.
      assertEqual(await hostCredentialFromV1(client(providerList(entry)), "commandcode", {}), {
        key: "env_key",
        source: "host",
      })
    },
  ],
  [
    "v1 host credential: a declared options.apiKey outranks key, as it does at model init",
    async () => {
      const entry = { ...STORE_ENTRY, options: { apiKey: "config_key" } }
      assertEqual(await hostCredentialFromV1(client(providerList(entry)), "commandcode", {}), {
        key: "config_key",
        source: "config",
      })
    },
  ],
  [
    "v1 host credential: missing provider, error response, or no credential is undefined",
    async () => {
      const cases: Array<[string, unknown]> = [
        ["provider absent", providerList(undefined)],
        ["other providers only", providerList({ id: "openai", key: "other" })],
        ["error response", { error: { message: "unauthorized" }, data: undefined }],
        ["no key and no options", providerList({ id: "commandcode", options: {} })],
        ["empty key", providerList({ id: "commandcode", key: "" })],
        ["unexpected payload", { data: { nope: true } }],
        ["null payload", null],
      ]
      for (const [label, payload] of cases) {
        assertEqual(
          await hostCredentialFromV1(client(payload), "commandcode", {}),
          undefined,
          label,
        )
      }
    },
  ],
  [
    "v1 host credential: a bare payload (no data wrapper) is tolerated",
    async () => {
      assertEqual(await hostCredentialFromV1(client({ all: [STORE_ENTRY] }), "commandcode", {}), {
        key: "store_key",
        source: "host",
      })
    },
  ],
  [
    "cmd_plan_summary (v1) answers for the Host credential, not the legacy file (issue #203)",
    async () => {
      // The exact shape that produced the wrong account: the Host streams with
      // the store credential while a legacy file holds a different account's
      // key. The tool must ask the Host first.
      const { calls, fetch } = recordingFetch({
        "/alpha/whoami": { org: null },
        "/alpha/billing/subscriptions": { data: { status: "active", planId: "individual-goat" } },
      })
      const tool = planSummaryTool({
        hostCredential: () =>
          hostCredentialFromV1(client(providerList(STORE_ENTRY)), "commandcode", {}),
        baseURL: "http://mock",
        fetch,
        env: {},
      })
      const rendered = await tool.execute({})
      assert(
        rendered.includes("GOAT"),
        `the Host credential must drive the lookup, got: ${rendered}`,
      )
      assertEqual(calls[0]!.headers.authorization, "Bearer store_key")
    },
  ],
  [
    "cmd_plan_summary (v1) falls through when the Host resolves no credential",
    async () => {
      const { calls, fetch } = recordingFetch({
        "/alpha/whoami": { org: null },
        "/alpha/billing/subscriptions": { data: { status: "active", planId: "individual-pro" } },
      })
      const tool = planSummaryTool({
        hostCredential: () =>
          hostCredentialFromV1(client(providerList(undefined)), "commandcode", {}),
        baseURL: "http://mock",
        fetch,
        env: { COMMANDCODE_API_KEY: "env_key" },
      })
      await tool.execute({})
      assertEqual(calls[0]!.headers.authorization, "Bearer env_key")
    },
  ],
  [
    "cmd_plan_summary (v1) survives a failing Host client",
    async () => {
      const { calls, fetch } = recordingFetch({
        "/alpha/whoami": { org: null },
        "/alpha/billing/subscriptions": { data: { status: "active", planId: "individual-max" } },
      })
      const failing: V1ProviderListClient = {
        provider: {
          list: async () => {
            throw new Error("server unreachable")
          },
        },
      }
      const rendered = await planSummaryTool({
        hostCredential: () => hostCredentialFromV1(failing, "commandcode", {}),
        baseURL: "http://mock",
        fetch,
        env: { COMMANDCODE_API_KEY: "env_key" },
      }).execute({})
      assert(rendered.includes("Max 10×"), `the ladder must still resolve, got: ${rendered}`)
      assertEqual(calls[0]!.headers.authorization, "Bearer env_key")
    },
  ],
])
