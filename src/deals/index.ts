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
export type { ModelDeals, PlanId, PlanInfo, DealRates } from "./catalog.js"

// Vendor (used by enrichment, but exported for tests that import vendor directly
// from the deals deep module — keep as part of the slice so tests don't reach
// into src/plugin)
export { vendorFamilyForModel } from "./vendor.js"

// Enrichment (family + options.cmd + context_over_200k cost)
export { enrichCommandCodeModels, buildCmdOptions } from "./enrichment.js"

// Tool
export { planSummaryTool, renderPlanSummary, resolvePlan, normalizePlan } from "./plan-summary.js"
