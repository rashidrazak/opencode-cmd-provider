// tests/redact.test.ts — credential redaction (PLAN #3 Part B, port of pi tests)
import { redactCommandCodeErrorText, commandCodeErrorMessage } from "../src/provider/redact.js"
import { assertEqual, run } from "./harness.js"

run([
  ["redacts Bearer tokens", () => {
    assertEqual(redactCommandCodeErrorText("401 Bearer user_abc12345 failed"), "401 Bearer [redacted] failed")
  }],

  ["redacts user_/cc_ keys", () => {
    assertEqual(redactCommandCodeErrorText("key user_abcdefgh1234"), "key [redacted]")
    assertEqual(redactCommandCodeErrorText("key cc_abcdefgh1234"), "key [redacted]")
  }],

  ["redacts api_key= pairs", () => {
    assertEqual(redactCommandCodeErrorText("api_key=user_abcdefgh1234"), "api_key=[redacted]")
  }],

  ["redacts query secrets (credential pattern consumes the query)", () => {
    // pi's CREDENTIAL_PATTERN matches `token=...` greedily to the next
    // whitespace/`;`/`,`/`)` boundary, so the trailing `&x=1` is consumed
    // along with the value. Identical to pi's behavior.
    assertEqual(redactCommandCodeErrorText("?token=abc123&x=1"), "?token=[redacted]")
    // A space-separated query keeps the rest intact.
    assertEqual(redactCommandCodeErrorText("?token=abc123 x=1"), "?token=[redacted] x=1")
  }],

  ["redacts standalone sk- and JWTs", () => {
    assertEqual(redactCommandCodeErrorText("sk-aaaaaaaaaaaaaaaaaaaaaaaa"), "[redacted]")
    // Real JWT shape: three dot-separated base64url segments, each ≥10 chars.
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.abcdefghijklmnopqrstuvwxyz"
    assertEqual(redactCommandCodeErrorText(jwt), "[redacted]")
  }],

  ["commandCodeErrorMessage extracts nested error text", () => {
    assertEqual(
      commandCodeErrorMessage({ error: { message: "bad thing" }, status: 500 }),
      "bad thing: status: 500",
    )
  }],
])
