# Changelog

## 0.1.0 - 2026-08-15

Initial release: Command Code provider + plugin for opencode. Published to npm as `opencode-cmd-provider@0.1.0` (`latest`), tagged `v0.1.0`.

- `createCommandCode(options)` AI SDK provider (LanguageModelV3) + `default` V1 opencode plugin module in one package.
- `/connect` browser auth flow, `COMMANDCODE_API_KEY` env var, and legacy auth file support (`~/.commandcode/auth.json`, `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json`).
- Model catalog fetch, parse, and cache with offline fallback; pricing/cost display; image input; reasoning effort.
- Config-declared `models` map required under `provider.commandcode` until `commandcode` lands in opencode's models.dev catalog.
