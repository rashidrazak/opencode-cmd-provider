## Agent skills

### Map execution loop

When the user asks to execute the implementation map (#15) — "run the map",
"execute the tickets", "work the queue" — the `run-map` project skill
(`.pi/skills/run-map/`) is the trigger; it drives
`scripts/run-wayfinder-loop.sh` (sequential: frontier query via native issue
dependencies, claim, one fresh agent session per ticket, verify, close) in a
hands-free overlay the user can watch, background (`Ctrl+B`), and re-attach.

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map one-to-one to the label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Spec and plan

`DESIGN.md` (approved design spec) and `PLAN.md` (implementation plan) are the
source of truth for the `opencode-cmd-provider` work tracked in GitHub Issues. When working
on any issue from the implementation map (#15) or any of its children (#1–#14), read both
files first — including `DESIGN.md` §4 (verified opencode loader behavior). PLAN.md's
sections mirror the issues one-to-one (Issue N ↔ its own section, in the same order). If a
ticket and the plan disagree, the plan wins; note the discrepancy in the ticket.
