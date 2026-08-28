# ADR-0004: Deals intelligence as an excisable slice with visible degradation

Status: accepted

Deals intelligence (catalog `src/deals/catalog.ts` + enrichment `src/deals/enrichment.ts` + TUI `src/deals/tui.tsx` + tool `src/deals/plan-summary.ts`) is a single slice that can be deleted without breaking core (`provider.commandcode` auto-registration, `[CMD]` models, `COMMANDCODE_API_KEY` auth, `provider/*` streaming). Core is `snapshot → models → provider`; deals is additive only. Enrichment guards (`if (!entry) …`, `if (options.cmd) keep`) keep core byte-identical when deals is empty. Build `npm run refresh` and `Release` never fail if the `refresh:deals` upstream fetch fails — 5xx/network falls back to the committed RSC fixtures, and the release-time deals check is non-blocking (a failure emits a warning, not a release block; see ADR-0003).

Failure is visible: enrichment injects `model.options.cmd.unavailable=true` when `MODEL_DEALS` is empty, TUI renders banner `Deals unavailable — https://commandcode.ai/docs/resources/pricing-limits` plus placeholder rows (`Tier: —`), and `cmd_plan_summary` renders `No deal data is bundled…`. Sidebar previously hid silently (`<Show when={rows.length>0}>`).

Delivery is zero-step: `package.json` exports `".": "./dist/index.js"` and `"./tui": "./dist/tui.js"`; `opencode plugin opencode-cmd-provider` detects `server + tui targets` and writes both `opencode.json(c)` and `tui.json` from one spec. Hand-editing `opencode.json` alone is not supported — installer is the path. A single-file proxy (`default:{server,tui}`) is rejected by 1.18.19 (`tui?:never` / `server?:never` validated at import), so two files remain but one install gives both.

## Considered Options

- **Data-only cut** — ship empty `deals.ts`, keep enrichment/TUI code. Rejected: leaves dead code that can break on upstream shape changes, not a true excision.
- **Separate package** — `opencode-cmd-provider-deals`. Rejected: violates zero-step, two releases and version skew for three files.
- **Single-file proxy with argv sniffing** — one `dist/index.js` branching on `process.argv`. Proved via `probe-proxy-single.js` to work when listed in both configs, but fragile and still requires two config entries; installer already gives one-command both-files.

## Consequences

- `src/deals/` is the deep module boundary; deleting it plus two lines in `src/plugin/index.ts` (enrichment + tool registration) leaves core green.
- **Plan resolution is a shared seam, not excisable.** `normalizePlan()`/`resolvePlan()`/`PLAN_ALIASES` in `plan-summary.ts` are reused by core transport selection (`src/provider/command-code-model.ts`, per the #51 provider-API spec and tickets #53/#54) — only a resolved `go` selects the legacy transport. An excision of `src/deals/` must retain the plan-resolution functions (or rewire transport selection) or core stops building.
- `tui.json` is not hand-written by users; docs and README point to `opencode plugin`.
- Published 1.1.1 omitted `./tui` export, so `opencode plugin` only wrote server target — next release must include it.
