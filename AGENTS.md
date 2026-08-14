## Agent skills

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
