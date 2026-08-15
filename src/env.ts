// src/env.ts — COMMANDCODE_* environment overrides with safe defaults
export const DEFAULT_API_BASE = "https://api.commandcode.ai"

export function getApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
}
