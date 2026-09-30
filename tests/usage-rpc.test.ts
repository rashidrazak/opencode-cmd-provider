// tests/usage-rpc.test.ts — the v2 usage bridge (ADR-0020, issue #243
// amendment): the plugin-RPC port's definition, the server half's handler
// (host credential → billing fetch, key never in the payload), and the TUI
// half's loader (port call → parsed outcome). Both halves are exercised with
// mocked harnesses — a fake `ctx.rpc.register`, a fake client, and a recording
// fetch — no network, no host packages, no TUI runtime.
import { readFileSync } from "node:fs"
import {
  USAGE_RPC_DEFINITION,
  createUsageRpcLoader,
  registerUsageRpc,
  type UsageRpcOutcome,
} from "../src/rates-usage/usage-rpc.js"
import type { UsageLoadRequest, UsagePanelState } from "../src/rates-usage/tui-usage.js"
import type { HostCredential } from "../src/provider/auth-key.js"
import type { V2RpcCallContext, V2SetupContext } from "../src/plugin/v2-types.js"
import type { V2TuiClient } from "../src/plugin/v2-tui-types.js"
import { assert, assertEqual, run } from "./harness.js"

const BASE = "http://mock"
const WHOAMI = "/alpha/whoami"
const SUBSCRIPTIONS = "/alpha/billing/subscriptions"
const CREDITS = "/alpha/billing/credits"
const SUMMARY = "/alpha/usage/summary"

const NOW = Date.parse("2026-10-01T12:00:00.000Z")
const PERIOD_START = "2026-09-05T00:00:00.000Z"
const PERIOD_END = "2026-10-05T00:00:00.000Z"

/** The four billing answers of a live Go account. */
function billingBodies(): Record<string, unknown> {
  return {
    [WHOAMI]: { success: true, org: null },
    [SUBSCRIPTIONS]: {
      success: true,
      data: {
        status: "active",
        planId: "individual-go",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
      },
    },
    [CREDITS]: {
      windowLimits: {
        limited: true,
        fiveHour: { used: 0.5, cap: 3, exceeded: false },
        weekly: { used: 1.5, cap: 6, exceeded: false, resetAt: NOW + 6 * 3_600_000 },
      },
      credits: { monthlyCredits: 0.5, purchasedCredits: 4.81934405 },
    },
    [SUMMARY]: { totalMonthlyCredits: 39.5 },
  }
}

/** A recording stub over the billing answers, like the controller suites'. */
function stubFetch(bodies: Record<string, unknown> = billingBodies()): {
  urls: string[]
  calls: Array<{ url: string; init: RequestInit }>
  fetch: typeof fetch
} {
  const urls: string[] = []
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string, init: RequestInit = {}) => {
    urls.push(url)
    calls.push({ url, init })
    const path = url.replace(BASE, "").split("?")[0]!
    if (!(path in bodies)) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(bodies[path]), { status: 200 })
  }) as unknown as typeof fetch
  return { urls, calls, fetch: impl }
}

interface RegisteredPort {
  definition: unknown
  handlers: Record<string, (input: unknown, context: V2RpcCallContext) => Promise<unknown>>
  /** The `progress` frames the handler emitted (#251). */
  emitted: Array<{ name: string; data: Record<string, unknown> }>
}

/** A minimal server context: only `rpc.register` is reached, with its events. */
function fakeServerCtx(): { ctx: V2SetupContext; port(): RegisteredPort } {
  let registered: RegisteredPort | undefined
  const ctx = {
    rpc: {
      register: async (definition: unknown, handlers: unknown) => {
        const emitted: RegisteredPort["emitted"] = []
        registered = { definition, handlers: handlers as RegisteredPort["handlers"], emitted }
        return {
          events: {
            emit: async (name: string, data: Record<string, unknown>) => {
              emitted.push({ name, data })
            },
          },
        }
      },
    },
  } as unknown as V2SetupContext
  return {
    ctx,
    port: () => {
      if (registered === undefined) throw new Error("the port was not registered")
      return registered
    },
  }
}

/** One handler call with a live signal. */
async function callUsage(port: RegisteredPort, input: unknown): Promise<UsageRpcOutcome> {
  const handler = port.handlers["usage"]
  if (handler === undefined) throw new Error("the usage method was not registered")
  return (await handler(input, { signal: new AbortController().signal })) as UsageRpcOutcome
}

/** A load request with the panel's abort signal and clock instant. */
function request(scope?: unknown): UsageLoadRequest {
  return {
    ...(scope === undefined ? {} : { scope: scope as UsageLoadRequest["scope"] }),
    signal: new AbortController().signal,
    now: NOW,
  }
}

run([
  [
    "the port definition pins one method, object schemas, and the progress event",
    () => {
      assertEqual(USAGE_RPC_DEFINITION.id, "commandcode")
      assertEqual(Object.keys(USAGE_RPC_DEFINITION.methods), ["usage"])
      const method = USAGE_RPC_DEFINITION.methods.usage
      assertEqual((method.input as { type: string }).type, "object")
      assertEqual((method.output as { type: string }).type, "object")
      assertEqual(Object.keys(USAGE_RPC_DEFINITION.events), ["progress"])
      const schema = USAGE_RPC_DEFINITION.events.progress.schema
      assertEqual(schema.type, "object")
      assertEqual(schema.required, ["callId", "result"])
      assertEqual(schema.additionalProperties, false)
      // The three input fields the caller may send (issue #251).
      assertEqual(Object.keys(method.input.properties), ["scope", "previous", "callId"])
    },
  ],

  [
    "the handler emits one progress frame per landing leg, correlated by callId",
    async () => {
      const { ctx, port } = fakeServerCtx()
      const { fetch } = stubFetch()
      await registerUsageRpc(ctx, async () => ({ key: "host_key", source: "host" }), {
        fetchOptions: { baseURL: BASE, fetch, env: {} },
      })
      const outcome = await callUsage(port(), { callId: "call_1" })
      assertEqual(outcome.result.state, "usage")
      const frames = port().emitted
      assertEqual(frames.length, 3, "credits, subscriptions and summary each publish")
      for (const frame of frames) {
        assertEqual(frame.name, "progress")
        assertEqual(frame.data.callId, "call_1")
        assertEqual((frame.data.result as { state: string }).state, "usage")
        assertEqual(frame.data.provenance, { kind: "host" })
      }
      // The frames are merged-so-far views; the last one is the settled snapshot.
      assertEqual(frames.at(-1)!.data.result, outcome.result)
      // Without a callId there is nothing to correlate and nothing is emitted.
      port().emitted.length = 0
      await callUsage(port(), {})
      assertEqual(port().emitted.length, 0, "no callId, no progress frames")
    },
  ],

  [
    "the handler merges the caller's previous snapshot over a failed leg",
    async () => {
      const { ctx, port } = fakeServerCtx()
      const { fetch } = stubFetch({
        [WHOAMI]: { success: true, org: null },
        [CREDITS]: {
          windowLimits: { limited: true, fiveHour: { used: 1, cap: 3, exceeded: false } },
          credits: { monthlyCredits: 0.5 },
        },
      })
      await registerUsageRpc(ctx, async () => ({ key: "host_key", source: "host" }), {
        fetchOptions: { baseURL: BASE, fetch, env: {} },
      })
      const outcome = await callUsage(port(), {
        previous: { purchasedCredits: 7, totals: { requests: 12 } },
      })
      assert(outcome.result.state === "usage")
      assertEqual(
        outcome.result.snapshot.fiveHour,
        { used: 1, cap: 3, exceeded: false },
        "the credits leg refreshed",
      )
      assertEqual(
        outcome.result.snapshot.purchasedCredits,
        7,
        "the extra-credit row survives the dead sub-request",
      )
      assertEqual(
        outcome.result.snapshot.totals,
        { requests: 12 },
        "the totals survive the summary miss",
      )
    },
  ],

  [
    "the server half registers the port, resolves the Host credential, and fetches with it",
    async () => {
      const { ctx, port } = fakeServerCtx()
      const { urls, calls, fetch } = stubFetch()
      const credential: HostCredential = { key: "host_key", source: "host" }
      await registerUsageRpc(ctx, async () => credential, {
        fetchOptions: { baseURL: BASE, fetch, env: {} },
      })

      const registered = port()
      assertEqual(
        (registered.definition as { id: string }).id,
        "commandcode",
        "the registered definition is the port",
      )
      const outcome = await callUsage(registered, {})
      assertEqual(
        urls.map((url) => new URL(url).pathname),
        [WHOAMI, SUBSCRIPTIONS, CREDITS, SUMMARY],
        "the full chain on a scope-less call",
      )
      const auth = (calls[0]!.init.headers ?? {}) as Record<string, string>
      assertEqual(auth.authorization, "Bearer host_key", "the Host's key did the fetch")
      assertEqual(outcome.result.state, "usage", "the snapshot travels back")
      assertEqual(outcome.provenance, { kind: "host" }, "the Host rung is named")
      assertEqual(
        outcome.result.state === "usage" ? outcome.result.snapshot.purchasedCredits : undefined,
        4.81934405,
        "the purchased extra-credit balance round-trips",
      )
      assert(
        outcome.scope?.subscription?.since === PERIOD_START,
        "the refreshed scope travels back for the next call",
      )
      assertEqual(outcome.scope?.subscription?.plan, "go")
      // The key never rides in the payload.
      assert(!JSON.stringify(outcome).includes("host_key"), "no key in the outcome")
    },
  ],

  [
    "the server half's cached scope shortens the next call to credits + summary",
    async () => {
      const { ctx, port } = fakeServerCtx()
      const { urls, fetch } = stubFetch()
      await registerUsageRpc(ctx, async () => ({ key: "host_key", source: "host" }), {
        fetchOptions: { baseURL: BASE, fetch, env: {} },
      })
      const first = await callUsage(port(), {})
      const second = await callUsage(port(), { scope: first.scope })
      assertEqual(
        urls.map((url) => new URL(url).pathname).slice(4),
        [CREDITS, SUMMARY],
        "a fresh scope skips whoami and subscriptions",
      )
      assertEqual(
        new URL(urls[5]!).searchParams.get("since"),
        PERIOD_START,
        "the summary keeps its period pin",
      )
      assertEqual(second.provenance, { kind: "host" })
    },
  ],

  [
    "no connected credential: the notice answer, zero requests",
    async () => {
      const { ctx, port } = fakeServerCtx()
      const { urls, fetch } = stubFetch()
      await registerUsageRpc(ctx, async () => undefined, {
        fetchOptions: { baseURL: BASE, fetch, env: {} },
      })
      assertEqual(await callUsage(port(), {}), { result: { state: "no-credential" } })
      assertEqual(urls.length, 0, "a miss must not touch the network")
    },
  ],

  [
    "an env-method credential keeps its named rung",
    async () => {
      const { ctx, port } = fakeServerCtx()
      const { fetch } = stubFetch()
      await registerUsageRpc(ctx, async () => ({ key: "env_key", source: "environment" }), {
        fetchOptions: { baseURL: BASE, fetch, env: {} },
      })
      const outcome = await callUsage(port(), {})
      assertEqual(outcome.provenance, { kind: "environment" })
    },
  ],

  [
    "a malformed scope is dropped, not trusted",
    async () => {
      const { ctx, port } = fakeServerCtx()
      const { urls, fetch } = stubFetch()
      await registerUsageRpc(ctx, async () => ({ key: "k", source: "host" }), {
        fetchOptions: { baseURL: BASE, fetch, env: {} },
      })
      const outcome = await callUsage(port(), { scope: "not-a-scope" })
      assertEqual(urls.length, 4, "a junk scope is a full chain, not a crash")
      assertEqual(outcome.result.state, "usage")
    },
  ],

  [
    "the TUI loader calls the port with the cached scope and parses the outcome",
    async () => {
      const calls: Array<{ input: unknown; callOptions?: { signal?: AbortSignal } }> = []
      const outcome: UsageRpcOutcome = {
        result: {
          state: "usage",
          snapshot: {
            plan: "go",
            limited: true,
            fiveHour: { used: 1, cap: 3, exceeded: false },
            purchasedCredits: 4.82,
          },
        },
        provenance: { kind: "host" },
        scope: { orgId: "org_1", subscription: { readAt: NOW, since: PERIOD_START } },
      }
      const client = {
        rpc: (definition: unknown) => {
          assertEqual(definition, USAGE_RPC_DEFINITION, "the loader passes the port definition")
          return {
            usage: async (input: unknown, callOptions?: { signal?: AbortSignal }) => {
              calls.push({ input, callOptions })
              return outcome
            },
          }
        },
      } as V2TuiClient
      const load = createUsageRpcLoader(client)
      const scope = { orgId: "org_1" }
      const loaded = await load(request(scope))
      assertEqual(calls.length, 1, "one port call per load")
      assertEqual(calls[0]!.input, { scope }, "the cached scope travels in")
      assert(calls[0]!.callOptions?.signal instanceof AbortSignal, "the abort signal travels in")
      assertEqual(loaded.result, outcome.result)
      assertEqual(loaded.provenance, { kind: "host" })
      assertEqual(loaded.scope, outcome.scope)
    },
  ],

  [
    "the loader subscribes to progress, filters by callId, and unsubscribes on settle",
    async () => {
      const captured: { handler?: (event: unknown) => void; unsubscribed: boolean } = {
        unsubscribed: false,
      }
      let input: Record<string, unknown> | undefined
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const outcome: UsageRpcOutcome = {
        result: { state: "usage", snapshot: { limited: true } },
      }
      const client = {
        rpc: () => ({
          usage: async (value: unknown) => {
            input = value as Record<string, unknown>
            await gate
            return outcome
          },
          events: {
            on: (name: string, handler: (event: unknown) => void) => {
              assertEqual(name, "progress", "the loader subscribes to the port's event")
              captured.handler = handler
              return () => {
                captured.unsubscribed = true
              }
            },
          },
        }),
      } as unknown as V2TuiClient
      const partials: UsagePanelState[] = []
      const pending = createUsageRpcLoader(client)({
        ...request(),
        previous: { totals: { requests: 1 } },
        onPartial: (state) => partials.push(state),
      })
      await new Promise((resolve) => setImmediate(resolve))
      assertEqual(input?.previous, { totals: { requests: 1 } }, "the merge base travels in")
      const callId = input?.callId
      assert(typeof callId === "string" && callId.length > 0, "a callId travels in")
      // A foreign callId is ignored; the matching frame is parsed and forwarded.
      captured.handler?.({
        data: { callId: "someone-else", result: { state: "usage", snapshot: { limited: true } } },
      })
      captured.handler?.({
        data: {
          callId,
          result: { state: "usage", snapshot: { limited: true, purchasedCredits: 4.82 } },
          provenance: { kind: "environment" },
        },
      })
      assertEqual(partials.length, 1)
      assertEqual(partials[0]!.result, {
        state: "usage",
        snapshot: { limited: true, purchasedCredits: 4.82 },
      })
      assertEqual(partials[0]!.provenance, { kind: "environment" })
      // A malformed frame is dropped, never thrown.
      captured.handler?.({ data: { callId, result: 7 } })
      assertEqual(partials.length, 1, "the mangled frame dropped")
      release?.()
      const loaded = await pending
      assertEqual(loaded.result, outcome.result)
      assertEqual(captured.unsubscribed, true, "the subscription is torn down on settle")
      // Late frames after settle are ignored, never overwriting the outcome.
      captured.handler?.({
        data: { callId, result: { state: "usage", snapshot: { limited: false } } },
      })
      assertEqual(partials.length, 1, "a late frame cannot regress the panel")
    },
  ],

  [
    "the TUI loader degrades a codec-mangled answer instead of throwing",
    async () => {
      const loader = (output: unknown) =>
        createUsageRpcLoader({
          rpc: () => ({ usage: async () => output }),
        } as unknown as V2TuiClient)
      // Not an object at all.
      assertEqual(await loader("junk")(request()), { result: { state: "unavailable" } })
      // An unknown state, and a usage state with a non-object snapshot.
      assertEqual(await loader({ result: { state: "???" } })(request()), {
        result: { state: "unavailable" },
      })
      assertEqual(await loader({ result: { state: "usage", snapshot: 7 } })(request()), {
        result: { state: "unavailable" },
      })
      // A snapshot whose fields lost their types: bad fields drop, good ones stay.
      const loaded = await loader({
        result: {
          state: "usage",
          snapshot: {
            fiveHour: "junk",
            weekly: { used: 1.5, cap: 6, exceeded: true, resetAt: NOW + 1000 },
            totals: { requests: "many", cost: 3 },
          },
        },
      })(request())
      assert(loaded.result.state === "usage", "the readable remainder stays")
      assertEqual(loaded.result.snapshot.fiveHour, undefined, "the mangled window is dropped")
      assertEqual(loaded.result.snapshot.weekly, {
        used: 1.5,
        cap: 6,
        exceeded: true,
        resetAt: NOW + 1000,
      })
      assertEqual(loaded.result.snapshot.totals, { cost: 3 }, "only the numeric total survives")
      // A provenance with an unknown kind is dropped, never guessed.
      assertEqual(await loader({ result: { state: "no-credential" }, provenance: 7 })(request()), {
        result: { state: "no-credential" },
      })
    },
  ],

  [
    "the bridge module never logs, renders keys, or imports host packages",
    () => {
      const source = readFileSync(
        new URL("../src/rates-usage/usage-rpc.ts", import.meta.url).pathname,
        "utf-8",
      )
      assert(!/console\./.test(source), "the bridge must not log")
      assert(!/from\s+["']solid-js["']/.test(source), "no solid-js import")
      assert(!/from\s+["']@opencode-ai\//.test(source), "no @opencode-ai/* import")
      assert(!/from\s+["']@opencode\//.test(source), "no @opencode/* import")
    },
  ],
])
