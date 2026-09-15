// src/plugin/v2-tui-types.ts — the OpenCode v2 *TUI* plugin-context slice this
// package consumes, mirrored structurally (ADR-0010).
//
// OpenCode v2 replaced the v1 TUI plugin contract (`{ id, tui(api) }` with
// snake_case slots like `sidebar_content`) with `{ id, setup(context) }` and a
// dot-separated slot tree (`"sidebar.content"`). The host validates the shape
// before activating a plugin — a module without a `setup` function is rejected
// as an "Invalid V2 TUI plugin module", which is exactly how the Deals sidebar
// stopped appearing on v2.
//
// As with `v2-types.ts` we do not depend on `@opencode/plugin`: the host
// injects the context, so nothing resolves that module at runtime. Only the
// members this package touches are declared; the shapes are hand-mirrored from
// `@opencode/plugin@2.0.3` (`dist/tui/context.d.ts`) and
// `@opencode/theme@2.0.3` (`dist/tui/types.d.ts`). Bumping the supported v2 line
// means re-deriving these from the published packages — tests/tui-deals-panel
// pins the parts we depend on.
import type { RGBA } from "@opentui/core"

/**
 * Slot paths the v2 host publishes (`SlotMap`). Absolute and dot-separated, and
 * a path contains every path it prefixes. Declared in full so a claim can be
 * checked against the host's vocabulary at compile time.
 */
export type V2TuiSlotPath =
  | "app"
  | "home.footer"
  | "prompt.footer"
  | "prompt.footer.status"
  | "prompt.footer.file"
  | "session.composer.top"
  | "session.panel"
  | "sidebar.content"
  | "sidebar.footer"

/** Input published by `sidebar.content` — the slot the Deals panel claims. */
export interface V2TuiSidebarInput {
  readonly sessionID: string
}

/**
 * One contribution to the slot tree. Exactly one placement key names an
 * absolute target path; `append` places the claim last inside that boundary.
 * The `?: never` fields keep the variants mutually exclusive — the host rejects
 * a claim carrying two placement keys ("Slot claim requires exactly one
 * placement key"), so the mirror makes that unrepresentable.
 */
export type V2TuiSlotClaim = {
  readonly render: (input: V2TuiSidebarInput) => unknown
} & {
  readonly append: V2TuiSlotPath
  readonly prepend?: never
  readonly before?: never
  readonly after?: never
  readonly replace?: never
}

/** `ResolvedTheme` slice used for the panel's colours (v2 renamed the v1
 * `text`/`textMuted` pair to `text.default`/`text.subdued`). */
export interface V2TuiTheme {
  readonly text: {
    readonly default: RGBA
    readonly subdued: RGBA
  }
}

/** `SessionInfo` slice: the session's selected model (`ModelRef`). */
export interface V2TuiSession {
  readonly id: string
  readonly model?: { readonly id: string; readonly providerID: string } | undefined
}

/**
 * `ModelInfo` slice. v2 renamed the model's free-form provider-option bag from
 * v1's `options` to `settings` (ADR-0010), which is where the Deals
 * enrichment writes `cmd`.
 */
export interface V2TuiModel {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  readonly settings?: Readonly<Record<string, unknown>> | undefined
}

/**
 * The v2 TUI context. `ui.slot` claims a place in the slot tree and returns the
 * release function; `data` is the host's live client-local store — reads are
 * reactive, so the claim's `render` is re-invoked when the selected model
 * changes.
 */
export interface V2TuiContext {
  readonly theme: V2TuiTheme
  readonly ui: {
    readonly slot: (claim: V2TuiSlotClaim) => () => void
  }
  readonly data: {
    readonly session: {
      get(sessionID: string): V2TuiSession | undefined
    }
    readonly location: {
      readonly model: {
        list(): readonly V2TuiModel[] | undefined
      }
    }
  }
}

/**
 * The shape the v2 host accepts as a TUI plugin: `Definition` from
 * `@opencode/plugin/tui`. Checked at load with `id` a non-empty string and
 * `setup` a function, and the setup's return value is registered as a cleanup.
 */
export interface V2TuiPluginDefinition {
  readonly id: string
  readonly setup: (context: V2TuiContext) => void | (() => void | Promise<void>)
}
