// tui.ts — root entry so the TUI plugin emits to dist/tui.js (the "./tui"
// export target, matching how index.ts emits to dist/index.js) while the
// implementation lives in src/tui/.
export { default } from "./src/tui/index.js"
