// src/plugin/auth-mirror.ts — mirror /connect credentials for ecosystem consumers
//
// OpenChamber's command-code quota provider reads the API key from OpenCode's
// auth store under the key "command-code" (the provider id its own archived
// plugin used). OpenCode stores this plugin's credential under "commandcode",
// so after a successful /connect we mirror it under "command-code" as well.
// We also mirror to ~/.commandcode/auth.json in the official CLI layout,
// which resolveApiKey already reads as a legacy fallback.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export interface MirrorOptions {
  opencodeAuthFile?: string
  legacyAuthFile?: string
}

export interface MirrorResult {
  opencodeAuthUpdated: boolean
  legacyAuthUpdated: boolean
}

type JsonRecord = Record<string, unknown>

function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
}

export function defaultOpencodeAuthFile(): string {
  return join(dataHome(), "opencode", "auth.json")
}

export function defaultLegacyAuthFile(): string {
  return join(homedir(), ".commandcode", "auth.json")
}

function readJsonObject(path: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonRecord
    }
  } catch {
    // Missing or malformed file: start from an empty document.
  }
  return {}
}

function writeJsonAtomic(path: string, value: JsonRecord): void {
  const dir = join(path, "..")
  mkdirSync(dir, { recursive: true })
  const existingMode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: existingMode })
  renameSync(tmp, path)
}

function isCredentialRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

// OpenCode's auth store is owned by this plugin's ecosystem entry point, so a
// stale mirror there is refreshed on every successful /connect. The legacy
// file belongs to the official Command Code CLI; if it already holds a
// different credential we leave it alone rather than clobber another tool's
// login.
export function mirrorCredential(key: string, options: MirrorOptions = {}): MirrorResult {
  const trimmed = key.trim()
  if (!trimmed) return { opencodeAuthUpdated: false, legacyAuthUpdated: false }
  const entry = { type: "api", key: trimmed }

  const opencodeAuthFile = options.opencodeAuthFile ?? defaultOpencodeAuthFile()
  const opencodeDoc = readJsonObject(opencodeAuthFile)
  const currentOpencode = opencodeDoc["command-code"]
  let opencodeAuthUpdated = false
  if (
    !isCredentialRecord(currentOpencode) ||
    currentOpencode.type !== "api" ||
    currentOpencode.key !== trimmed
  ) {
    opencodeDoc["command-code"] = entry
    writeJsonAtomic(opencodeAuthFile, opencodeDoc)
    opencodeAuthUpdated = true
  }

  const legacyAuthFile = options.legacyAuthFile ?? defaultLegacyAuthFile()
  const legacyDoc = readJsonObject(legacyAuthFile)
  let legacyAuthUpdated = false
  if (!isCredentialRecord(legacyDoc["command-code"])) {
    legacyDoc["command-code"] = entry
    writeJsonAtomic(legacyAuthFile, legacyDoc)
    legacyAuthUpdated = true
  }

  return { opencodeAuthUpdated, legacyAuthUpdated }
}
