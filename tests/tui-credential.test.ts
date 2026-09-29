// tests/tui-credential.test.ts — the TUI host's usage credential (issue #243,
// ADR-0020): the v1 provider record and its client fallback, the v2
// provider → integration → connection read, the package ladder below both,
// and every no-credential outcome. Pure mock inputs — provider records, client
// payloads, client-local integration data, an env object, and a temp auth file
// — no network, no TUI runtime.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { resolveTuiCredential, type TuiCredentialOptions } from "../src/deals/tui-credential.js"
import type { V2TuiContext, V2TuiIntegrationConnection } from "../src/plugin/v2-tui-types.js"
import { assert, assertEqual, run } from "./harness.js"

/** No ambient credential: tests only see what they inject. */
const NO_ENV: TuiCredentialOptions = { env: {}, authPaths: [] }

/** The v1 state view: the `commandcode` record, if any (other ids tolerated). */
function v1Providers(...entries: Array<Record<string, unknown>>): readonly unknown[] {
  return entries
}

/** A v1 SDK client whose `provider.list()` resolves to `payload`. */
function v1Client(payload: unknown) {
  return { provider: { list: async () => payload } }
}

/** The hey-api `/provider` result shape the v1 client resolves to. */
function providerList(entry?: Record<string, unknown>) {
  return { data: { all: entry ? [entry] : [], default: {}, connected: [] } }
}

/** A v2 client-local data store carrying the slices the resolver reads. */
function v2Data(input: {
  providers?: ReadonlyArray<{ id: string; integrationID?: string }>
  integrations?: ReadonlyArray<{
    id: string
    connections: ReadonlyArray<V2TuiIntegrationConnection>
  }>
}): V2TuiContext["data"] {
  return {
    session: { get: () => undefined },
    location: {
      model: { list: () => [] },
      provider: { list: () => input.providers ?? [] },
      integration: {
        list: () =>
          (input.integrations ?? []).map((integration) => ({
            name: "Command Code",
            ...integration,
          })),
      },
    },
  } as unknown as V2TuiContext["data"]
}

/** The `commandcode` provider + integration pair a v2 host would project. */
function v2Host(connections: ReadonlyArray<V2TuiIntegrationConnection>): V2TuiContext["data"] {
  return v2Data({
    providers: [{ id: "commandcode", integrationID: "commandcode" }],
    integrations: [{ id: "commandcode", connections }],
  })
}

run([
  // ---------------------------------------------------------------------------
  // v1 TUI: the provider record the state already holds (ADR-0015's read).
  // ---------------------------------------------------------------------------

  [
    "v1: options.apiKey resolves from the state record, before key",
    async () => {
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v1",
            providers: v1Providers({ id: "commandcode", options: { apiKey: "config_key" } }),
          },
          NO_ENV,
        ),
        { key: "config_key", source: { kind: "host" } },
      )
      // A declared credential outranks the record's resolved key, the order
      // the v1 Host applies at model init (`options.apiKey ??= key`).
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v1",
            providers: v1Providers({
              id: "commandcode",
              key: "store_key",
              options: { apiKey: "config_key" },
            }),
          },
          NO_ENV,
        ),
        { key: "config_key", source: { kind: "host" } },
      )
    },
  ],

  [
    "v1: a record with only key resolves as the Host connection",
    async () => {
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v1",
            providers: v1Providers({
              id: "commandcode",
              env: ["COMMANDCODE_API_KEY"],
              key: "store_key",
            }),
          },
          NO_ENV,
        ),
        { key: "store_key", source: { kind: "host" } },
      )
    },
  ],

  [
    "v1: a record with neither field falls back to the TUI's client listing",
    async () => {
      // The state record carries no credential at runtime: the TUI's own SDK
      // client is asked for the same record.
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v1",
            providers: v1Providers({ id: "commandcode", options: {} }),
            client: v1Client(providerList({ id: "commandcode", key: "client_key" })),
          },
          NO_ENV,
        ),
        { key: "client_key", source: { kind: "host" } },
      )
      // The client's `options.apiKey` is read in the same order.
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v1",
            providers: [],
            client: v1Client(
              providerList({ id: "commandcode", options: { apiKey: "config_key" } }),
            ),
          },
          NO_ENV,
        ),
        { key: "config_key", source: { kind: "host" } },
      )
      // A bare payload (no `data` wrapper) is tolerated, as server-side.
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v1",
            providers: [],
            client: v1Client({ all: [{ id: "commandcode", key: "bare_key" }] }),
          },
          NO_ENV,
        ),
        { key: "bare_key", source: { kind: "host" } },
      )
    },
  ],

  [
    "v1: a missing provider, an error response, or a failing client falls to the ladder",
    async () => {
      const env = { COMMANDCODE_API_KEY: "env_key" }
      const options = { env, authPaths: [] }
      // Absent entry, another provider only, and an error response are all the
      // next rung, never an error (ADR-0015 rule 2).
      assertEqual(
        await resolveTuiCredential(
          { host: "v1", providers: [], client: v1Client(providerList(undefined)) },
          options,
        ),
        { key: "env_key", source: { kind: "environment" } },
      )
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v1",
            providers: v1Providers({ id: "openai", key: "other" }),
            client: v1Client(providerList({ id: "commandcode", options: {} })),
          },
          options,
        ),
        { key: "env_key", source: { kind: "environment" } },
      )
      assertEqual(
        await resolveTuiCredential(
          { host: "v1", providers: [], client: v1Client({ error: { message: "unauthorized" } }) },
          options,
        ),
        { key: "env_key", source: { kind: "environment" } },
      )
      // An empty key is absence, not a credential.
      assertEqual(
        await resolveTuiCredential(
          { host: "v1", providers: v1Providers({ id: "commandcode", key: "" }) },
          options,
        ),
        { key: "env_key", source: { kind: "environment" } },
      )
      const failing = {
        provider: {
          list: async (): Promise<unknown> => {
            throw new Error("server unreachable")
          },
        },
      }
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v1",
            providers: v1Providers({ id: "commandcode", options: {} }),
            client: failing,
          },
          options,
        ),
        { key: "env_key", source: { kind: "environment" } },
      )
    },
  ],

  // ---------------------------------------------------------------------------
  // v2 TUI: provider → client-local integration → the active connection.
  // ---------------------------------------------------------------------------

  [
    "v2: the provider's integration env connection reads the named environment variable",
    async () => {
      assertEqual(
        await resolveTuiCredential(
          { host: "v2", data: v2Host([{ type: "env", name: "COMMANDCODE_API_KEY" }]) },
          { env: { COMMANDCODE_API_KEY: "env_key" }, authPaths: [] },
        ),
        { key: "env_key", source: { kind: "host" } },
      )
      // The name is read from the connection, not assumed: a host that names
      // its env method differently still resolves.
      assertEqual(
        await resolveTuiCredential(
          { host: "v2", data: v2Host([{ type: "env", name: "CC_TUI_USAGE_KEY" }]) },
          {
            env: { COMMANDCODE_API_KEY: "env_key", CC_TUI_USAGE_KEY: "custom_key" },
            authPaths: [],
          },
        ),
        { key: "custom_key", source: { kind: "host" } },
      )
    },
  ],

  [
    "v2: an active credential connection yields undefined — the documented notice path",
    async () => {
      // The store-only user: the value lives in the Host's credential store,
      // which the TUI host never sees. No env connection exists (the env
      // method only surfaces when its variable is set), so nothing resolves.
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v2",
            data: v2Host([{ type: "credential", id: "cred_1", label: "Command Code API key" }]),
          },
          NO_ENV,
        ),
        undefined,
      )
    },
  ],

  [
    "v2: a stored credential stays active over a live env connection; the ladder answers with its own rung",
    async () => {
      // The Host projects stored credentials first and `active()` is [0], so
      // with both present the session streams with the store credential — an
      // account this process cannot reach. The package ladder below then reads
      // COMMANDCODE_API_KEY itself, so the answer is labeled as that rung
      // rather than claimed as the Host's.
      assertEqual(
        await resolveTuiCredential(
          {
            host: "v2",
            data: v2Host([
              { type: "credential", id: "cred_1", label: "Command Code API key" },
              { type: "env", name: "COMMANDCODE_API_KEY" },
            ]),
          },
          { env: { COMMANDCODE_API_KEY: "env_key" }, authPaths: [] },
        ),
        { key: "env_key", source: { kind: "environment" } },
      )
    },
  ],

  [
    "v2: the rung degrades structurally — missing provider, integrationID, integration, or connections",
    async () => {
      const env = { COMMANDCODE_API_KEY: "env_key" }
      const options = { env, authPaths: [] }
      const cases: Array<[string, V2TuiContext["data"]]> = [
        ["no provider record", v2Data({ integrations: [] })],
        ["provider without an integrationID", v2Data({ providers: [{ id: "commandcode" }] })],
        [
          "integration record absent",
          v2Data({ providers: [{ id: "commandcode", integrationID: "commandcode" }] }),
        ],
        [
          "integration id does not match the provider",
          v2Data({
            providers: [{ id: "commandcode", integrationID: "other" }],
            integrations: [{ id: "commandcode", connections: [{ type: "env", name: "X" }] }],
          }),
        ],
        [
          "connections empty",
          v2Data({
            providers: [{ id: "commandcode", integrationID: "commandcode" }],
            integrations: [{ id: "commandcode", connections: [] }],
          }),
        ],
        [
          "connections field dropped by the host",
          {
            session: { get: () => undefined },
            location: {
              model: { list: () => [] },
              provider: { list: () => [{ id: "commandcode", integrationID: "commandcode" }] },
              integration: { list: () => [{ id: "commandcode", name: "Command Code" }] },
            },
          } as unknown as V2TuiContext["data"],
        ],
        ["env connection whose variable is unset", v2Host([{ type: "env", name: "MISSING_KEY" }])],
      ]
      for (const [label, data] of cases) {
        // The rung yields nothing for each shape; the ladder below answers.
        assertEqual(
          await resolveTuiCredential({ host: "v2", data }, options),
          { key: "env_key", source: { kind: "environment" } },
          label,
        )
      }
    },
  ],

  // ---------------------------------------------------------------------------
  // The package ladder below both hosts.
  // ---------------------------------------------------------------------------

  [
    "environment rung: COMMANDCODE_API_KEY below both host rungs",
    async () => {
      const resolved = { key: "env_key", source: { kind: "environment" } }
      assertEqual(
        await resolveTuiCredential(
          { host: "v1", providers: v1Providers() },
          {
            env: { COMMANDCODE_API_KEY: "env_key" },
            authPaths: [],
          },
        ),
        resolved,
      )
      assertEqual(
        await resolveTuiCredential(
          { host: "v2", data: v2Data({}) },
          {
            env: { COMMANDCODE_API_KEY: "env_key" },
            authPaths: [],
          },
        ),
        resolved,
      )
    },
  ],

  [
    "legacy-file rung: a file source carries its label, never the key",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-tui-cred-"))
      try {
        const file = join(dir, "auth.json")
        await writeFile(file, JSON.stringify({ apiKey: "file_key" }))
        const credential = await resolveTuiCredential(
          { host: "v1", providers: v1Providers() },
          { env: {}, authPaths: [file] },
        )
        assertEqual(credential, {
          key: "file_key",
          source: { kind: "file", label: file },
        })
        // The label names the store; the key never rides with the source.
        assert(
          credential !== undefined && !JSON.stringify(credential.source).includes("file_key"),
          "the file rung's source must not carry the key",
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "both halves share one ladder: identical inputs resolve identically",
    async () => {
      const options = { env: { COMMANDCODE_API_KEY: "env_key" }, authPaths: [] }
      const v1 = await resolveTuiCredential({ host: "v1", providers: v1Providers() }, options)
      const v2 = await resolveTuiCredential({ host: "v2", data: v2Data({}) }, options)
      assertEqual(v1, v2)
      assertEqual(await resolveTuiCredential({ host: "v2", data: v2Data({}) }, NO_ENV), undefined)
    },
  ],

  [
    "nothing resolves: undefined for both halves, so callers make no request",
    async () => {
      assertEqual(
        await resolveTuiCredential({ host: "v1", providers: v1Providers() }, NO_ENV),
        undefined,
      )
      assertEqual(await resolveTuiCredential({ host: "v2", data: v2Data({}) }, NO_ENV), undefined)
    },
  ],

  [
    "no resolution path logs or renders key material",
    async () => {
      // Every rung's source is display data only: stringifying it must never
      // contain the key it traveled with.
      const rungs = [
        await resolveTuiCredential(
          { host: "v1", providers: v1Providers({ id: "commandcode", key: "v1_key" }) },
          NO_ENV,
        ),
        await resolveTuiCredential(
          { host: "v2", data: v2Host([{ type: "env", name: "COMMANDCODE_API_KEY" }]) },
          { env: { COMMANDCODE_API_KEY: "v2_key" }, authPaths: [] },
        ),
        await resolveTuiCredential(
          { host: "v1", providers: v1Providers() },
          { env: { COMMANDCODE_API_KEY: "env_key" }, authPaths: [] },
        ),
      ]
      for (const [index, credential] of rungs.entries()) {
        assert(credential !== undefined, `rung ${index} must resolve`)
        assert(
          !JSON.stringify(credential.source).includes(credential.key),
          `rung ${index}'s source must not carry the key`,
        )
      }
      // The module never writes to a console at all.
      const source = readFileSync(
        new URL("../src/deals/tui-credential.ts", import.meta.url).pathname,
        "utf-8",
      )
      assert(!/console\./.test(source), "the resolver must not log")
      assert(!/from\s+["']solid-js["']/.test(source), "no solid-js import")
      assert(!/from\s+["']@opencode-ai\//.test(source), "no @opencode-ai/* import")
      assert(!/from\s+["']@opencode\//.test(source), "no @opencode/* import")
    },
  ],
])
