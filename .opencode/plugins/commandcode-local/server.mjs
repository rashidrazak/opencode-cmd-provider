// .opencode/plugins/commandcode-local/server.mjs
//
// Local-filesystem plugin entry for exercising the working tree with a real
// OpenCode v2 host instead of the npm-installed package.
//
// The v2 loader requires a *directory* as a configured plugin path and resolves
// `server`/`index`, `tui`, and `rpc` from it (loader helper `Zg` in the v2
// binary). This file re-exports the built dist bundle unchanged — no test hooks,
// no assertions — so what the host loads is exactly what the package publishes.
export { default } from "../../../dist/index.js"
