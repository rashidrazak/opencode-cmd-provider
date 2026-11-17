// tests/gui-shared-modules.ts — the canonical copy of the OpenCode desktop
// host's shared-module set: the modules a window's `require` serves to every
// GUI bundle (desktop app 2.2.7). Two guards consume it:
//
//   - tests/gui-panel.test.ts evaluates the built bundle through the host's
//     exact `new Function("require", ...)` and fails on any require outside
//     this set;
//   - tests/contract.test.ts scans the artifact's require targets textually.
//
// Relationship to scripts/vite-gui.config.mjs: the config's `SHARED` list is
// deliberately narrower — it is what THIS bundle must keep external (the
// modules src/rates-usage/gui/ actually imports). The config's list must stay
// a subset of this allowlist; this allowlist is what the host permits. When
// the desktop SDK shares a new module, widen it here first.
export const DESKTOP_SHARED_MODULES = [
  "@opencode/plugin/gui",
  "@opencode/plugin/gui/main",
  "@opencode/plugin/rpc",
  "@opencode/schema/rpc",
  "@opencode/client",
  "@opencode/client/effect",
  "@opencode/client/solid",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "effect",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
] as const
