## Agent skills

### Releases

When the user asks to cut a release — "release", "bump to X", "tag vX.Y.Z" —
the `release` project skill (`.pi/skills/release/`) is the trigger: version
bump + CHANGELOG entry + snapshot refresh + tag, then the pipeline
(`.github/workflows/release.yml`, ADR 0002) publishes to npm and creates the
GitHub Release.

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
