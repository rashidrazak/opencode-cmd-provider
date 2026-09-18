# ADR-0017: The plan summary renders the account and the credential rung

Status: accepted

## Context

`cmd_plan_summary` answers for whichever credential the ADR-0015 ladder
resolves: the Host's own connection, `COMMANDCODE_API_KEY`, or a legacy auth
file. ADR-0015 fixed _which_ credential is asked; it deliberately left rendering
to this decision (issue #205).

The gap it left is what made issue #201 hard to see. On a machine with more than
one Command Code account the legacy rung can answer for an account the session
does not stream with — a different plan, a different subscription — and the
rendered summary looked exactly like a correct one. The credential a billing
lookup used, and the account it belonged to, were both invisible.

## Decision

**The summary prints one provenance line directly under the plan header**: the
account the lookup answered for, when `whoami` named one, plus the rung that
supplied the credential. One rendering per rung:

```
Account: `rashid` — credential: Host connection
Account: `rashid` — credential: Host connection (COMMANDCODE_API_KEY)
Account: `rashid` — credential: Host configuration
Account: `rashid` — credential: COMMANDCODE_API_KEY
Account: `rashid` — credential: legacy file `~/.commandcode/auth.json`
Account: `rashid` — credential: the explicit `apiKey` option
Credential: none — plan pinned by the `plan` argument, so no lookup was made.
Credential: none — plan pinned by COMMANDCODE_PLAN, so no lookup was made.
Credential: none resolved — no lookup was made.
```

Five rules travel with the line:

1. **One line, key-free.** It carries provenance, never key material — the same
   rule ADR-0015 puts on the seam (rule 4). The file rung renders the store's
   label (`~/.commandcode/auth.json`), not anything read out of it.
2. **No account claim without a `whoami` answer.** The label comes from the
   `whoami` response the plan lookup already makes: `user.userName`, else an
   elided `user.id` — never `user.email`, never a key, and never a `userName`
   that is an email address. When that leg fails, or names no user, the line
   renders `Credential: …` alone: an absent label, not a guessed one.
3. **A pin asks for no identity.** The `plan` argument and `COMMANDCODE_PLAN`
   keep short-circuiting before the credential ladder (ADR-0011 §2), so the
   pinned summary renders the pin as its source instead of adding a request just
   to name an account.
4. **Every label is inert.** The account label is markdown-flattened and
   truncated (32 chars) before rendering, and the file rung's path is flattened
   the same way, so neither a value read from the API nor a store's name can
   forge a table row or break out of the line it sits in.
5. **`unknown` keeps its explanation.** The provenance line is added to it; the
   unknown rendering, its causes, and the "never a default plan" rule are
   unchanged (ADR-0011).

## Consequences

- A wrong-account answer is visible where the plan is read: the reader sees
  `legacy file` where a Host connection was expected, and sees which account the
  figures belong to, without a second tool or a debug flag.
- `resolveApiKey` gains a provenance-returning sibling in Core
  (`resolveApiKeyWithSource` → `{ key, source }`); its own signature is
  untouched, so the transport path is unchanged.
- The account label is display-only. Nothing else consumes it, and no credential
  is added to tool output.
- Every billing lookup already fetched `whoami` for the org scope, so the label
  costs no additional request; only a pinned plan renders a source without one.
