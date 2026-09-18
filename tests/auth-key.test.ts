// tests/auth-key.test.ts — API-key resolution precedence (PLAN #2 Part A) and
// the provenance-returning sibling (issue #205).
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveApiKey, resolveApiKeyWithSource } from "../src/provider/auth-key.js"
import { assertEqual, run } from "./harness.js"

run([
  [
    "env COMMANDCODE_API_KEY wins",
    () => {
      assertEqual(
        resolveApiKey({
          apiKey: undefined,
          env: { COMMANDCODE_API_KEY: "user_env" },
          authPaths: [],
        }),
        "user_env",
      )
    },
  ],

  [
    "options.apiKey wins over env",
    () => {
      assertEqual(
        resolveApiKey({
          apiKey: "user_opt",
          env: { COMMANDCODE_API_KEY: "user_env" },
          authPaths: [],
        }),
        "user_opt",
      )
    },
  ],

  [
    "legacy auth files are read in order",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-auth-"))
      try {
        await writeFile(join(dir, "a.json"), JSON.stringify({ apiKey: "user_file" }))
        const result = resolveApiKey({
          apiKey: undefined,
          env: {},
          authPaths: [join(dir, "a.json")],
        })
        assertEqual(result, "user_file")
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "malformed auth files are skipped",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-auth-"))
      try {
        await writeFile(join(dir, "bad.json"), "{not json")
        assertEqual(
          resolveApiKey({ apiKey: undefined, env: {}, authPaths: [join(dir, "bad.json")] }),
          undefined,
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "command-code CLI record shape is supported",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cc-auth-"))
      try {
        await writeFile(
          join(dir, "cli.json"),
          JSON.stringify({ "command-code": { type: "api", key: "user_cli" } }),
        )
        assertEqual(
          resolveApiKey({ apiKey: undefined, env: {}, authPaths: [join(dir, "cli.json")] }),
          "user_cli",
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "resolveApiKeyWithSource names the rung that resolved (issue #205)",
    async () => {
      assertEqual(
        resolveApiKeyWithSource({ apiKey: "opt_key", env: { COMMANDCODE_API_KEY: "env_key" } }),
        { key: "opt_key", source: { kind: "option" } },
        "the explicit option is the first rung",
      )
      assertEqual(
        resolveApiKeyWithSource({ env: { COMMANDCODE_API_KEY: "env_key" }, authPaths: [] }),
        { key: "env_key", source: { kind: "environment" } },
      )
      const dir = await mkdtemp(join(tmpdir(), "cc-auth-"))
      try {
        await writeFile(join(dir, "a.json"), JSON.stringify({ apiKey: "file_key" }))
        const file = join(dir, "a.json")
        assertEqual(resolveApiKeyWithSource({ env: {}, authPaths: [file] }), {
          key: "file_key",
          source: { kind: "file", label: file },
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
      assertEqual(resolveApiKeyWithSource({ env: {}, authPaths: [] }), undefined)
    },
  ],

  [
    "the file label names the store, never the account (issue #205)",
    async () => {
      // A default path under the home directory reads back as `~/.commandcode/…`,
      // the way the docs spell it — no OS user name, no account identifier.
      const dir = await mkdtemp(join(tmpdir(), "cc-home-"))
      try {
        await mkdir(join(dir, ".commandcode"), { recursive: true })
        await writeFile(join(dir, ".commandcode", "auth.json"), JSON.stringify({ apiKey: "k" }))
        assertEqual(resolveApiKeyWithSource({ env: {}, homeDir: () => dir }), {
          key: "k",
          source: { kind: "file", label: join("~", ".commandcode", "auth.json") },
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  ],

  [
    "resolveApiKey returns exactly the key resolveApiKeyWithSource resolves",
    async () => {
      const options = { env: { COMMANDCODE_API_KEY: "env_key" }, authPaths: [] } as const
      assertEqual(resolveApiKey(options), resolveApiKeyWithSource(options)?.key)
      assertEqual(resolveApiKey({ env: {}, authPaths: [] }), undefined)
    },
  ],
])
