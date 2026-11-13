// src/rates-usage/gui/styles.ts — the desktop panel's stylesheet, injected with
// `ctx.add(Style, css)` and scoped to the panel's own `data-component` value
// (the host's convention for plugin surfaces), so the app's stylesheets can
// never collide with it and it can never leak into them.
//
// Colours come from the app's v2 theme tokens (verified against the 2.2.7
// renderer: `--v2-text-text-base`/`-muted`/`-faint`,
// `--v2-state-fg-success`/`-warning`/`-danger` — the tone set is danger, not
// error — and `--v2-font-family-code`), so the panel follows the user's theme
// like the app's own panes do. Every token keeps a static fallback so a token
// the app renames degrades to a readable pane instead of invisible text.
//
// The row classes mirror the TUI's row kinds one-to-one (see
// `src/rates-usage/gui/rows.ts`): heading, strong label, muted value line,
// label/value grid row, and the mono usage bar with its tone colour.

/** The panel root's `data-component` value, the app's own scoping convention. */
export const RATES_USAGE_COMPONENT_NAME = "commandcode-rates-usage"

/** The stylesheet the setup contributes; injected while the plugin is loaded. */
export const RATES_USAGE_GUI_CSS = `
[data-component="${RATES_USAGE_COMPONENT_NAME}"] {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  height: 100%;
  padding: 12px 14px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.45;
  color: var(--v2-text-text-base, inherit);
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-title {
  font-weight: 640;
  font-size: 13px;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-gap {
  height: 8px;
  flex: none;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-heading {
  font-weight: 620;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--v2-text-text-faint, currentColor);
  margin-top: 2px;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-strong {
  font-weight: 600;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-value,
[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-bar {
  font-family: var(--v2-font-family-code, monospace);
  color: var(--v2-text-text-muted, inherit);
  white-space: pre;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-row {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 10px;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-row-label {
  color: var(--v2-text-text-muted, inherit);
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-row-value {
  min-width: 0;
  overflow-wrap: anywhere;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-bar {
  display: flex;
  gap: 8px;
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-bar--success {
  color: var(--v2-state-fg-success, #3fb950);
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-bar--warning {
  color: var(--v2-state-fg-warning, #d29922);
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-bar--error {
  color: var(--v2-state-fg-danger, #f85149);
}

[data-component="${RATES_USAGE_COMPONENT_NAME}"] .cc-ru-bar-pct {
  color: var(--v2-text-text-muted, inherit);
  font-family: var(--v2-font-family-code, monospace);
  white-space: pre;
}
`
