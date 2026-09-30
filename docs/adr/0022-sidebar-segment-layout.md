# ADR-0022: The sidebar segment layout is user state, persisted by each TUI host

Status: accepted

Issue #253. The Rates & usage panel always rendered its five segments —
Tier/Status, Allowance, Rates, Other Information and the live Usage block —
in one fixed order. Readers who find parts of it noisy had no trim. This
record fixes the control surface, the persistence seam and the composition
rules.

## Decisions

**1. Interactive, not configuration.** The **Show, hide and reorder sidebar
content** command — `/cmd-rates-usage` in the prompt, so a terminal multiplexer
capturing the palette shortcut cannot hide it — opens a dialog: up/down moves
the cursor, space/enter toggles the selected segment, shift+up/down moves it,
`r` restores the default layout, escape closes. The title carries the whole
wording and the command carries no description on purpose: the palette renders
a description inline after the title, where a second line of copy only
truncates. Changes apply live. Rejected: plugin options in `tui.json` (v1) and
in the v2 `plugins` entry — one user preference would split across two
host-specific config shapes, only apply after a restart, and sit in files the
installers patch.

**2. Persistence is each host's own durable store.** v1 writes the layout to
`api.kv` (`state/kv.json`, a reactive Solid store read through `kv.get`) under
the namespaced key `commandcode.rates-usage.segments` — the v1 KV store is shared by
every plugin, so the key carries plugin and panel. v2 uses
`ctx.storage.store(...)`, which the host persists to disk, live-syncs across
running TUI instances, and namespaces with the plugin id itself. Both store the
same JSON shape.

**3. The persisted shape is `{ order, hidden }`, normalized on every read.**
`order` always carries all five ids — hidden ones too, so unhiding restores
the user's position — and `hidden` names the ones not rendered. Normalization
(`src/rates-usage/segments.ts`) drops unknown and duplicate ids and appends ids the
store lacks, so a release that adds a segment cannot have it vanish by
accident, and a store written by another release cannot crash the panel. No
migration is needed in either direction.

**4. The composer owns the separators.** `panelRows` joins the visible
segments with exactly one blank row between blocks, trims the edge blanks a
segment ships itself (the usage renderer carries a leading one), skips
segments that render no rows (Usage before its first load), and emits no
leading or trailing blank. With every segment hidden the panel hides entirely
— header included — because an empty section is exactly the noise this
enhancement removes; the palette command is the way back.

**5. The banner is pinned, and only while a catalog segment shows.** The
`Deals unavailable` banner is not a segment: it renders above whichever
segment comes first, but only while at least one of Tier/Status, Allowance,
Rates or Other Information is visible. A Usage-only panel carries no catalog
warning, and an all-hidden panel carries nothing.

**6. One dialog component, host-specific mounts, pinned shapes.**
`SegmentsDialog` is shared; only its mounting and persistence differ
(`api.ui.dialog.replace` + `api.kv` on v1, `ctx.ui.dialog.show` +
`ctx.storage` on v2). Its key map is the pure `segmentKeyIntent`, so key
handling is testable without a renderer. Commands register through
`api.keymap.registerLayer` on v1 — the legacy `api.command` shim only forwards
to it and logs a deprecation warning — and `ctx.keymap.layer` on v2. On v1
the dialog's keys also ride the keymap: the prompt's managed textarea layer
owns the focused prompt's arrows at default priority, so the dialog registers
a `priority: 1` layer for its lifetime (`bindV1DialogKeys`) — the same way
the host's own `DialogSelect` wins them through its focused filter input. The
v2 layer is created by a headless component mounted through the `app` slot,
not by `setup`: `keymap.layer` reads a Solid context owned by the calling
component, so calling it from `setup` throws `Keymap.Provider is missing` and
fails the whole plugin, sidebar included; the `app` slot is mounted on every
route under that provider. The layer is `mode: "global"` on purpose — layers
default to `base`, and the command palette lists only _reachable_ commands
while its own modal dialog is open, where a base-mode layer is unreachable and
the entry silently disappears. Both constraints were measured on opencode
2.0.20. The v1 keymap slice is mirrored structurally in `src/rates-usage/tui.tsx`
because `@opentui/keymap` is a host-provided package this repository does not
install; the v2 slices (`keymap`, `storage`, `ui.dialog`) extend
`src/plugin/v2-tui-types.ts`, re-checked against `@opencode/plugin` 2.0.3
through 2.0.20.

## Verification

- `tests/tui-rates-usage-segments.test.ts` pins the normalizer (foreign/partial
  values, appended ids, filtered hidden set), toggle/move semantics (hidden
  segments reorder; boundaries no-op), the key intents, the composer
  (default byte-identity with `ratesUsageRows`, one separator, edge-blank trim,
  all-hidden, banner rules), both persistence adapters, and both hosts'
  command registration and dialog opening — including the v1 dialog key layer
  (priority, binding→command resolution, intent delivery) and the two v2
  wiring constraints.
- `tests/tui-rates-usage-panel.test.ts` keeps pinning the row content per segment,
  the default composition and the usage append after the refactor.

## Consequences

- The Rates & usage slice stays excisable: the layout vocabulary and normalization
  live in `src/rates-usage/segments.ts`, the hosts' stores are read in
  `src/rates-usage/tui.tsx`, and Core imports none of it (ADR-0004).
- A v1 host without a keymap still renders the panel; only the dialog entry
  degrades away. The v2 storage slice is present across the supported line
  (2.0.3+), so v2 always has the layout store.
- The dialog is palette-only — no default keybind — so it can never shadow a
  user's bindings.
- The layout is per machine, not per project: both stores are host-global by
  construction. A per-project layout would need a new seam and is deliberately
  out of scope.
