# Changelog

## 0.1.2 - 2026-08-15

Fix: tool-call history round-trip and reasoning effort. Live probes against the Command Code API with opencode confirmed the AI SDK v3 shapes differ from what the converters expected:

- Assistant tool-call parts carry arguments under `input`, not `args`/`arguments` — the converter read the legacy fields, so every prior tool call was re-sent with empty `{}` arguments, corrupting multi-turn context.
- Tool-result outputs use the v3 `{ type: "text" | "error-text" | "json" | "content", ... }` shapes — `resultText` stringified the wrapper, double-encoding results in history. Replaced with `unwrapToolResult`.
- `reasoning_effort` was silently dropped: opencode passes `providerOptions` namespaced per provider (`{ commandcode: { reasoningEffort } }`), but the model read the top-level keys. Added `resolveProviderReasoning` (namespaced + top-level fallback) so the configured thinking level actually reaches the API.

Also: remove duplicated README disclaimer; bump `@ai-sdk/provider` to 4.x and `@types/node` to 26.x.

## 0.1.1 - 2026-08-15

Fix: emit `text-start`/`text-end` and `reasoning-start`/`reasoning-end` stream parts. The live Command Code API sends start/end events with ids; the AI SDK's streamText consumer requires them before deltas, so reasoning-capable models (e.g. `deepseek/deepseek-v4-flash`) failed with "reasoning part <id> not found".

## 0.1.0 - 2026-08-15

Initial release: Command Code provider + plugin for opencode. Published to npm as `opencode-cmd-provider@0.1.0` (`latest`), tagged `v0.1.0`.

- `createCommandCode(options)` AI SDK provider (LanguageModelV3) + `default` V1 opencode plugin module in one package.
- `/connect` browser auth flow, `COMMANDCODE_API_KEY` env var, and legacy auth file support (`~/.commandcode/auth.json`, `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json`).
- Model catalog fetch, parse, and cache with offline fallback; pricing/cost display; image input; reasoning effort.
- Config-declared `models` map required under `provider.commandcode` until `commandcode` lands in opencode's models.dev catalog.
