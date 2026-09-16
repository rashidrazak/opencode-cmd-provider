# ADR-0010: One package serves OpenCode v1 and v2

Status: accepted

OpenCode 2.0.3 replaced the plugin API: a v1 plugin _returns_ hooks from a
function, a v2 plugin _registers_ them through a context object, and v2's
migration guide states plainly that "V1 plugin implementations do not run in
V2". This package is one install for both hosts, so both halves ship from a
single default export:

```ts
export default { id: "commandcode", server, setup }
```

`server()` is the v1 hook map (unchanged since ADR-0001) and `setup(context)`
registers the same three capabilities as v2 transforms. The two halves are
independent implementations — v2 does not translate v1 hooks, and nothing is
shared but the Snapshot, the runtime provider factory, and the Deals slice.

## Why one default export is safe in both hosts

Both loaders were read at their release tags (`v1.18.30`, `v2.0.3`), and both
tolerate the other's key:

- **v1** (`packages/opencode/src/plugin/shared.ts` → `readV1Plugin`, called in
  `"detect"` mode from `plugin/index.ts`) inspects only `id`, `server`, and
  `tui`; a module carrying `id` and a function `server` is accepted and
  `setup` is never read. This is also why the legacy fallback
  (`getLegacyPlugins`, which walks _every_ export of a module whose default
  looks nothing like a plugin) is never reached — a default export without
  `id`/`server`/`tui` would make v1 treat `createCommandCode` as a legacy
  plugin and then throw on the default export itself.
- **v2** (`packages/core/src/plugin/module.ts` → `PluginModule.load`) decodes
  the default export against `Schema.Struct({ default: Schema.Union([
{ id, effect }, { id, setup } ]) })`. Effect Schema strips undeclared keys,
  so the union matches on `{ id, setup }` and `server` is discarded. This is
  asserted rather than assumed: `tests/plugin-v2.test.ts` runs that schema,
  verbatim from the v2.0.3 loader, against this package's entry and checks that
  what comes out is exactly `{ id, setup }`.

The migration guide documents this shape ("Support V1 and V2 from one
package"). It also notes the shape is only understood by v1 **1.18.29 and
newer**; older v1 releases keep working the way they always did (a bare
function default), which this package has not shipped since 1.7.x — the
object entrypoint is the v1 contract we already had.

## The v2 mapping

| v1                                            | v2                                                | Notes                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config` hook → `provider.commandcode.models` | `ctx.provider.transform` + `ctx.model.transform`                           | `provider.update` / `model.update` are upserts; a missing record is seeded from `Provider.Info.empty(id)` / `Model.Info.default(providerID, id)` (ADR-0008 membership unchanged) |
| `provider.commandcode.npm`                    | `provider.package = "aisdk:<Provider specifier>"` | the `aisdk:` prefix is v2's marker for "a plugin supplies the runtime SDK"                                                                                                       |
| `auth` hook (OAuth)                           | `ctx.integration.transform`                       | env method for `COMMANDCODE_API_KEY` + a key method                                                                                                                              |
| `tool` map                                    | `ctx.tool.transform`                              | `cmd_plan_summary` — same name, description, argument, rendering                                                                                                                 |
| runtime provider package                      | `ctx.aisdk.hook("sdk")`                           | hands over the same `createCommandCode` factory the package already exports                                                                                                      |

**The runtime half is not optional.** `packages/core/src/model-resolver.ts` at
v2.0.3 routes a model whose `package` starts with `aisdk:` to
`AISDK.Service.language`, and that path _requires_ a plugin to set `event.sdk` —
it never imports the named package. A provider entry without a matching SDK
hook fails model initialization with "No AISDK provider plugin returned an
SDK". `ctx.aisdk.hook("sdk", …, { providerID: "commandcode" })` is that seam.

### The TUI half: one `./tui` export, two contracts

The Deals sidebar is a _TUI_ plugin, loaded from `exports["./tui"]`
(`dist/tui.js`) by a different host process than the server halves above — and
that host has its own v1/v2 split. One default export carries both:

```ts
export default { id: "commandcode.deals", tui, setup }
```

- **v1** (`packages/opencode/src/cli/cmd/tui/…` at v1.18.30) reads the default
  export through its `tui`-kind reader: a `tui` function is required, and a
  module carrying both `server()` and `tui()` is rejected. The half registers
  snake_case slots with `api.slots.register({ order, slots })` —
  `sidebar_content` is the one this panel uses — and reads the selected model
  from `api.state.session` × `api.state.provider`, where the config hook's
  enrichment left `options.cmd`.
- **v2** (`@opencode/plugin@2.0.3`, `dist/tui/context.d.ts`) validates the
  default export as a TUI `Definition` — `id` a non-empty string and `setup` a
  function — and rejects anything else as "Invalid V2 TUI plugin module". Its
  API is a dot-separated slot tree claimed with
  `ctx.ui.slot({ append: "sidebar.content", render })`; its data lives in
  `ctx.data.session` / `ctx.data.location.model`; and the model's provider-option
  bag is `settings`, so the same enrichment payload v1 writes to `options.cmd`
  is read from `settings.cmd` (`enrichCommandCodeModelsV2`).

Shipping only the v1 half was the missing-v2-sidebar bug: v2 still loaded `dist/tui.js`
(its TUI host takes a registered package's `tui` entrypoint), rejected the
module, and the `Command Code` sidebar silently disappeared — no v1 symptom, no
server-side symptom, and no test noticing. Both contracts are now pinned by
`tests/contract.test.ts` (the built bundle) and `tests/tui-deals-panel.test.ts`
(registration and data path), and `src/plugin/v2-tui-types.ts` mirrors the v2
TUI context exactly as `src/plugin/v2-types.ts` mirrors the catalog,
integration, and tool context.

Both hosts rewrite the plugin's `@opentui/*` and `solid-js` imports to their own
module instances — v1 in its TUI plugin loader, v2 through
`@opentui/solid/runtime-plugin-support` — so the bundle keeps those imports bare
and the panel runs on the host's single reactive runtime. That is also why the
slice stays one bundled file (`scripts/build-tui.ts`): the rewrite covers the
entry's own imports.

### What carries over unchanged

- **Membership.** `catalogModelForV2` maps the same Snapshot row the v1 entry
  maps: Display name (prefix + `(free)` marker), context/output limits with the
  pending-context placeholder, modality table, and the row's own parsed rates.
- **Missing never zero-fills.** A row whose models.md price cell was blank
  advertises an empty v2 `cost` array, never a $0 tier.
- **Declared wins.** Provider-level keys are filled only while they still hold
  the editor's seed value (`name === id`, `package === ""`), so a user-declared
  `providers.commandcode` entry survives. Declared models keep their name and
  limits; only missing reasoning variants are added — the same gap-fill v1's
  `augmentConfigCommandCodeModels` performs.
- **First-run default.** v1 lands on `commandcode/gpt-5.6-terra` through
  OpenCode's hardcoded provider-priority list; v2 has no such list, so the
  transform sets that default explicitly — and only when no default exists yet.
- **Deals intelligence.** The v1 config hook's enrichment and the v1 tool are
  re-expressed as a catalog extension and a tool definition, both passed in from
  `src/plugin/index.ts`, so the slice stays excisable (ADR-0004).

### Deliberate differences

- **`/connect` does not open the browser under v2.** A v2 OAuth integration
  method must resolve to `Credential.OAuth` — a refresh/access pair the host
  will later refresh. Command Code issues an API key, so registering the studio
  flow there would store a credential v2 would try to refresh as an OAuth
  token. v2 users connect by setting `COMMANDCODE_API_KEY` or pasting the key
  into the key method; the browser flow stays v1-only until v2 grows a
  first-class key credential produced by an authorization flow.
- **The display prefix is read from `settings.display_prefix`.** v2 renamed the
  provider's free-form bag from `options` to `settings`; the prefix is still
  read-only and still defaults to `[CMD] `.
- **Reasoning without efforts is not expressible.** v1 advertised
  `reasoning: true` for a model that is reasoning-capable without explicit
  efforts; v2 has no such field, so those rows rely on Command Code's own
  default depth. Effort-bearing rows are unaffected — their variants carry
  `reasoningEffort` into the model's provider options.
- **The cost tier replaces `context_over_200k`.** v2's cost entries are
  context-tiered arrays, so the Deals slice's over-context rate becomes an
  entry with `tier: { type: "context", size: 200_000 }`.

## Evidence

- Both loaders read at tag: `v1.18.30` (`plugin/shared.ts`, `plugin/index.ts`)
  and `v2.0.3` (`plugin/module.ts`, `catalog.ts`, `integration.ts`,
  `aisdk.ts`, `model-resolver.ts`, `provider.ts`).
- The v2 loader's decode schema runs against this package's entry in
  `tests/plugin-v2.test.ts`; the dual shape is asserted against the built
  bundle in `tests/contract.test.ts`.
- **A real OpenCode v1.18.30 binary was run against the built package**
  (`npm run test:e2e` with `OPENCODE_BIN` pointing at an `opencode-ai@1.18.30`
  install): the host loaded the dual default export and auto-registered
  `commandcode/claude-sonnet-5` from an `opencode.json` that declares no
  provider and no models. The extra `setup` key is invisible to `readV1Plugin`
  in practice, not merely by reading its source. Both e2e scripts take
  `OPENCODE_BIN` and skip when the binary belongs to the other line, so the two
  hosts can be exercised on one machine.
- **A real OpenCode v2.0.3 host was run against the built package**
  (`tests/e2e-opencode-v2.mjs`, `npm run test:e2e:v2`). The host logged
  `loading plugin` for `.opencode/plugins/commandcode`, accepted the dual
  default export, called `setup(context)`, and reported back through its own
  API: the provider (`commandcode`, `aisdk:opencode-cmd-provider@<version>`,
  `activation: "auto"`, `integrationID: commandcode`), all 70 Snapshot models
  (each inheriting the provider package, with effort variants shaped
  `{ id, settings: { reasoningEffort } }` and cost entries carrying
  `cache: { read, write }`), and the integration with its `env` + `key`
  methods plus a live `COMMANDCODE_API_KEY` connection. The headless `run` leg
  stops before sending a request against a local base URL — the upstream hang
  this repo already documents for v1 (anomalyco/opencode #14956, #5674) — but
  it reaches the transport, which is what proves the `sdk` hook produced a
  usable model.
- Two v2 host behaviours matter when testing by hand: a configured local plugin
  path must be a **directory** (a file target is dropped with "configured
  plugin path must be a directory"), and plugin activation is asynchronous — so
  one-shot CLI reads such as `opencode models --standalone` can win the race
  and print nothing. The v2 API exposes `POST /api/plugin/await-activation` for
  exactly that; `opencode run` waits, which is why it is the e2e's vehicle.
- The v2 host contract is mirrored in `src/plugin/v2-types.ts` from
  `@opencode/plugin@2.0.3` and `@opencode/schema@2.0.3` (`Provider.Info.empty`,
  `Model.Info.default`, `Catalog.Editor`, `Integration.Editor`, `Tool.Info`).
  The mirror is deliberate: the host injects the context, so the package must
  not resolve `@opencode/plugin` at runtime — the same rule ADR-0001's
  `@opencode-ai/*` constraint exists for, now enforced for `@opencode/*` too.
- The v2 user migration guide is the source of truth for the config-shape
  mappings above (`plugin`→`plugins`, `npm`→`package` with the `aisdk:` prefix,
  `provider`→`providers`, `options`→`settings`/`headers`/`body`, `cache_read`→
  `cache.read`, a variants object→an array with `id`), and it classifies
  `whitelist`, `blacklist`, and model `reasoning` as V1 fields V2 accepts and
  ignores — which is why the v2 half does not try to carry them.
- Every `LanguageModelV3*` declaration in `@ai-sdk/provider@3.0.8` (the version
  opencode v2.0.3 and v1.18.30 use) is identical to `@ai-sdk/provider@4.0.7`
  (this package's pin), so the model the v2 SDK hook hands over implements the
  interface the host calls. The version is not added as a dependency: nothing
  in the runtime path imports a provider package.
- **The TUI half was read from the host binaries, then run against both lines**
  (the missing-v2-sidebar bug). The v2.0.3 binary's TUI loader validates a plugin's default
  export with `"id" in m && typeof m.id === "string" && "setup" in m &&
typeof m.setup === "function"`, and logs `plugin reconciliation completed
plugins=N` — with the v1-only bundle our package loaded
  (`…/dist/tui.js`, `role=cli`) and was then dropped, so `N` never counted it.
  After the fix a real v2.0.3 TUI (patched build in the plugin cache, session
  resumed with `--session`) rendered the panel's rows (`Tier:`, `Tok/s:`,
  `GOAT allowance:`) beside the real v1.18.30 TUI, which rendered the same rows
  through `sidebar_content` with no load errors.

## Consequences

- A published release serves both opencode lines; no second package, no
  `engines.opencode` gate (still deliberately absent).
- The v2 mirror is a snapshot of a moving API. It is not a dependency, so it
  cannot break a build when v2 changes — but it will not warn either. Bumping
  the supported v2 line means re-deriving `src/plugin/v2-types.ts` from the
  published `@opencode/plugin` and re-reading the mapping table above.
- **The TUI mirror carries the same risk with a sharper edge.** v2's TUI
  vocabulary (the `"sidebar.content"` path, the `ui.slot` claim shape, and the
  `settings` bag) is mirrored in `src/plugin/v2-tui-types.ts`; renaming any of
  it upstream would silently empty the sidebar again rather than fail a build,
  so the mirror and `tests/tui-deals-panel.test.ts` must be re-derived from
  `@opencode/plugin@<line>/dist/tui/context.d.ts` whenever the supported v2 line
  moves.
- `@opencode/plugin@2.0.3` pins `@opentui/core >= 0.5.10` while this package
  pins `^0.5.4`; that peer conflict is why the v2 context is mirrored rather
  than depended on. If the TUI dependencies are ever aligned, the mirror could
  be replaced by `import type` from the real package.
- The v1 half stays the compatibility floor: it is what 1.18.x users load, and
  removing it ends v1 support (see the migration guide's advice to use separate
  entrypoints if an older floor is ever claimed).
