// src/provider/redact.ts — credential redaction (PLAN #3 Part B)
//
// Port of pi-commandcode-provider/src/overflow.ts, keeping only the
// redaction functions. Overflow-normalization functions and the
// CommandCodeMessageLike type are dropped: opencode has its own
// context-overflow handling; if a context-overflow error surfaces it
// arrives as a plain AI SDK error and opencode's own compaction handles it.
// Applied to every error surfaced to opencode — AI SDK errors must never
// leak credentials (DESIGN §6.6).

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const CREDENTIAL_PATTERN =
  /\b(?:api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|authorization)\s*[=:]\s*[^\s,;)]+/gi
const USER_TOKEN_PATTERN = /\b(?:user|cc)_[A-Za-z0-9_-]{8,}\b/gi
const QUERY_SECRET_PATTERN =
  /([?&](?:api[-_ ]?key|apikey|access_token|refresh_token|token|secret|password)=)[^&#\s]+/gi
const STANDALONE_SECRET_PATTERN =
  /\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g

export function redactCommandCodeErrorText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(CREDENTIAL_PATTERN, (match) => {
      const separatorIndex = match.search(/[=:]/)
      return separatorIndex < 0 ? "[redacted]" : `${match.slice(0, separatorIndex + 1)}[redacted]`
    })
    .replace(USER_TOKEN_PATTERN, "[redacted]")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(STANDALONE_SECRET_PATTERN, "[redacted]")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function commandCodeErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return undefined

  const record = value
  const parts: string[] = []
  for (const key of [
    "message",
    "errorMessage",
    "error",
    "detail",
    "details",
    "code",
    "type",
    "reason",
  ]) {
    const part = commandCodeErrorMessage(record[key])
    if (part && !parts.includes(part)) parts.push(part)
  }

  for (const key of ["status", "statusCode", "httpStatus"]) {
    const status = record[key]
    if (typeof status === "string" || typeof status === "number") {
      const statusPart = `status: ${status}`
      if (!parts.includes(statusPart)) parts.push(statusPart)
    }
  }

  return parts.length > 0 ? redactCommandCodeErrorText(parts.join(": ")) : undefined
}
