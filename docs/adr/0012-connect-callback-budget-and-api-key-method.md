# ADR-0012: The connect callback waits at human scale, and the API-key method carries no `authorize`

Status: accepted

Both decisions come from issue #145, where a slow-but-normal browser login
produced two symptoms that were really one event.

## 1. The callback budget is five minutes, and the timer is disarmed on exit

`callback()` used to race the studio's POST against a 15-second timer and then
close the callback server. A real login — page load, sign-in, org/context pick,
approve, key transfer — routinely outlasts 15 seconds, so the timer fired
mid-login, the race rejected, and `authServer.server.close()` ran before the
studio could POST. The studio fell back to "Copy your API key", and every host
mapped the non-success callback to its own failure: core raises
`ProviderAuthOauthCallbackFailed`, which OpenChamber renders as
`settings.providers.page.auth.oauth.error.declined` — "授权被拒绝或未完成。"

The budget is now `DEFAULT_AUTH_TIMEOUT_MS = 300_000`, exported so a test can
pin it. Five minutes is bounded from both ends: long enough for the human part
to finish, and still under OpenChamber's own 15-minute budget for exactly this
route (`INTERACTIVE_OAUTH_TIMEOUT_MS` in its OpenCode proxy, which exempts
`/provider/:id/oauth/callback` from the 4-minute proxy default). The host must
never be the one to give up first — if it were, the failure would move rather
than disappear.

The timer is now cleared in a `finally` alongside the server close. It never
was before, so a **successful** login left it armed for whatever remained of
the budget, holding the event loop open. At 15 seconds that was invisible; at
five minutes it is a five-minute hang on every connect. The budget and the
disarm are one change: raising the constant alone would have traded a login
failure for a shutdown delay.

## 2. The API-key method is declared, and deliberately has no `authorize`

The v1 `auth` hook now declares a second method beside the browser flow:

```ts
{ type: "oauth", label: "Command Code", authorize: async () => runAuthFlow() },
{ type: "api", label: "Command Code API key" },
```

It exists for the environments where the browser cannot reach the plugin's
loopback server at all — a remote `OPENCODE_HOST`, or blocked local-network
access — which produce the same screenshot pair as the timeout above. It also
gives the studio's own "Copy your API key" fallback a destination.

**No `authorize` on it, on purpose.** That is verified host behaviour, not an
omission:

| host          | what it does with an `api` method                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode core | `provider.oauth.authorize` returns early for anything that is not `oauth` (`if (method.type !== "oauth") return`), so a declared `authorize` would never be invoked |
| OpenCode TUI  | renders `ApiMethod` — a `DialogPrompt` for the key — and stores it itself via `auth.set({ type: "api", key })`; it never calls the plugin back                      |
| OpenChamber   | renders its API Key field only when some method normalizes to `api` (`shouldShowApiKeyAuth`), and saves through the same `auth.set`                                 |

So the declaration _is_ the mechanism: hosts own the prompt and the credential
write. Adding an `authorize` here would be unreachable code that reads as
load-bearing, and a future reader would reasonably assume the host depends on
it.

Two consequences worth stating:

- **Declaring a second method adds a picker step.** Both the TUI and OpenChamber
  render a method chooser once a provider has more than one; `/connect` →
  Command Code now asks browser-or-key before opening the browser. The browser
  flow stays at index 0 so the choice a returning user wants is the first entry.
- **v2 needs nothing.** `registerIntegration` already registers `env` and `key`
  methods, so this is a v1-only addition and the v2 half stays untouched.

## Not decided here

A key pasted through the `api` method is written by the host, so the plugin
never sees it and does **not** mirror it under `command-code` the way the
browser flow does (`src/plugin/auth-mirror.ts`). Ecosystem consumers that read
the mirror — OpenChamber's quota provider among them — will not find a
pasted key. The v1 auth hook has no post-set callback to hang a mirror on, so
closing this gap needs a different seam (a `loader`-time mirror, or a host
feature). Tracked separately rather than papered over here.

`DEFAULT_AUTH_TIMEOUT_MS` is deliberately not configurable by environment
variable yet. One number covers the documented flows; an escape hatch can be
added when a real environment needs one.
