// tests/tui-credential.test.ts — the v1 TUI host's usage credential (issue
// #243, ADR-0020): the provider record the state already holds, its client
// fallback, the package ladder below them, and every no-credential outcome.
// The v2 half does not resolve locally anymore — its bridge is tested in
// tests/usage-rpc.test.ts. Pure mock inputs — provider records, client
// payloads, an env object, and a temp auth file — no network, no TUI runtime.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { resolveTuiCredential, type TuiCredentialOptions } from "../src/deals/tui-credential.js"
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

run([
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
  // The package ladder below the v1 host rung.
  // ---------------------------------------------------------------------------

  [
    "environment rung: COMMANDCODE_API_KEY below the host rung",
    async () => {
      assertEqual(
        await resolveTuiCredential(
          { host: "v1", providers: v1Providers() },
          {
            env: { COMMANDCODE_API_KEY: "env_key" },
            authPaths: [],
          },
        ),
        { key: "env_key", source: { kind: "environment" } },
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
    "nothing resolves: undefined, so callers make no request",
    async () => {
      assertEqual(
        await resolveTuiCredential({ host: "v1", providers: v1Providers() }, NO_ENV),
        undefined,
      )
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
