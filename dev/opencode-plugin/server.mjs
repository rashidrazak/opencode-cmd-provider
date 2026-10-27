// dev/opencode-plugin/server.mjs
//
// Local-filesystem plugin entry for exercising the working tree with a real
// OpenCode v2 host instead of the npm-installed package.
//
// The v2 loader requires a *directory* as a configured plugin path and resolves
// `server`/`index`, `tui`, and `rpc` from it (loader helper `Zg` in the v2
// binary). This file re-exports the built dist bundle unchanged — no test hooks,
// no assertions — so what the host loads is exactly what the package publishes.
//
// It lives outside `.opencode/plugins/` on purpose. OpenCode auto-loads every
// directory there for any session started in this repo, and this entry shares
// the `commandcode` plugin ID with the npm package, so two copies would load and
// `opencode plugin check`/`update` would fail with "Duplicate plugin ID". Opt in
// by swapping it for the npm entry in your config — see CONTRIBUTING.md.
export { default } from "../../dist/index.js"
