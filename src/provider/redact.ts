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

/**
 * The plan gate's own words, not its envelope: `upgrade_required` (the
 * documented OpenAI-shape code), or the plan phrasing the message carries when
 * the code is absent — the live `/provider/v1/messages` 403 says "Your Go plan
 * doesn't include API access. Upgrade to Provider or higher ..." (issue #175).
 */
const PLAN_UPGRADE_PATTERN =
  /upgrade_required|upgrade to (?:goat|provider)|without api access|doesn['’]t include api access/i

/**
 * The version gate's markers: a body naming a minimum accepted CLI version, or
 * a message saying the client is out of date. Such a 403 asks for a client
 * update, never a plan change — and the live version gate collides with the
 * plan gate on `code: "upgrade_required"`, so these markers decide first
 * (issue #175).
 */
const VERSION_GATE_PATTERN = /\bminversion\b|out[-\s]of[-\s]date/i

/** True when the envelope names the minimum accepted CLI version. */
function namesMinimumVersion(record: Record<string, unknown>): boolean {
  return typeof record.minVersion === "string" || typeof record.minVersion === "number"
}

/**
 * Detects the Provider API plan gate: the `403` that flips the session to the
 * legacy transport (issue #56). The same refusal reaches the two endpoints in
 * different envelopes (issue #175):
 *
 * - `/provider/v1/chat/completions` carries
 *   `{"error":{"code":"upgrade_required", …}}` — the documented shape;
 * - `/provider/v1/messages` carries the Anthropic envelope
 *   `{"type":"error","error":{"type":"permission_error","message":"Your Go plan
 *   doesn't include API access. Upgrade to Provider or higher …"}}` — no `code`
 *   for any 403.
 *
 * The plan phrasing is therefore the signal; `permission_error` alone is not,
 * because the model gate (`MODEL_NOT_IN_PLAN`) shares that type. The
 * documented plain message ("You're on the Go plan, the only plan without API
 * access. Upgrade to GOAT or higher.") is still caught. A version-gate body
 * collides with the plan gate on `code: "upgrade_required"` and is
 * distinguishable only by its `minVersion` field or "out of date" wording —
 * those markers are checked first and never flip. Any status other than 403
 * (401, 422 cmd_zdr_no_providers, 429, 5xx, ...) never flips either.
 */
export function isUpgradeRequiredError(status: number, body: unknown): boolean {
  if (status !== 403) return false
  const candidates: string[] = []
  const pushStrings = (record: Record<string, unknown>): void => {
    for (const key of ["code", "type", "message"]) {
      const part = record[key]
      if (typeof part === "string") candidates.push(part)
    }
  }
  if (typeof body === "string") {
    candidates.push(body)
    try {
      body = JSON.parse(body)
    } catch {
      // keep the raw text as the only candidate below
    }
  }
  let versionGate = false
  if (isRecord(body)) {
    const error = body.error
    if (isRecord(error)) {
      pushStrings(error)
      versionGate ||= namesMinimumVersion(error)
    }
    pushStrings(body)
    versionGate ||= namesMinimumVersion(body)
  }
  // The version-gate guard runs first: a body that names a minimum version is
  // a client gate even when its wording borrows the plan phrasing.
  if (versionGate || candidates.some((c) => VERSION_GATE_PATTERN.test(c))) return false
  return candidates.some((c) => PLAN_UPGRADE_PATTERN.test(c))
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
