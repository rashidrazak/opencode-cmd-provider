// tests/redact.test.ts — credential redaction (PLAN #3 Part B, port of pi tests)
import {
  redactCommandCodeErrorText,
  commandCodeErrorMessage,
  isUpgradeRequiredError,
} from "../src/provider/redact.js"
import { assertEqual, run } from "./harness.js"

run([
  [
    "redacts Bearer tokens",
    () => {
      assertEqual(
        redactCommandCodeErrorText("401 Bearer user_abc12345 failed"),
        "401 Bearer [redacted] failed",
      )
    },
  ],

  [
    "redacts user_/cc_ keys",
    () => {
      assertEqual(redactCommandCodeErrorText("key user_abcdefgh1234"), "key [redacted]")
      assertEqual(redactCommandCodeErrorText("key cc_abcdefgh1234"), "key [redacted]")
    },
  ],

  [
    "redacts api_key= pairs",
    () => {
      assertEqual(redactCommandCodeErrorText("api_key=user_abcdefgh1234"), "api_key=[redacted]")
    },
  ],

  [
    "redacts query secrets (credential pattern consumes the query)",
    () => {
      // pi's CREDENTIAL_PATTERN matches `token=...` greedily to the next
      // whitespace/`;`/`,`/`)` boundary, so the trailing `&x=1` is consumed
      // along with the value. Identical to pi's behavior.
      assertEqual(redactCommandCodeErrorText("?token=abc123&x=1"), "?token=[redacted]")
      // A space-separated query keeps the rest intact.
      assertEqual(redactCommandCodeErrorText("?token=abc123 x=1"), "?token=[redacted] x=1")
    },
  ],

  [
    "redacts standalone sk- and JWTs",
    () => {
      assertEqual(redactCommandCodeErrorText("sk-aaaaaaaaaaaaaaaaaaaaaaaa"), "[redacted]")
      // Real JWT shape: three dot-separated base64url segments, each ≥10 chars.
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.abcdefghijklmnopqrstuvwxyz"
      assertEqual(redactCommandCodeErrorText(jwt), "[redacted]")
    },
  ],

  [
    "commandCodeErrorMessage extracts nested error text",
    () => {
      assertEqual(
        commandCodeErrorMessage({ error: { message: "bad thing" }, status: 500 }),
        "bad thing: status: 500",
      )
    },
  ],

  [
    "isUpgradeRequiredError: 403 with documented error.code upgrade_required",
    () => {
      assertEqual(
        isUpgradeRequiredError(403, {
          error: { code: "upgrade_required", message: "You're on the Go plan" },
        }),
        true,
      )
    },
  ],

  [
    "isUpgradeRequiredError: 403 with documented error.type upgrade_required",
    () => {
      assertEqual(isUpgradeRequiredError(403, { error: { type: "upgrade_required" } }), true)
    },
  ],

  [
    "isUpgradeRequiredError: 403 with documented message variants (substring tolerant)",
    () => {
      // The docs' message: "You're on the Go plan, the only plan without API
      // access. Upgrade to GOAT or higher." — any documented phrasing matches.
      assertEqual(
        isUpgradeRequiredError(403, {
          error: {
            message:
              "You're on the Go plan, the only plan without API access. Upgrade to GOAT or higher.",
          },
        }),
        true,
      )
      assertEqual(
        isUpgradeRequiredError(403, { error: { message: "only plan without API access" } }),
        true,
      )
      assertEqual(
        isUpgradeRequiredError(403, { error: { message: "Upgrade to GOAT or higher" } }),
        true,
      )
      // Raw (unparsed) text body still detected.
      assertEqual(isUpgradeRequiredError(403, '{"error":{"code":"upgrade_required"}}'), true)
    },
  ],

  [
    "isUpgradeRequiredError: 403 mentioning the Go plan without upgrade intent does not match",
    () => {
      assertEqual(
        isUpgradeRequiredError(403, {
          error: { message: "This model requires the Go plan or higher" },
        }),
        false,
      )
      assertEqual(
        isUpgradeRequiredError(403, {
          error: { message: "You're on the Go plan. Contact support." },
        }),
        false,
      )
    },
  ],

  [
    "isUpgradeRequiredError: never flips on non-403 statuses (401/422/429/500)",
    () => {
      for (const status of [401, 422, 429, 500]) {
        assertEqual(
          isUpgradeRequiredError(status, {
            error: { code: "upgrade_required", message: "You're on the Go plan" },
          }),
          false,
          `status ${status} must not flip`,
        )
      }
    },
  ],

  [
    "isUpgradeRequiredError: 403 with unrelated body does not match",
    () => {
      assertEqual(isUpgradeRequiredError(403, { error: { message: "forbidden" } }), false)
      assertEqual(isUpgradeRequiredError(403, "forbidden"), false)
      assertEqual(isUpgradeRequiredError(403, { error: { code: "rate_limit_error" } }), false)
    },
  ],
])
