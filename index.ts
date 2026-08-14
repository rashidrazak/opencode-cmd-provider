// index.ts
// Dual export: opencode's provider loader scans for the first export whose name
// starts with "create"; its plugin loader early-returns on a V1 default module.
// Exactly one create* export + a { id, server } default keeps both loaders safe
// (see DESIGN.md §4). Enforced by tests/contract.test.ts.
export { createCommandCode } from "./src/provider/index.js"
export { default } from "./src/plugin/index.js"
