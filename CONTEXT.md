# opencode-cmd-provider

Plugin + provider package that lets OpenCode use Command Code as a model provider.

## Language

**Model catalog**:
The list of models Command Code offers (id, name, context length), as served by its provider API.
_Avoid_: models list, model endpoint, offerings

**Snapshot**:
A copy of the model catalog bundled inside the plugin package; the runtime source of truth for which Command Code models exist.
_Avoid_: embedded catalog, static catalog, shipped list

**Auto-registration**:
The plugin making the `commandcode` provider and its models available to OpenCode without the user declaring them in `opencode.json`.
_Avoid_: config injection, zero-config, self-registration

**Declared models**:
Models the user explicitly lists under `provider.commandcode.models` in `opencode.json`, taking precedence over snapshot models.
_Avoid_: user models, custom models, overrides

**Catalog refresh**:
Updating the snapshot to match the live model catalog; happens on plugin release, never at runtime.
_Avoid_: model sync, catalog update, live refresh

**Release**:
A versioned publication of the package: a git tag `vX.Y.Z` matching the `package.json` version, a GitHub Release, and an npm publish. The catalog snapshot is regenerated before every release — a release never ships a stale snapshot.
_Avoid_: publish, deploy, ship (when meaning the whole publication)

**Display name**:
The name shown for a model in OpenCode's picker: the raw catalog name with the `[CMD]` prefix (`[CMD] Claude Sonnet 5`).
_Avoid_: label, model name, pretty name
