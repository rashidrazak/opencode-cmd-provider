# ADR-0025: A prebuilt CommonJS GUI bundle for the OpenCode Desktop host

Status: accepted

## Context

The Rates & usage panel had two surfaces, one per [Host](../../CONTEXT.md)
family: the TUI sidebar (`./tui`, both lines) and nothing for the OpenCode
**Desktop** app (the `ai.opencode.desktop` Electron line, host CLI 2.2.7). The
desktop app loads GUI plugins through a third contract — the package's
`./gui-experimental` export — and the TUI half cannot serve it: the desktop
window runs a DOM renderer (solid-dom, not `@opentui/*`), a different context
type, and a different loader (`evaluatePluginBundle`).

Three constraints shaped the decision:

1. **The host injects the SDK.** A desktop window evaluates the bundle with
   `new Function("require", "module", "exports", code)`, where `require`
   serves only the modules the app shares (`@opencode/plugin/gui`,
   `effect`, `@opencode/client`(+`/effect`, `/solid`), the `solid-js` family,
   and the `gui/{file,review,browser}` submodules). Anything else fails the
   whole evaluation ("requires a module the app does not share"). The bundle
   must therefore be ONE prebuilt CommonJS file that keeps `@opencode/plugin/gui`
   and the `solid-js` family as _requires_ — the registry tokens
   (`Panel`/`Command`/`MenuItem`/`Style`) are identity-checked, so they can
   never be inlined — while inlining everything else.
2. **The SDK package cannot be a dependency.** `@opencode/plugin` 2.2.7
   peer-requires `solid-js >=1.9.0` — a requirement shape
   `tests/dependency-pins.test.ts` deliberately cannot model — and a runtime
   dependency would be wrong under constraint 1 anyway. The types are mirrored
   structurally in `src/plugin/v2-gui-module.d.ts`
   (`declare module "@opencode/plugin/gui"`), the same policy as
   `v2-types.ts`/`v2-tui-types.ts`, and the unit test evaluates the built
   bundle against a stub of that mirror.
3. **The Effect split.** The desktop SDK declares stores and runtime storage
   with Effect `Schema` (`Schema.ConstraintCodec`). This repo's root
   `effect` is 4.0.0-beta.83 while the host embeds 4.1.0; a schema object
   built by one and decoded by the other spans the version split. The GUI
   half therefore ships **no Effect Schema at all**: no declared stores, no
   `ctx.storage.store`, and consequently no persisted sidebar layout and no
   segment-settings dialog. The desktop panel renders the fixed default
   layout (every segment, historic order) — the same rows the TUI composes
   through `panelRows(ratesUsageSegmentsV2(model), …)` in
   `src/rates-usage/panel-rows.ts`. When the host ships a schema-free storage
   or the effect ranges converge, the layout and the dialog port from
   `tui.tsx`'s `createV2LayoutStore` without touching the row model.

## Decision

- The package publishes a fourth export: `"./gui-experimental":
"./dist/gui-experimental.cjs"` — one prebuilt CommonJS file, built by
  `scripts/vite-gui.config.mjs` (`npm run build:gui`, wired into
  `npm run build`). Vite + `vite-plugin-solid` compile the DOM JSX the window
  provides; bun stays a build-tui-only tool. `tsc` cannot emit the solid-dom
  runtime, and the GUI program type-checks separately in `tsconfig.gui.json`
  (`jsx: preserve`, solid-js import source, DOM lib) — excluded from the root
  program, whose JSX is `@opentui/solid`.
- Source lives in `src/rates-usage/gui/`: `index.tsx` (the
  `Plugin.define({ setup })` default export — no id, the host assigns the
  server plugin's), `panel.tsx` (the `Panel`/`Command`/`MenuItem`/`Style`
  registrations and the per-session body), `rows.ts` (the pure view mapping,
  SDK-free and unit-testable), `styles.ts` (CSS injected with
  `ctx.add(Style, css)`, scoped to `data-component="commandcode-rates-usage"`,
  themed with the app's v2 tokens — `--v2-text-text-*`,
  `--v2-state-fg-success/warning/danger`, `--v2-font-family-code` — with
  static fallbacks).
- The panel is one side-region tab ("Command Code"), listed only while the
  routed session's selected model is a Command Code one (the same
  `v2ModelFor` gate as the v2 TUI, reading the desktop data store's
  `session.get(id)?.model` against `location.model.list()`). The tab object is
  a module-level constant, as `Panel.list` requires. No `pinned` tab, no
  mobile view, no slash command (slash semantics in the desktop composer are
  ambiguous), no `main` process entry.
- Live usage rides the existing bridge (ADR-0020) unchanged: the loader is
  `createUsageRpcLoader` against **the mounted session's own server client**,
  read per chain (ADR-0020 rule 3), so the session's server answers with its
  own connected account. The completed-turn signal is the server data store's
  `session.idle` / `session.execution.succeeded`, subscribed through
  `createKeyed` per data-object generation (a restarted server swaps the
  object) and filtered to the session by id. The last-good store
  (`globalUsageCache()`) is keyed by `SessionRef.key` (`<server>\n<session>`),
  so sessions on two servers cannot seed each other's numbers.
- The palette command (`commandcode.rates-usage`, section "session") and the
  `session.panel` `MenuItem` both open `${ctx.id}:rates-usage` for the
  session on screen via `ctx.layout.open`.

## Verification

- `tests/gui-panel.test.ts` evaluates the BUILT bundle exactly the way the
  host does (`new Function("require","module","exports", …)`, stubbed shared
  modules), pins the require set to the shared modules (no node builtins, no
  computed `require`, no `process.*`), and drives `setup` against a fake
  context to pin all four contributions, the Command Code gate, the stable tab
  object, and the shared layout key. The pure view mapping in `rows.ts` is
  unit-tested directly.
- `tests/contract.test.ts` pins the export mapping and a text-level scan of
  the built artifact's require targets.
- Live, against the real desktop CLI 2.2.7 in an isolated HOME/XDG sandbox:
  an `npm pack`ed install reports `features: { server: true, gui: true }`,
  state `active`, and `GET /api/plugin/gui?id=commandcode` serves the bundle;
  the nameless local-directory branch (`dev/opencode-plugin/`, which build:gui
  equips with a literal `gui-experimental.cjs` file — a re-export wrapper
  cannot work there, since the window's require only serves shared modules)
  reports the same.

## Consequences

- The desktop app gains the panel with zero behavior change on v1, v2-CLI, and
  the TUI: `src/rates-usage/panel-rows.ts`, `usage-panel.ts`,
  `usage-rpc-client.ts`, `usage-rpc-protocol.ts` and `usage-cache.ts` are
  host-agnostic by construction, and the GUI imports only those plus
  `segments.ts`/`format.ts`/`catalog.ts`.
- The GUI bundle is a generated artifact readers should treat like `dist/`:
  unminified and greppable so the contract tests can scan it as text.
- The desktop SDK is pinned informally to 2.2.7 (the release this was built
  against); when the SDK moves, the mirror in `src/plugin/v2-gui-module.d.ts`
  fails the GUI type-check at the moved call sites — the same loud failure the
  other host mirrors give.
- Deferred until constraint 3 lifts: persisted sidebar layout and the
  segment-settings dialog on the desktop (the TUI's `/cmd-rates-usage`
  remains the way to shape the sidebar).
