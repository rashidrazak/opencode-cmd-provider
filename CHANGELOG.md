# Changelog

## 1.1.1 - 2026-08-20

Fix: generate image-input modalities from the Command Code CLI catalog.

- `MODEL_INPUT_MODALITIES` now comes from `inputModalities` fields in the
  parsed `command-code` CLI bundle instead of a hand-maintained table.
- The release refresh validates that every API snapshot model is represented
  in the CLI bundle and fails loudly on unsupported or conflicting modality
  data.
- Added AST parser and offline coverage for reordered fields, duplicate model
  entries, malformed bundles, and text-only fallback behavior.
- Docs: the release skill and facts-sync spec now describe the modality
  refresh and the new release-gate failure mode.
- Thanks to @ericpastorm for #31, which auto-syncs the input-modality table
  from the CLI catalog.

## 1.1.0 - 2026-08-20

Feature: complete capability metadata for every catalog model, with automatic sync of reasoning and pricing facts at release time.

- Every auto-registered model now advertises tool calls, reasoning (efforts or reasoning-capable classification), image input, and cost — no more blank CAPABILITIES, blank MODALITIES, or $0.00 rows (fixes #22).
- Reasoning efforts and per-1M-token rates are generated from the command-code package's bundled `models.md` at snapshot-refresh time (`src/catalog/facts.ts`); the release pipeline now fails loudly if the committed facts drifted (ADR 0003).
- Corrected real pricing drift: `deepseek-v4-pro`/`flash` rates were stale, and the expired `gpt-5.6-terra`/`luna` discounts are gone. Context-tier pricing was removed — Command Code publishes flat rates only.
- Added vision entries for `Qwen/Qwen3.8-27B` and `google/gemini-3.7-flash`, and reasoning efforts for `zai-org/GLM-5.3`, `Qwen/Qwen3.8-27B`, `google/gemini-3.7-flash`, and `xai/grok-4.6`.

## 1.0.2 - 2026-08-19

Chore: refresh the bundled model catalog snapshot after the live catalog drifted.

- Added `Qwen/Qwen3.8-27B` (262144 context) to the bundled snapshot — the release pipeline's stale-snapshot gate would otherwise fail the next tag push (ADR 0003).

## 1.0.1 - 2026-08-16

Chore: harden the release flow so a tag push can no longer publish from an unmerged tree or rewrite tags.

- The release pipeline now refuses to run unless the tag's commit is an ancestor of `origin/main` — a tag pushed before the version bump lands on main fails with an explicit error instead of publishing (ADR 0003).
- A stale catalog snapshot now fails the run with remediation instructions instead of committing on the tag's tree, force-pushing main, and re-pointing the tag.
- The release skill ritual was updated: the bump and CHANGELOG entry land on main via PR before tagging; the tag push is all that triggers the pipeline.

## 1.0.0 - 2026-08-16

First stable release: API and behavior locked in, shipping now runs through a tag-driven pipeline.

- Tag-driven release pipeline: pushing `vX.Y.Z` asserts the tag matches `package.json`, refreshes the bundled model-catalog snapshot (committing it and re-triggering itself if stale), builds, runs the full test suite, publishes to npm via OIDC trusted publishing with provenance, and creates the GitHub Release from the CHANGELOG section (ADR 0002).
- Added the `release` skill documenting the pre-tag ritual and post-push verification; removed the run-map skill and the wayfinder-loop script.
- Docs: spell the product name as OpenCode everywhere, list Command Code plans, credit pi-commandcode-provider, and note provenance requires a public repository.
- The e2e test now uses the inherited PATH instead of a hardcoded home directory.

## 0.1.3 - 2026-08-16

Feature: zero-config install via auto-registration from a bundled model snapshot.

- The plugin now bundles a snapshot of the Command Code model catalog (`src/catalog/snapshot.ts`, 55 models) and auto-registers the `commandcode` provider — npm, name, `env`, and every model — during its `config` hook. Installing the plugin is enough: all Command Code models appear in `/models` with the `[CMD]` display-name prefix, no `provider.commandcode` block or `models` map required. No network access is ever needed at runtime.
- Declared config wins: provider-level keys are filled only when unset, declared models are never modified or removed, models that left the catalog stay usable, and `whitelist`/`blacklist` still filter auto-registered models.
- The snapshot is regenerated from the live catalog at every release via `npm run refresh:snapshot` (`scripts/refresh-snapshot.mjs`); newly published models appear after a plugin update.
- Deleted the now-dead network machinery: live catalog fetch and cache (`loadCommandCodeModels`, cache file), the `provider.models` hook, `catalogToOpenCodeModels`, and the `COMMANDCODE_MODELS_*` env vars.
- `COMMANDCODE_API_BASE` now actually overrides the runtime API base (injected as `options.baseURL` when the user declares no `baseURL` of their own).

## 0.1.2 - 2026-08-15

Fix: tool-call history round-trip and reasoning effort. Live probes against the Command Code API with OpenCode confirmed the AI SDK v3 shapes differ from what the converters expected:

- Assistant tool-call parts carry arguments under `input`, not `args`/`arguments` — the converter read the legacy fields, so every prior tool call was re-sent with empty `{}` arguments, corrupting multi-turn context.
- Tool-result outputs use the v3 `{ type: "text" | "error-text" | "json" | "content", ... }` shapes — `resultText` stringified the wrapper, double-encoding results in history. Replaced with `unwrapToolResult`.
- `reasoning_effort` was silently dropped: OpenCode passes `providerOptions` namespaced per provider (`{ commandcode: { reasoningEffort } }`), but the model read the top-level keys. Added `resolveProviderReasoning` (namespaced + top-level fallback) so the configured thinking level actually reaches the API.

Also: remove duplicated README disclaimer; bump `@ai-sdk/provider` to 4.x and `@types/node` to 26.x.

## 0.1.1 - 2026-08-15

Fix: emit `text-start`/`text-end` and `reasoning-start`/`reasoning-end` stream parts. The live Command Code API sends start/end events with ids; the AI SDK's streamText consumer requires them before deltas, so reasoning-capable models (e.g. `deepseek/deepseek-v4-flash`) failed with "reasoning part <id> not found".

## 0.1.0 - 2026-08-15

Initial release: Command Code provider + plugin for OpenCode. Published to npm as `opencode-cmd-provider@0.1.0` (`latest`), tagged `v0.1.0`.

- `createCommandCode(options)` AI SDK provider (LanguageModelV3) + `default` V1 OpenCode plugin module in one package.
- `/connect` browser auth flow, `COMMANDCODE_API_KEY` env var, and legacy auth file support (`~/.commandcode/auth.json`, `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json`).
- Model catalog fetch, parse, and cache with offline fallback; pricing/cost display; image input; reasoning effort.
- Config-declared `models` map required under `provider.commandcode` until `commandcode` lands in OpenCode's models.dev catalog.
