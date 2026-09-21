# ADR-0019: An out-of-vocabulary reasoning effort snaps to the nearest advertised level

Status: accepted

The generated efforts table gives each family a different vocabulary: Qwen 3.8
advertises `low`/`medium`/`xhigh` (no `high`, no `max`), DeepSeek V4 and GLM
advertise `low`/`high`/`max` or a subset (no `medium`, no `xhigh`). The
request path mapped a requested effort through an identity map over the
model's advertised set, and any level outside it — `high` on Qwen 3.8 Max,
`medium` on GLM-5.3, `low` on DeepSeek V4 Pro — was silently dropped from
the request body, leaving the provider's default reasoning depth in charge
of a request the user had explicitly asked to make deeper or shallower.

The variant cycle (`ctrl+t`) is unaffected by construction — it only ever
offers advertised names. The casualty is a host- or agent-wide
`reasoningEffort` setting, which cannot be simultaneously in vocabulary for
every family: whichever value it names is dropped on the families that do
not advertise it.

## The decision

**A requested effort that is a thinking-ladder level but is not advertised
by the model snaps to the nearest advertised level, ties upward** — on the
fixed ladder `off < minimal < low < medium < high < xhigh < max`. `high` on
Qwen 3.8 Max becomes `xhigh`, `medium` on GLM-5.3 becomes `high`, `low` on
DeepSeek V4 Pro becomes `high`. Snapping upward on a tie follows the
request's intent: someone asking for `high` on a model that skips it wants
the deeper option, not the shallower one.

Three behaviors deliberately do not change:

- `off` still sends nothing — it means "do not request effort", not "request
  the shallowest effort".
- A string that is not a ladder level at all is still dropped rather than
  guessed at; the map does not invent vocabulary.
- A model with no advertised levels (reasoning-without-efforts) still sends
  nothing and lets Command Code choose the depth.

The snap is request-path only (`mappedReasoningEffort`).
`thinkingLevelMap` metadata and the registered variants keep advertising
exactly the levels the model supports, so the host's effort surface — what
cycles, what renders — is unchanged.

CLI parity: the CLI pins `reasoningEffort` per model in its own config, and
its `/effort` cycling only offers per-model values, so it never sends an
out-of-vocabulary effort — there is no upstream behavior to diverge from.
Where the plugin previously agreed with the CLI by omission (drop), it now
sends the nearest in-vocabulary value, a strict movement toward the user's
request.

## Consequences

- Request bodies change only for efforts that were previously dropped; every
  value the model advertises is sent exactly as before.
- A cross-family effort setting now has an effect on every reasoning model
  instead of silently reverting to the provider default on some of them.
- `tests/reasoning.test.ts` pins the snap table on synthetic vocabularies
  (it owns the mapping behavior, not upstream's current values), including
  the tie-upward rule and the `off`/non-ladder/no-levels exceptions, and
  `tests/provider-parity.test.ts` pins the snapped `minimal` → `low` on the
  wire across all three transports.
