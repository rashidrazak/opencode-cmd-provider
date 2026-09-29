// src/deals/tui-usage.ts — the sidebar panel's usage wiring (issue #244): the
// mount chain that turns the TUI host's live state into the `Usage` segment —
// resolve the credential (ADR-0020, #243), fetch one snapshot (#242), keep the
// last successful snapshot when a later fetch fails — and nothing else. No
// polling: `mount()` runs the chain exactly once per panel mount; `refresh()`
// is the seam the follow-up refresh policy (#245) drives, and carries no
// throttle/backoff logic of its own.
//
// Host-agnostic by design: no TUI runtime (solid-js), no runtime
// `@opencode-ai/*` import. The caller supplies an *input thunk*, read at each
// load, so a `/connect` or a provider re-registration between calls is
// observed (ADR-0020 rule 3) — the resolver is never handed a cached record.
//
// Degradations match the renderer's vocabulary: nothing resolving is the
// notice and makes zero requests (ADR-0011); a throwing/failing chain is
// `unavailable`; an `unavailable` after a successful load keeps the snapshot
// on screen, while a chain that resolves nothing again publishes the notice
// (there is no fresh-or-stale choice without a credential).
import {
  fetchUsageSnapshot,
  type FetchUsageOptions,
  type UsageCredentialSource,
  type UsageResult,
} from "./usage.js"
import {
  resolveTuiCredential,
  type TuiCredential,
  type TuiCredentialInput,
  type TuiCredentialOptions,
} from "./tui-credential.js"

/** The credential-resolver seam; defaults to the TUI host's own resolver. */
export type TuiCredentialResolver = (
  input: TuiCredentialInput,
  options: TuiCredentialOptions,
) => Promise<TuiCredential | undefined>

/** The snapshot-fetch seam; defaults to the four-leg billing fetch. */
export type UsageSnapshotFetcher = (options: FetchUsageOptions) => Promise<UsageResult>

/**
 * What the panel renders for the usage segment: the latest load's result and,
 * when a credential resolved, the rung it read with — the muted `via …` line's
 * data (display only, never the key; ADR-0020 rule 2).
 */
export interface UsagePanelState {
  result: UsageResult
  provenance?: UsageCredentialSource
}

export interface UsagePanelOptions {
  /** Called whenever a load changes what the panel shows (a kept snapshot publishes nothing). */
  onChange?: (state: UsagePanelState) => void
  /** Credential-resolver inputs (env, auth-path and home overrides). */
  credential?: TuiCredentialOptions
  /** Fetch inputs (baseURL, fetch, env, catalog); the key comes from the resolver. */
  fetchOptions?: Omit<FetchUsageOptions, "apiKey">
  /** Credential-resolver seam for tests; defaults to `resolveTuiCredential`. */
  resolveCredential?: TuiCredentialResolver
  /** Snapshot-fetch seam for tests; defaults to `fetchUsageSnapshot`. */
  fetchSnapshot?: UsageSnapshotFetcher
}

export interface UsagePanel {
  /** The latest state, or undefined before the first load settles. */
  state(): UsagePanelState | undefined
  /** Runs the mount chain exactly once per panel; later calls are no-ops. */
  mount(): Promise<void>
  /** Runs the chain again and publishes the outcome (#245's refresh seam). */
  refresh(): Promise<void>
}

/**
 * One panel's usage controller. `input` is called on every load — never
 * captured once — so the resolver reads the host state at the moment the
 * panel asks (ADR-0020 rule 3).
 */
export function createUsagePanel(
  input: () => TuiCredentialInput,
  options: UsagePanelOptions = {},
): UsagePanel {
  const resolveCredential = options.resolveCredential ?? resolveTuiCredential
  const fetchSnapshot = options.fetchSnapshot ?? fetchUsageSnapshot
  let state: UsagePanelState | undefined
  let mounted = false

  const publish = (next: UsagePanelState): void => {
    state = next
    options.onChange?.(next)
  }

  const load = async (): Promise<void> => {
    let next: UsagePanelState
    try {
      const credential = await resolveCredential(input(), options.credential ?? {})
      if (credential === undefined) {
        next = { result: { state: "no-credential" } }
      } else {
        const result = await fetchSnapshot({ ...options.fetchOptions, apiKey: credential.key })
        next = { result, provenance: credential.source }
      }
    } catch {
      // A throwing resolver or fetch is the unavailable state, never an
      // exception escaping the panel's mount (ADR-0020 rule 1).
      next = { result: { state: "unavailable" } }
    }
    // A failed load after a good one keeps the last snapshot on screen: stale
    // numbers beat a blank segment until #245's backoff finds a fresh one.
    if (next.result.state === "unavailable" && state?.result.state === "usage") return
    publish(next)
  }

  return {
    state: () => state,
    async mount() {
      if (mounted) return
      mounted = true
      await load()
    },
    refresh: load,
  }
}
