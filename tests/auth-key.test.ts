// tests/auth-key.test.ts — API-key resolution precedence (PLAN #2 Part A)
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveApiKey } from "../src/provider/auth-key.js"
import { assertEqual, run } from "./harness.js"

run([
  ["env COMMANDCODE_API_KEY wins", () => {
    assertEqual(resolveApiKey({ apiKey: undefined, env: { COMMANDCODE_API_KEY: "user_env" }, authPaths: [] }), "user_env")
  }],

  ["options.apiKey wins over env", () => {
    assertEqual(
      resolveApiKey({ apiKey: "user_opt", env: { COMMANDCODE_API_KEY: "user_env" }, authPaths: [] }),
      "user_opt",
    )
  }],

  ["legacy auth files are read in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-auth-"))
    try {
      await writeFile(join(dir, "a.json"), JSON.stringify({ apiKey: "user_file" }))
      const result = resolveApiKey({ apiKey: undefined, env: {}, authPaths: [join(dir, "a.json")] })
      assertEqual(result, "user_file")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }],

  ["malformed auth files are skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-auth-"))
    try {
      await writeFile(join(dir, "bad.json"), "{not json")
      assertEqual(resolveApiKey({ apiKey: undefined, env: {}, authPaths: [join(dir, "bad.json")] }), undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }],

  ["command-code CLI record shape is supported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-auth-"))
    try {
      await writeFile(join(dir, "cli.json"), JSON.stringify({ "command-code": { type: "api", key: "user_cli" } }))
      assertEqual(resolveApiKey({ apiKey: undefined, env: {}, authPaths: [join(dir, "cli.json")] }), "user_cli")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }],
])
