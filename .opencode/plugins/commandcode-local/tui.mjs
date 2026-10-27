// .opencode/plugins/commandcode-local/tui.mjs
//
// TUI half of the local plugin entry. The v2 loader resolves `tui` beside
// `server` in a configured plugin directory; without it the sidebar never
// appears. Re-exports the built bundle unchanged so the host loads the same
// module the package publishes as `./tui`.
export { default } from "../../../dist/tui.js"
