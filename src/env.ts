// src/env.ts — COMMANDCODE_* environment overrides with safe defaults (PLAN #2 Part A)
import { homedir } from "node:os"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models"
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000

export function getApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
}

export function getModelsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
}

export function getModelsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COMMANDCODE_MODELS_TIMEOUT_MS
  if (!raw) return DEFAULT_MODELS_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODELS_TIMEOUT_MS
}

export function getDataDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: () => string = homedir,
): string {
  const xdg = env.XDG_DATA_HOME
  if (xdg) return xdg
  return `${homeDir()}/.local/share/opencode`
}
