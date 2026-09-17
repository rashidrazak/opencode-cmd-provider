// src/deals/index.ts — server-side public entry for Deals intelligence
// (catalog + enrichment + cmd_plan_summary tool). The TUI panel is a separate
// host and is reached via tui.ts → src/deals/tui.tsx, never from the server
// barrel, so the provider process does not load solid-js/@opentui. Deleting
// this folder plus the two registration lines in src/plugin/index.ts leaves
// Core (Snapshot, Auto-registration, provider/* streaming) byte-identical.

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
// re-exported here so Deals consumers keep one entry point.
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
