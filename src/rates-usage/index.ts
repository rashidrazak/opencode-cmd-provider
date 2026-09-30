// src/rates-usage/index.ts — server-side public entry for Rates & usage (the
// Deals catalog + enrichment + cmd_plan_summary tool + the usage RPC bridge). The
// TUI panel is a separate host and is reached via tui.ts → src/rates-usage/tui.tsx,
// never from the server barrel, so the provider process does not load
// solid-js/@opentui. Deleting this folder plus the registration lines in
// src/plugin/index.ts leaves Core (Snapshot, Auto-registration, provider/*
// streaming) byte-identical.

// Catalog
export {
  MODEL_DEALS,
  PLAN_CATALOG,
  DEAL_SOURCE_URL,
  DEAL_LAST_REFRESHED,
  DEAL_PACKAGE_VERSION,
} from "./catalog.js"
export type { ModelDeals, PlanInfo, DealRates } from "./catalog.js"

// Plan identity is Core (it is the provider transport's pin vocabulary too),
// re-exported here so Rates & usage consumers keep one entry point.
export { normalizePlan } from "../catalog/plans.js"
export type { PlanId } from "../catalog/plans.js"

// Vendor (used by enrichment, but exported for tests that import vendor directly
// from the deals deep module — keep as part of the slice so tests don't reach
// into src/plugin)
export { vendorFamilyForModel } from "./vendor.js"

// Enrichment (family + cmd options + context_over_200k cost) — v1 config hook
// and v2 provider transform share one Deals catalog
export {
  enrichCommandCodeModels,
  enrichCommandCodeModelsV2,
  buildCmdOptions,
} from "./enrichment.js"

// Tool (v1 `tool()` helper and v2 JSON-Schema definition from one rendering)
export {
  planSummaryTool,
  planSummaryV2Tool,
  renderPlanSummary,
  resolvePlan,
} from "./plan-summary.js"
export type { PlanProvenance, PlanResolution, PlanSource } from "./plan-summary.js"

// Usage bridge (v2 plugin-RPC port the server half registers for the TUI half,
// ADR-0020) — server-side registration only; the TUI loader is loaded through
// tui.ts → src/rates-usage/usage-rpc.ts.
export { registerUsageRpc } from "./usage-rpc.js"
export type { UsageRpcInput, UsageRpcOutcome } from "./usage-rpc.js"
