# ADR-0009: The runtime provider specifier is version-pinned

Status: accepted

opencode keys its package cache by the exact specifier string and never
refreshes an install that already exists, while its plugin loader appends
`@latest` to a bare plugin spec and its provider loader uses the registered
`npm` value verbatim — verified against 1.18.30, with the sources and a live
reproduction recorded in
[#149](https://github.com/rashidrazak/opencode-cmd-provider/issues/149). A
package that is both the plugin and its own runtime provider therefore ends up
in two cache directories: the plugin under `…@latest`, the runtime provider
under the bare name. Only the directory a user happens to clear moves forward,
so the two halves of one release can silently run different code — in either
direction.

The plugin cannot fix opencode's cache, but it can stop handing it a specifier
that can drift. The decision: **the auto-registered `provider.commandcode.npm`
is the package's own name plus the exact version from the shipped
`package.json`** (for example `opencode-cmd-provider@1.7.4`), resolved at
runtime by walking up from the plugin module to its own manifest. The runtime
cache entry becomes version-keyed, so opencode can only ever install the
provider release that matches the plugin release that asked for it. A
user-declared `provider.commandcode` entry or `npm` still wins, and the plugin
still only fills blanks.

If the version cannot be resolved — no matching manifest within the lookup
depth, an unreadable file, invalid JSON, a missing or non-string version — the
plugin registers today's bare package name instead. That is deliberate: a
degraded registration is preferable to a plugin that will not load, because
auto-registration, `/connect` and the model list all depend on the entry module
importing cleanly. Resolution happens when the config hook runs, never at
import time, for the same reason.

## What this does not fix

**Staleness.** `Npm.add` returns an existing install as-is, so neither half
moves forward until the user clears the package cache; the README's cache wipe
remains the update path. This decision removes the _divergence_ between the two
halves, never the staleness — that is upstream's
([anomalyco/opencode#48514](https://github.com/anomalyco/opencode/issues/48514),
plus the older #6774 and #25293). If upstream ever reconciles the cache keys,
the pin can be deleted in a single release with no user-visible migration.

## Considered options

- **A `file://` self-reference** — registering the plugin's own entry file as
  the provider `npm`, which makes opencode import it directly and skip `Npm.add`
  entirely: no second install, no network. Rejected. It leans on an internal
  loader branch rather than the public `npm`-spec contract, bypasses the normal
  npm path (registry mirrors, proxies, integrity), and fails hard — the
  provider would not load at all — if that branch ever changes. For a package
  users install the normal way, that is the wrong risk to take.
- **Waiting for upstream.** Rejected: the class has been reported since
  January 2026 and repeatedly auto-closed for inactivity, and any fix only
  reaches users who upgrade opencode. The pin costs one small module.
- **A range or a tag** (`@^1.7.0`, `@latest`) instead of an exact version.
  Rejected: a moving specifier is just another cache key that can drift from
  the plugin, which is the bug being removed.
- **A generated version constant** instead of reading `package.json` at
  runtime. Rejected: a constant can go stale between the bump and the build,
  and a stale pin silently installs another release's provider code. The
  release pipeline already guarantees tag == `package.json` version.

## Consequences

- Every release a user moves through leaves one provider directory behind,
  keyed by that release; the README's
  `rm -rf ~/.cache/opencode/packages/opencode-cmd-provider*` wildcard removes
  them along with the plugin copies.
- The first Command Code request after an update installs the package from the
  registry with no progress output — the same lazy install as before, now once
  per version instead of once ever.
- The version in the shipped `package.json` must match the code built into
  `dist`; the release pipeline builds from the tag, so it does.
- A running version that is not published (a local build, or a version bumped
  before its tag) makes the runtime provider uninstallable — a loud, dev-facing
  failure. Declaring `provider.commandcode.npm` yourself remains the escape
  hatch.
- Two different versions of this plugin loaded in one config stay
  nondeterministic: opencode loads same-name/different-version packages
  separately, and the first config hook to run fills the entry. That is
  upstream's loading behavior and is out of scope here.
