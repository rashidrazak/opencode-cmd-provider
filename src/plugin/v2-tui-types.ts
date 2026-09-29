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
// `@opencode/theme@2.0.3` (`dist/tui/types.d.ts`), except the theme slice,
// which spans the `@opencode/theme@2.0.8` `text.default`/`text.subdued` →
// `text.base`/`text.muted` rename (see V2TuiThemeText) because the supported
// v2.0.x line includes both spellings, and the provider/integration slices the
// usage credential resolver reads (`@opencode/client@2.0.3`'s `ProviderInfo`,
// `IntegrationInfo` and `ConnectionInfo`; re-checked against `2.0.18`, where
// the credential connection gained an unused `method` field — the members
// declared here are common to the whole line). Bumping the supported v2 line
// means re-deriving these from the published packages — tests/tui-deals-panel
// and tests/tui-credential pin the parts we depend on.
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

/**
 * `ResolvedTheme` text colours used for the panel. v2 renamed the v1
 * `text`/`textMuted` pair to `text.default`/`text.subdued`; then
 * `@opencode/theme@2.0.8` renamed those to `text.base`/`text.muted`. Every
 * v2.0.x host this package serves exposes one spelling or the other, so both
 * are mirrored and the panel reads whichever is present. A panel that reads
 * only the absent pair gets `undefined` colours, which the renderer paints as
 * its default foreground — the plain white sidebar on v2.0.8+.
 */
export type V2TuiThemeText =
  | {
      readonly base: RGBA
      readonly muted: RGBA
    }
  | {
      readonly default: RGBA
      readonly subdued: RGBA
    }

export interface V2TuiTheme {
  readonly text: V2TuiThemeText
}

/** `SessionInfo` slice: the session's selected model (`ModelRef`). */
export interface V2TuiSession {
  readonly id: string
  readonly model?: { readonly id: string; readonly providerID: string } | undefined
}

/**
 * One `ModelInfo.cost` entry: `{ tier?, input, output, cache: { read, write } }`.
 * v2's cost shape is an array of context tiers — the untiered entry is the
 * model's base price, which the Deals panel reads for its `Rates` fallback
 * when the payload publishes no band.
 */
export interface V2TuiModelCost {
  readonly tier?: { readonly type: "context"; readonly size: number } | undefined
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number; readonly write: number }
}

/**
 * `ModelInfo` slice. v2 renamed the model's free-form provider-option bag from
 * v1's `options` to `settings` (ADR-0010), which is where the Deals
 * enrichment writes `cmd`; `cost` is the host's own price table.
 */
export interface V2TuiModel {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  readonly settings?: Readonly<Record<string, unknown>> | undefined
  readonly cost?: readonly V2TuiModelCost[] | undefined
}

/**
 * `Connection.Info`'s env arm: a named environment variable the Host reads.
 * This is the only branch of the Host's connection resolution the v2 TUI can
 * resolve — the value lives in the environment both processes share.
 */
export interface V2TuiIntegrationEnvConnection {
  readonly type: "env"
  readonly name: string
}

/** `Connection.Info`'s credential arm: a value in the Host's credential store. */
export interface V2TuiIntegrationCredentialConnection {
  readonly type: "credential"
  readonly id: string
  readonly label: string
}

/**
 * `Connection.Info` — where the Host's active credential lives. The Host
 * projects `connections` in its own resolution order (stored credentials
 * first, then the env methods whose variable is set), and
 * `connection.active()` is `[0]`.
 */
export type V2TuiIntegrationConnection =
  V2TuiIntegrationEnvConnection | V2TuiIntegrationCredentialConnection

/**
 * `Integration.Info` slice: the record `connection.active()` resolves for a
 * provider's `integrationID`. `connections` is that resolution's candidate
 * list, already in Host order.
 */
export interface V2TuiIntegration {
  readonly id: string
  readonly name: string
  readonly connections: readonly V2TuiIntegrationConnection[]
}

/**
 * `Provider.Info` slice: the record that ties a provider to the integration
 * whose connection unlocks it (our registration writes `commandcode`).
 */
export interface V2TuiProvider {
  readonly id: string
  readonly integrationID?: string | undefined
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
      /** The records `connection.active()` resolves the credential through. */
      readonly provider: {
        list(): readonly V2TuiProvider[] | undefined
      }
      readonly integration: {
        list(): readonly V2TuiIntegration[] | undefined
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
