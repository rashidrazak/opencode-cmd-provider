// tests/redact.test.ts — credential redaction (PLAN #3 Part B, port of pi tests)
import {
  redactCommandCodeErrorText,
  commandCodeErrorMessage,
  isUpgradeRequiredError,
  isVersionGateError,
  readGate,
} from "../src/provider/redact.js"
import {
  liveChatUpgradeBody,
  liveMessagesUpgradeBody,
  upgradeRequiredBody,
  versionGateBody,
} from "./helpers/mock-cc.js"
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
    "isUpgradeRequiredError: the live /provider/v1/messages 403 flips (permission_error, no error.code)",
    () => {
      // Issue #175: /messages answers the Anthropic envelope — the plan
      // phrasing, `type: permission_error`, and no `error.code` at all (the
      // OpenAI endpoint is the one that adds `"code":"upgrade_required"`).
      assertEqual(isUpgradeRequiredError(403, JSON.parse(liveMessagesUpgradeBody())), true)
      // The raw, unparsed body is detected too.
      assertEqual(isUpgradeRequiredError(403, liveMessagesUpgradeBody()), true)
      // The live OpenAI envelope: the same message plus the code.
      assertEqual(isUpgradeRequiredError(403, JSON.parse(liveChatUpgradeBody())), true)
    },
  ],

  [
    "isUpgradeRequiredError: permission_error alone is not a plan flip (the model gate shares it)",
    () => {
      // /messages never emits upgrade_required for any 403, and the model gate
      // (MODEL_NOT_IN_PLAN) carries the same permission_error type — the plan
      // phrasing is what decides, not the type (issue #175).
      assertEqual(
        isUpgradeRequiredError(403, {
          type: "error",
          error: {
            type: "permission_error",
            message:
              "MODEL_NOT_IN_PLAN: Claude Sonnet 4.6 available in Pro and above plans or extra on demand usage",
          },
        }),
        false,
      )
      assertEqual(
        isUpgradeRequiredError(403, {
          type: "error",
          error: { type: "permission_error", message: "forbidden" },
        }),
        false,
      )
    },
  ],

  [
    "isUpgradeRequiredError: a version-gate 403 (minVersion / out of date) is never a plan flip",
    () => {
      // The live version gate collides with the plan gate: it carries the same
      // `upgrade_required` code and is distinguishable only by its `minVersion`
      // field and "out of date" message. It asks for a client update, not a
      // plan change (issue #175).
      assertEqual(isUpgradeRequiredError(403, JSON.parse(versionGateBody())), false)
      assertEqual(isUpgradeRequiredError(403, versionGateBody()), false)
      assertEqual(
        isUpgradeRequiredError(403, {
          error: { message: "Your Command Code CLI is out of date." },
        }),
        false,
      )
      // The guard wins over plan phrasing in the same body: a body naming a
      // minimum version is a client gate, never a transport flip.
      assertEqual(
        isUpgradeRequiredError(403, {
          error: {
            code: "upgrade_required",
            message: "Upgrade to Provider or higher.",
            minVersion: "1.15.1",
          },
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

  [
    "isVersionGateError: the live version-gate 403 is detected (parsed and raw), never a plan body",
    () => {
      // Issue #173: the legacy gateway refuses a client below its minimum with
      // the same `upgrade_required` code the plan gate uses, so the gate's own
      // markers (`minVersion` / "out of date") are what identify it.
      assertEqual(isVersionGateError(403, JSON.parse(versionGateBody())), true)
      assertEqual(isVersionGateError(403, versionGateBody()), true)
      assertEqual(
        isVersionGateError(403, { error: { message: "Your Command Code CLI is out of date." } }),
        true,
      )
      // The plan gate is not a version gate, in either live envelope.
      assertEqual(isVersionGateError(403, JSON.parse(upgradeRequiredBody())), false)
      assertEqual(isVersionGateError(403, JSON.parse(liveMessagesUpgradeBody())), false)
      assertEqual(isVersionGateError(403, JSON.parse(liveChatUpgradeBody())), false)
      // Only a 403 is ever a gate.
      assertEqual(isVersionGateError(422, JSON.parse(versionGateBody())), false)
      assertEqual(isVersionGateError(403, { error: { message: "forbidden" } }), false)
    },
  ],

  [
    "readGate: one reading decides the version gate, the plan gate, or neither",
    () => {
      // Issue #173: the legacy gateway refuses a client below its minimum with
      // the same `upgrade_required` code the plan gate uses, so the gate's own
      // markers (`minVersion` / "out of date") are what identify it — and the
      // reading is exclusive: one gate or the other, never both.
      const version = readGate(403, JSON.parse(versionGateBody()))
      assertEqual(version.versionGate, true)
      assertEqual(version.planGate, false)
      assertEqual(version.minimumVersion, "0.18.10")
      // Raw, unparsed bodies read the same.
      assertEqual(readGate(403, versionGateBody()).minimumVersion, "0.18.10")
      assertEqual(
        readGate(403, { error: { message: "Your Command Code CLI is out of date." } }).versionGate,
        true,
      )
      // The plan gate is not a version gate, in either live envelope, and never
      // names a floor.
      for (const planBody of [
        JSON.parse(upgradeRequiredBody()),
        JSON.parse(liveMessagesUpgradeBody()),
        JSON.parse(liveChatUpgradeBody()),
      ]) {
        const plan = readGate(403, planBody)
        assertEqual(plan.planGate, true, `plan gate: ${JSON.stringify(planBody)}`)
        assertEqual(plan.versionGate, false)
        assertEqual(plan.minimumVersion, undefined)
      }
      // `minVersion` from the envelope or the top level, string or number.
      assertEqual(readGate(403, { minVersion: 1.2 }).minimumVersion, "1.2")
      assertEqual(readGate(403, { error: { minVersion: "2.0.0" } }).minimumVersion, "2.0.0")
      // Only a 403 is ever a gate; an unrelated 403 is neither.
      assertEqual(readGate(422, JSON.parse(versionGateBody())), {
        versionGate: false,
        planGate: false,
      })
      assertEqual(readGate(403, { error: { message: "forbidden" } }), {
        versionGate: false,
        planGate: false,
      })
    },
  ],
])
