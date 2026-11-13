// tests/gui-panel.test.ts — the OpenCode Desktop GUI half, tested the way the
// host loads it. The desktop app evaluates `./gui-experimental` with
// `new Function("require", "module", "exports", code)`, where `require` serves
// only the modules the app shares with GUI bundles (`@opencode/plugin/gui`,
// `solid-js`/`web`/`store`; anything else fails the evaluation). So this file:
//
//   1. unit-tests the pure view mapping (src/rates-usage/gui/rows.ts) directly;
//   2. evaluates the BUILT dist/gui-experimental.cjs through that exact
//      Function mechanism with a stub for the GUI SDK and the real solid-js
//      for the rest, pins the require set to the shared modules, and runs the
//      `setup` against a fake context to pin every contribution: the
//      stylesheet, the side panel (id, region, the Command Code gate and the
//      stable tab object), the palette command and the + menu item, all
//      opening the same `${ctx.id}:rates-usage` layout key.
//
// It needs `npm run build:gui` to have produced the bundle. CI's `npm run
// build` step runs before `npm test`, but `npm test` itself never builds —
// locally, run `npm run build:gui` first. Nothing here imports
// `@opencode/plugin/gui` itself — the package is deliberately not a dependency
// (tests/dependency-pins.test.ts), and the stub module the sandbox provides is
// the structural mirror's runtime twin.
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { assert, assertEqual, run } from "./harness.js"
import { DESKTOP_SHARED_MODULES } from "./gui-shared-modules.js"

const HERE = join(fileURLToPath(new URL(".", import.meta.url)))
const ROOT = join(HERE, "..")
const BUNDLE = join(ROOT, "dist", "gui-experimental.cjs")

/**
 * The runtime twin of src/plugin/v2-gui-module.d.ts's mirror: registry tokens
 * the host identity-checks (so the bundle must require them, never inline
 * them), `Plugin.define` as the identity it is, and a `createKeyed` that runs
 * its body untracked (the sandbox never renders, so no owner is needed).
 */
function createGuiSdkStub() {
  const registry = (id: string) => ({ kind: "registry", id })
  return {
    Plugin: { define: (definition: unknown) => definition },
    Panel: registry("gui.panel"),
    Command: registry("gui.command"),
    MenuItem: registry("gui.menu-item"),
    Style: registry("gui.style"),
    createKeyed: (source: () => unknown, fn: (value: unknown) => void) => fn(source()),
  }
}

/**
 * A stub for the `solid-js` family: the sandbox never renders, but the
 * compiled DOM helpers are required at load (`delegateEvents` runs at module
 * scope), and Node resolves `solid-js/web` to its SSR build, whose helpers
 * throw outside a browser. Every property is a no-op function, exactly inert
 * enough to evaluate the bundle the way a window would.
 */
function createSolidStub(): unknown {
  return new Proxy(
    { __esModule: true },
    {
      get: (_target, name) => (name === "__esModule" ? true : (..._args: unknown[]) => undefined),
    },
  )
}

interface RecordedAdd {
  registry: { kind: string; id: string }
  item: unknown
}

/** A fake window context: records `add` calls and `layout.open` writes. */
interface FakeCtx {
  readonly adds: RecordedAdd[]
  readonly opened: Array<{ key: string; session: unknown }>
  readonly id: string
  readonly client: unknown
  add(registry: { kind: string; id: string }, item: unknown): void
  layout: { open(key: string, session: unknown): void }
  sessions: { current(): unknown }
}

function createFakeCtx(current: unknown = undefined): FakeCtx {
  const adds: RecordedAdd[] = []
  const opened: Array<{ key: string; session: unknown }> = []
  return {
    adds,
    opened,
    id: "commandcode",
    client: {},
    add: (registry, item) => {
      adds.push({ registry, item })
    },
    layout: {
      open: (key, session) => {
        opened.push({ key, session })
      },
    },
    sessions: { current: () => current },
  }
}

/** The session's server data slice: one Command Code selection, one catalog. */
function createData(model: { id: string; providerID: string } | undefined, providerID: string) {
  const subscriptions: Array<{ type: string; handler: (event: unknown) => void }> = []
  return {
    subscriptions,
    data: {
      // Answers only the session this store was built for — a store's
      // `session.get` is keyed by id, and a wrong id has no record.
      session: {
        get: (sessionID: string) =>
          sessionID === "s1" && model !== undefined ? { id: sessionID, model } : undefined,
      },
      location: { model: { list: () => [{ id: "glm-5", providerID, settings: {}, cost: [] }] } },
      on: (type: string, handler: (event: unknown) => void) => {
        subscriptions.push({ type, handler })
        return () => {
          const index = subscriptions.findIndex((entry) => entry.handler === handler)
          if (index !== -1) subscriptions.splice(index, 1)
        }
      },
    },
  }
}

function createSession(model: { id: string; providerID: string } | undefined, providerID: string) {
  const { data, subscriptions } = createData(model, providerID)
  return {
    session: {
      key: `srv\ns1`,
      id: "s1",
      tab: "t1",
      pending: false,
      server: { id: "srv", name: "srv", client: {}, data },
    },
    subscriptions,
  }
}

function evaluateBundle() {
  const code = readFileSync(BUNDLE, "utf-8")
  const required: string[] = []
  const sandboxRequire = createRequire(pathToFileURL(BUNDLE))
  const wrappedRequire = (id: string) => {
    required.push(id)
    if (id === "@opencode/plugin/gui") return createGuiSdkStub()
    if (id === "solid-js" || id === "solid-js/web" || id === "solid-js/store") {
      return createSolidStub()
    }
    return sandboxRequire(id)
  }
  const mod = { exports: {} as Record<string, unknown> }
  const evaluate = new Function("require", "module", "exports", code)
  evaluate(wrappedRequire, mod, mod.exports)
  return { definition: mod.exports, required, code }
}

function added(ctx: FakeCtx, id: string): RecordedAdd | undefined {
  return ctx.adds.find((entry) => entry.registry.id === id)
}

run([
  [
    "dist/gui-experimental.cjs exists (npm run build:gui produces it)",
    () => {
      assert(existsSync(BUNDLE), `missing ${BUNDLE} — run npm run build:gui first`)
    },
  ],
  [
    "rows: every shared row kind maps to its DOM view",
    async () => {
      const { guiRowView } = await import("../src/rates-usage/gui/rows.js")
      assertEqual(guiRowView(["", ""]), { kind: "gap", label: "", detail: "" })
      assertEqual(guiRowView(["Rates", "", "heading"]), {
        kind: "heading",
        label: "Rates",
        detail: "",
      })
      assertEqual(guiRowView(["in | out | cache r | w", "", "value"]), {
        kind: "value",
        label: "in | out | cache r | w",
        detail: "",
      })
      assertEqual(guiRowView(["Deals unavailable — https://x", ""]), {
        kind: "strong",
        label: "Deals unavailable — https://x",
        detail: "",
      })
      assertEqual(guiRowView(["Tier", "Premium"]), {
        kind: "row",
        label: "Tier",
        detail: "Premium",
      })
      assertEqual(guiRowView(["█████░░░", "42%", "bar", "warning"]), {
        kind: "bar",
        label: "█████░░░",
        detail: "42%",
        tone: "warning",
      })
      assertEqual(guiRowView(["█████░░░", "42%", "bar"]), {
        kind: "bar",
        label: "█████░░░",
        detail: "42%",
        tone: "success",
      })
    },
  ],
  [
    "rows: the desktop composition mirrors the TUI gate and fallback",
    async () => {
      const { guiPanelRows } = await import("../src/rates-usage/gui/rows.js")
      // A non-Command Code selection renders nothing — the visibility gate.
      assertEqual(guiPanelRows(undefined, undefined).length, 0)
      // A Command Code model the catalog cannot resolve still renders the full
      // all-N/A set: every segment heading is present.
      const empty = guiPanelRows({}, undefined)
      assert(empty.length > 0, "an unresolvable Command Code model must render all-N/A rows")
      for (const heading of ["Allowance", "Rates", "Other Information"]) {
        assert(
          empty.some((view) => view.kind === "heading" && view.label === heading),
          `the all-N/A set must carry the ${heading} heading`,
        )
      }
      // A session record the store lacks is the same as no selection.
      const catalogMissing = guiPanelRows({ settings: {}, cost: undefined }, undefined)
      assert(catalogMissing.length > 0, "a payload without cost must still render")
    },
  ],
  [
    "bundle: default export is a Plugin.define module with only a setup",
    () => {
      const { definition } = evaluateBundle()
      const def = definition as { setup?: unknown; id?: unknown; tui?: unknown }
      assert(typeof def === "object" && def !== null, "the bundle must export an object")
      assert(typeof def.setup === "function", "the GUI module needs setup(ctx)")
      // The GUI module declares no id (the host assigns the server plugin's)
      // and carries no other host's halves.
      assertEqual(def.id, undefined)
      assertEqual(def.tui, undefined)
    },
  ],
  [
    "bundle: requires only modules the desktop host shares",
    () => {
      const { required, code } = evaluateBundle()
      assert(
        required.length > 0,
        "the bundle must require the SDK module (tokens are identity-checked)",
      )
      const foreign = required.filter((id) => !DESKTOP_SHARED_MODULES.includes(id as never))
      assertEqual(
        foreign,
        [],
        `the bundle requires modules the host does not share: ${foreign.join(", ")}` +
          " — the host's evaluatePluginBundle fails the whole GUI for those",
      )
      // No dynamic escape hatches either: no bare `require(` of computed text
      // beyond the recorded ones, and no node builtins.
      assert(!/require\s*\(\s*(?!["'])/.test(code), "the bundle must not compute require targets")
      assert(
        !/\bprocess\s*\.\s*(env|version|platform)/.test(code),
        "the bundle must not read process.* — windows have no Node globals",
      )
    },
  ],
  [
    "bundle: setup contributes style, panel, command and menu item",
    () => {
      const { definition } = evaluateBundle()
      const { session } = createSession({ id: "glm-5", providerID: "commandcode" }, "commandcode")
      const ctx = createFakeCtx(session)
      ;(definition as { setup: (ctx: unknown) => void }).setup(ctx)
      assertEqual(ctx.adds.length, 4, "setup contributes exactly four items")
      assert(added(ctx, "gui.style") !== undefined, "the stylesheet must be contributed")
      assert(added(ctx, "gui.panel") !== undefined, "the side panel must be contributed")
      assert(added(ctx, "gui.command") !== undefined, "the palette command must be contributed")
      assert(added(ctx, "gui.menu-item") !== undefined, "the + menu item must be contributed")
      const css = added(ctx, "gui.style")?.item as string
      assert(
        typeof css === "string" && css.includes('[data-component="commandcode-rates-usage"]'),
        "the stylesheet must scope itself to the panel's data-component",
      )
    },
  ],
  [
    "bundle: the panel lists one stable tab, gated to Command Code",
    () => {
      const { definition } = evaluateBundle()
      const cmd = createSession({ id: "glm-5", providerID: "commandcode" }, "commandcode")
      const other = createSession({ id: "gpt-x", providerID: "openai" }, "openai")
      const ctx = createFakeCtx()
      ;(definition as { setup: (ctx: unknown) => void }).setup(ctx)
      const panel = added(ctx, "gui.panel")?.item as {
        id: string
        region: string
        list: (input: unknown) => unknown[]
        render: unknown
      }
      assertEqual(panel.id, "rates-usage")
      assertEqual(panel.region, "side")
      assert(typeof panel.render === "function")
      const listed = panel.list({ session: cmd.session, screen: {}, open: [] }) as Array<{
        id: string
        title: string
      }>
      assertEqual(listed.length, 1, "a Command Code selection lists the tab")
      assertEqual(listed[0]?.id, "rates-usage")
      assertEqual(listed[0]?.title, "Command Code")
      // Same object on every listing — the host re-renders the label on a new one.
      assertEqual(
        panel.list({ session: cmd.session, screen: {}, open: [] })[0],
        listed[0],
        "list must return the same tab object while unchanged",
      )
      // Even with the catalog missing, a Command Code selection still lists
      // (the panel renders all-N/A); another provider's selection lists none.
      assertEqual(
        panel.list({ session: other.session, screen: {}, open: [] }).length,
        0,
        "a non-Command Code selection must not list the tab",
      )
    },
  ],
  [
    "bundle: command and menu item open the same layout key",
    () => {
      const { definition } = evaluateBundle()
      const { session } = createSession({ id: "glm-5", providerID: "commandcode" }, "commandcode")
      const ctx = createFakeCtx(session)
      ;(definition as { setup: (ctx: unknown) => void }).setup(ctx)
      const command = added(ctx, "gui.command")?.item as {
        id: string
        title: string
        slash?: unknown
        run: () => void
      }
      assertEqual(command.id, "rates-usage")
      assertEqual(command.slash, undefined, "the GUI command must not offer a slash command")
      command.run()
      assertEqual(ctx.opened.length, 1)
      assertEqual(ctx.opened[0]?.key, "commandcode:rates-usage")
      assertEqual(ctx.opened[0]?.session, session)
      const item = added(ctx, "gui.menu-item")?.item as {
        menu: string
        id: string
        title: string
        keybind: string
        run: () => void
      }
      assertEqual(item.menu, "session.panel")
      assertEqual(item.id, "rates-usage")
      assertEqual(item.title, "Command Code")
      assertEqual(item.keybind, "commandcode.rates-usage")
      item.run()
      assertEqual(ctx.opened.length, 2)
      assertEqual(ctx.opened[1]?.key, "commandcode:rates-usage")
    },
  ],
  [
    "idle: subscribeGuiIdle wakes only the watched session's turns, and tears down",
    async () => {
      // The executable counterpart of the bundle-text pin below: the helper
      // panel.tsx runs inside `createKeyed` is tested here directly — both
      // turn events subscribed, other sessions' events ignored, and the
      // returned teardown unsubscribes both.
      const { subscribeGuiIdle } = await import("../src/rates-usage/gui/idle.js")
      const { data, subscriptions } = createData(undefined, "commandcode")
      let notifications = 0
      const unsubscribe = subscribeGuiIdle(data, "s1", () => {
        notifications += 1
      })
      const types = subscriptions.map((entry) => entry.type)
      assert(
        types.includes("session.idle") && types.includes("session.execution.succeeded"),
        `both turn events must be subscribed, got: ${types.join(", ")}`,
      )
      // Another session's turn must not wake this panel.
      for (const entry of subscriptions) entry.handler({ data: { sessionID: "other" } })
      assertEqual(notifications, 0, "another session's events must not notify")
      // This session's turn, on either event, wakes it once per event.
      for (const entry of subscriptions) entry.handler({ data: { sessionID: "s1" } })
      assertEqual(notifications, 2, "each watched-session turn event must notify once")
      // The teardown withdraws both handlers.
      unsubscribe()
      for (const entry of subscriptions) entry.handler({ data: { sessionID: "s1" } })
      assertEqual(notifications, 2, "the teardown must stop every notification")
    },
  ],
  [
    "bundle: the panel subscribes to the session's turn events through createKeyed",
    () => {
      // The list/render path never runs in this sandbox, so this pins the
      // WIRING one level below behavior: the bundle must drive the completed
      // turn from the data store's events, keyed per data object, through the
      // subscribeGuiIdle helper the test above exercises directly — the
      // desktop counterpart of subscribeV2Idle in the TUI half.
      const { code } = evaluateBundle()
      for (const needle of [
        `data.on("session.idle"`,
        `data.on("session.execution.succeeded"`,
        "createKeyed(",
        "turnCompleted()",
      ]) {
        assert(code.includes(needle), `the bundle must contain ${needle}`)
      }
    },
  ],
])
