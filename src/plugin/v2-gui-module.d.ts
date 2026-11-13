// src/plugin/v2-gui-module.d.ts — the OpenCode v2 desktop GUI SDK, mirrored
// structurally (ADR-0010's mirror rule, now for the third host): the shapes of
// `@opencode/plugin/gui` the Rates & usage GUI half (src/rates-usage/gui/)
// consumes, as shipped by the desktop app this release targets (2.2.7).
//
// The package is deliberately NOT a dependency of this repo:
// tests/dependency-pins.test.ts fails the tree when an installed package states
// a `solid-js` requirement the gate cannot model (`@opencode/plugin` 2.2.7
// peer-requires `>=1.9.0`, an unmodelled shape), and a runtime import would be
// wrong anyway — the desktop host *injects* this module into every window
// bundle it evaluates (`evaluatePluginBundle` provides `@opencode/plugin/gui`,
// `solid-js`/`web`/`store`, `effect`, `@opencode/client` and nothing else), so
// the built `./gui-experimental` bundle must keep it external.
//
// Mirrored, with names and doc comments trimmed to what we use:
//   - `Plugin.define` (the `./gui-experimental` default export)
//   - registries `Panel`, `Command`, `MenuItem`, `Style` and their items
//   - the `Context` slice setup receives (`id`, `client`, `add`, `layout`,
//     `sessions`, `ui`)
//   - `createKeyed` (reactive side effects with per-key owners)
//   - the session/server/data shapes the panel reads (`MountedSession`,
//     `ServerRef`, `Data` — the `@opencode/client/solid` store's slices the
//     panel touches, including the `settings`/`cost` model fields the v2 TUI
//     reads for the same enrichment payload)
// Anything the mirror omits stays omitted on purpose: widening it is how the
// mirror drifts from the SDK without anyone noticing. When the desktop SDK
// moves, this file fails to compile against the moved call sites — the same
// loud failure the other mirrors give.
declare module "@opencode/plugin/gui" {
  import type { Accessor, JSX } from "solid-js"

  /** Undoes a registration, or tears something down. */
  export type Cleanup = () => void | Promise<void>

  /** A token kind: a typed list that accepts contributions. */
  export interface Registry<T> {
    readonly kind: "registry"
    readonly id: string
  }

  /**
   * The `OpenCodeClient` slice the usage bridge (ADR-0020) drives: the plugin
   * RPC subclient, with the one method (`usage`) and the one event channel
   * (`progress`) `USAGE_RPC_DEFINITION` declares. Mirrored structurally so
   * `createUsageRpcLoader` accepts the context client as-is.
   */
  export interface OpenCodeClient {
    rpc(definition: unknown): {
      usage(input: unknown, callOptions?: { readonly signal?: AbortSignal }): Promise<unknown>
      events: {
        on(
          name: string,
          handler: (event: unknown) => void,
          options?: { readonly signal?: AbortSignal },
        ): () => void
      }
    }
  }

  /** One context-tier entry of a desktop model record's cost array. */
  export interface ModelCost {
    readonly tier?: unknown
    readonly input?: unknown
    readonly output?: unknown
    readonly cache?: { readonly read?: unknown; readonly write?: unknown }
  }

  /** One desktop model record: `panel-rows.ts`'s `V2ModelCandidate` source. */
  export interface ModelInfo {
    readonly id: string
    readonly providerID: string
    readonly settings?: Readonly<Record<string, unknown>>
    readonly cost?: readonly ModelCost[]
  }

  /** One desktop session record: the panel reads its selected model. */
  export interface SessionInfo {
    readonly id: string
    readonly model?: { readonly id: string; readonly providerID: string }
  }

  /**
   * A server's synced client-local data (the `@opencode/client/solid` store's
   * slices the panel touches): session records, the model catalog, and the
   * event subscription the completed-turn signal rides (ADR-0020 rule 3).
   * Reactive.
   */
  export interface Data {
    readonly session: { get(sessionID: string): SessionInfo | undefined }
    readonly location: { readonly model: { list(): readonly ModelInfo[] | undefined } }
    on(type: string, handler: (event: { data: { sessionID: string } }) => void): () => void
  }

  /**
   * A server the app lists. One ref per id that follows the live connection:
   * read `client` and `data` from it each time, as a restarted server gets a
   * new controller under the same id.
   */
  export interface ServerRef {
    readonly id: string
    readonly name: string
    readonly client: OpenCodeClient
    readonly data: Data
  }

  /** A session owned by an open shell tab. */
  export interface SessionRef {
    /** `${server id}\n${session id}`: unique across servers. */
    readonly key: string
    readonly id: string
    readonly tab: string
    readonly server: ServerRef
    readonly pending: boolean
  }

  /** A routed session on the session screen, as a panel render receives it. */
  export interface MountedSession extends SessionRef {
    /** This routing visit: a new object each time the session is routed. */
    readonly visit: object
    readonly directory: string
  }

  /** One tab a side `Panel` lists in the session's strip. */
  export interface PanelTab {
    /** Host key is `${plugin}:${id}`. */
    readonly id: string
    /** Accessible name, and the trigger content when `label` is absent. */
    readonly title: string
    /** Listed without being opened, before every other tab, never closed. */
    readonly pinned?: boolean
  }

  /** What `Panel.render` receives. Fields are reactive getters. */
  export interface PanelProps {
    readonly tab: PanelTab
    readonly session: MountedSession
    /** The session screen that owns this panel's files and composer. */
    readonly screen: object
  }

  /** A panel: the tabs a plugin shows in a session's side region. */
  export interface Panel {
    /** The panel's id, unique within the plugin. */
    readonly id: string
    readonly region: "side"
    /**
     * Gives the panel a side region width of its own; `"narrow"` is the
     * narrowest the region goes. Omitted, the panel shares the conversation's
     * width.
     */
    readonly width?: number | "narrow"
    /**
     * Reactive, and runs again when another session is routed or what it reads
     * changes. List this panel's stored tab ids that still apply, plus any
     * pinned tab. Return the same tab object while it is unchanged.
     */
    list(input: {
      readonly session: MountedSession
      readonly screen: object
      readonly open: readonly string[]
    }): readonly PanelTab[]
    /** Renders a tab's content once; its own reactivity updates it. */
    render(props: PanelProps): JSX.Element
  }

  /** A command in the palette. The host publishes it as `${plugin}.${id}`. */
  export interface Command {
    readonly id: string
    readonly title: string
    readonly description?: string
    /** Extra words the palette matches, separated by spaces. */
    readonly keywords?: string
    readonly group?: string
    readonly section?: "general" | "session" | "navigation" | "model" | "terminal" | "prompt"
    readonly bind?: string
    /**
     * Also offers the command as a composer slash command. The GUI half never
     * sets this: slash semantics in the desktop composer are ambiguous.
     */
    readonly slash?: { readonly name: string; readonly arguments?: true }
    readonly hidden?: true
    /** False takes the command out of the palette and turns its keybind off. */
    readonly enabled?: boolean
    /** Runs the command. Return `false` to decline the key. */
    run(input?: string): void | false | Promise<void>
  }

  /** An item of the + menu before the side panel tabs (`menu: "session.panel"`). */
  export interface MenuItem {
    /** The item's id, unique within the plugin. */
    readonly id: string
    readonly title: string
    /** Items list in ascending order. Defaults to 0. */
    readonly order?: number
    readonly menu: "session.panel"
    /** The item's icon (an `IconName`; widened to `string` in this mirror). */
    readonly icon?: string
    /** Published command id whose shortcut the item shows. */
    readonly keybind?: string
    /** A short muted detail after the title where the item lists as a launcher. */
    readonly description?: string
    /** Makes + run this item directly instead of showing launcher choices. */
    readonly primary?: true
    run(): void
  }

  /** The app's own components slice the panel uses (an `IconName` is widened). */
  export interface Ui {
    Icon(props: {
      readonly name: string
      readonly size?: "small" | "normal" | "large"
      readonly class?: string
    }): JSX.Element
    IconButton(props: {
      readonly icon: string
      /** The button's accessible name. Pass translated copy; it is not shown. */
      readonly label: string
      readonly onClick?: (event: MouseEvent) => void
      readonly variant?: "neutral" | "ghost" | "ghost-muted"
      readonly size?: "small" | "normal" | "large"
      readonly busy?: boolean
      readonly class?: string
    }): JSX.Element
    Tooltip(props: {
      readonly value: JSX.Element
      readonly keys?: readonly string[]
      readonly placement?: "top" | "bottom" | "left" | "right"
      readonly children: JSX.Element
    }): JSX.Element
  }

  /** The window context `Plugin.define`'s setup receives (the slice we use). */
  export interface Context {
    /** The plugin's id — the server half's (`commandcode`). */
    readonly id: string
    /** The client of the server that runs the plugin (the app's own server). */
    readonly client: OpenCodeClient
    /** Aborts when the plugin is disabled, reloaded or its window closes. */
    readonly signal: AbortSignal
    /** Contributes a fixed item to a registry. */
    add<T>(registry: Registry<T>, item: T): Cleanup
    /** Contributes an item that follows reactive state. */
    add<T>(registry: Registry<T>, item: () => T | undefined): Cleanup
    /** The session layout: side panel tabs. Panel keys are `${plugin}:${id}`. */
    readonly layout: {
      open(
        key: string,
        session: SessionRef,
        options?: {
          readonly tab?: "open" | "preview" | "append" | "select"
          readonly background?: boolean
        },
      ): void
      state(key: string, session: SessionRef): "closed" | "open" | "active" | "visible"
    }
    /** The sessions of open shell tabs, and the mounted one. */
    readonly sessions: {
      list(): readonly SessionRef[]
      current(): MountedSession | undefined
    }
    /** The app's own components, so a plugin's UI matches the host's. */
    readonly ui: Ui
  }

  /**
   * Defines a plugin's GUI — the default export of its `./gui-experimental`
   * bundle. Declares no id: the host assigns the server plugin's (`ctx.id`).
   * Returns the same object.
   */
  export declare const Plugin: {
    define<const D extends { readonly setup?: (ctx: Context) => Cleanup | void }>(plugin: D): D
  }

  /** The registry of panels: tabs in the session's side region. */
  export declare const Panel: Registry<Panel>
  /** The registry of palette commands. */
  export declare const Command: Registry<Command>
  /** The registry of host menu items. */
  export declare const MenuItem: Registry<MenuItem>
  /** The registry of CSS the host adds to the document while contributed. */
  export declare const Style: Registry<string>

  /**
   * Runs `fn` once per key of `source` (like `<Show keyed>`), each run with its
   * own owner: its `onCleanup` and registrations end with it. The way plugin
   * code syncs with something outside Solid — here, the server data store's
   * event subscription, re-subscribed per data generation (a restarted server
   * swaps the object).
   */
  export declare function createKeyed<T>(
    source: Accessor<T>,
    fn: (value: T) => void,
    options?: { readonly equals?: (previous: T, next: T) => boolean },
  ): void
}
