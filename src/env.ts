// src/env.ts — COMMANDCODE_* environment overrides with safe defaults
export const DEFAULT_API_BASE = "https://api.commandcode.ai"

export function getApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
}

/**
 * Zero data retention (ZDR) opt-in, mirroring the CLI's `CMD_ZDR=1` (per the
 * Provider API docs: "the same opt-in the CLI exposes via CMD_ZDR=1"). Only
 * the exact value `1` opts in — unset, empty, `0`, or any other value leaves
 * ZDR off, so no `x-cmd-zdr` header is ever sent unless the user explicitly
 * asked for it. The legacy /alpha/generate transport never sends the header
 * regardless of this value.
 */
export function getCmdZdr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CMD_ZDR === "1"
}
