// tests/auth-mirror.test.ts — credential mirroring after /connect (issue #64)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, sep } from "node:path"
import { tmpdir } from "node:os"
import { mirrorCredential } from "../src/plugin/auth-mirror.js"
import { runAuthFlow } from "../src/plugin/auth.js"
import { startAuthServer } from "../src/plugin/auth-server.js"
import { assert, assertEqual, run } from "./harness.js"

function tmpWorkspace(): { dir: string; opencodeAuthFile: string; legacyAuthFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-mirror-"))
  return {
    dir,
    opencodeAuthFile: join(dir, "opencode", "auth.json"),
    legacyAuthFile: join(dir, "commandcode", "auth.json"),
  }
}

function post(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

run([
  [
    "writes command-code into an existing opencode auth store and preserves other entries",
    async () => {
      const { opencodeAuthFile, legacyAuthFile } = tmpWorkspace()
      mkdirSync(join(opencodeAuthFile, ".."), { recursive: true })
      writeFileSync(
        opencodeAuthFile,
        `${JSON.stringify({ anthropic: { type: "oauth", access: "a" }, commandcode: { type: "api", key: "user_old" } }, null, 2)}\n`,
      )
      const result = mirrorCredential("user_abc", { opencodeAuthFile, legacyAuthFile })
      assert(result.opencodeAuthUpdated)
      const doc = JSON.parse(readFileSync(opencodeAuthFile, "utf-8"))
      assertEqual(doc["command-code"], { type: "api", key: "user_abc" })
      assertEqual(doc.commandcode, { type: "api", key: "user_old" })
      assertEqual(doc.anthropic, { type: "oauth", access: "a" })
      // Legacy file had no prior credential, so it is created too.
      assert(result.legacyAuthUpdated)
      const legacy = JSON.parse(readFileSync(legacyAuthFile, "utf-8"))
      assertEqual(legacy["command-code"], { type: "api", key: "user_abc" })
    },
  ],

  [
    "creates the opencode auth file with owner-only permissions when missing",
    async () => {
      const { dir, opencodeAuthFile, legacyAuthFile } = tmpWorkspace()
      const result = mirrorCredential("user_abc", { opencodeAuthFile, legacyAuthFile })
      assert(result.opencodeAuthUpdated)
      assert(existsSync(opencodeAuthFile))
      const mode = statSync(opencodeAuthFile).mode & 0o777
      assertEqual(mode, 0o600, "new auth file must be owner-only")
      const doc = JSON.parse(readFileSync(opencodeAuthFile, "utf-8"))
      assertEqual(doc["command-code"], { type: "api", key: "user_abc" })
      assert(opencodeAuthFile.startsWith(dir + sep))
    },
  ],

  [
    "refreshes a stale command-code entry on re-auth",
    async () => {
      const { opencodeAuthFile, legacyAuthFile } = tmpWorkspace()
      mkdirSync(join(opencodeAuthFile, ".."), { recursive: true })
      writeFileSync(
        opencodeAuthFile,
        `${JSON.stringify({ "command-code": { type: "api", key: "user_stale" } }, null, 2)}\n`,
      )
      const result = mirrorCredential("user_new", { opencodeAuthFile, legacyAuthFile })
      assert(result.opencodeAuthUpdated)
      const doc = JSON.parse(readFileSync(opencodeAuthFile, "utf-8"))
      assertEqual(doc["command-code"], { type: "api", key: "user_new" })
    },
  ],

  [
    "never clobbers a differing credential in the official CLI auth file",
    async () => {
      const { opencodeAuthFile, legacyAuthFile } = tmpWorkspace()
      mkdirSync(join(legacyAuthFile, ".."), { recursive: true })
      writeFileSync(
        legacyAuthFile,
        `${JSON.stringify({ "command-code": { type: "oauth", access: "cli-login" } }, null, 2)}\n`,
      )
      const result = mirrorCredential("user_abc", { opencodeAuthFile, legacyAuthFile })
      assert(result.opencodeAuthUpdated)
      assert(!result.legacyAuthUpdated)
      const legacy = JSON.parse(readFileSync(legacyAuthFile, "utf-8"))
      assertEqual(legacy["command-code"], { type: "oauth", access: "cli-login" })
    },
  ],

  [
    "is a no-op when both stores already hold the same credential",
    async () => {
      const { opencodeAuthFile, legacyAuthFile } = tmpWorkspace()
      const before = `${JSON.stringify({ "command-code": { type: "api", key: "user_same" } }, null, 2)}\n`
      mkdirSync(join(opencodeAuthFile, ".."), { recursive: true })
      writeFileSync(opencodeAuthFile, before)
      mkdirSync(join(legacyAuthFile, ".."), { recursive: true })
      writeFileSync(legacyAuthFile, before)
      const result = mirrorCredential("user_same", { opencodeAuthFile, legacyAuthFile })
      assert(!result.opencodeAuthUpdated)
      assert(!result.legacyAuthUpdated)
      assertEqual(readFileSync(opencodeAuthFile, "utf-8"), before)
    },
  ],

  [
    "ignores blank keys",
    async () => {
      const { opencodeAuthFile, legacyAuthFile } = tmpWorkspace()
      const result = mirrorCredential("   ", { opencodeAuthFile, legacyAuthFile })
      assert(!result.opencodeAuthUpdated)
      assert(!result.legacyAuthUpdated)
      assert(!existsSync(opencodeAuthFile))
    },
  ],

  [
    "runAuthFlow mirrors the credential on success and honors mirror:false",
    async () => {
      const { opencodeAuthFile, legacyAuthFile } = tmpWorkspace()

      const enabled = await runAuthFlow({
        startPort: 0,
        mirror: { opencodeAuthFile, legacyAuthFile },
      })
      const port = Number(
        new URL(enabled.url).searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1],
      )
      await post(port, {
        apiKey: "user_flow",
        state: new URL(enabled.url).searchParams.get("state"),
        userId: "u",
        userName: "n",
        keyName: "k",
      })
      const outcome = await enabled.callback()
      assertEqual(outcome.type, "success")
      const doc = JSON.parse(readFileSync(opencodeAuthFile, "utf-8"))
      assertEqual(doc["command-code"], { type: "api", key: "user_flow" })

      const disabledDir = tmpWorkspace()
      const disabled = await runAuthFlow({
        startPort: 0,
        mirror: false,
      })
      const disabledPort = Number(
        new URL(disabled.url).searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1],
      )
      await post(disabledPort, {
        apiKey: "user_nomirror",
        state: new URL(disabled.url).searchParams.get("state"),
        userId: "u",
        userName: "n",
        keyName: "k",
      })
      const disabledOutcome = await disabled.callback()
      assertEqual(disabledOutcome.type, "success")
      assert(!existsSync(disabledDir.opencodeAuthFile))
    },
  ],
])
