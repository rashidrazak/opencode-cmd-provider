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

Specs and plans live in GitHub Issues. Domain vocabulary lives in `CONTEXT.md`;
architectural decisions (including verified opencode loader behavior) live in
`docs/adr/`. When working on any issue, read the issue, `CONTEXT.md`, and any
ADRs touching the area first. If a ticket and an ADR disagree, note the
discrepancy in the ticket.
