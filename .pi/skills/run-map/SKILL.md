---
name: run-map
description: Execute the opencode-cmd-provider implementation map (#15) ticket by ticket — one fresh agent session per ticket, sequential, with live dependency gating. Use when the user says "run the map", "execute the tickets", "work the queue", "start the wayfinder loop", or wants the implementation queue drained autonomously. Not for implementing a single ticket in-session (use /implement) or for planning work (use /to-spec or /to-tickets).
---

# Run the map

Drive the wayfinder implementation map (#15, children #1–#14) with the driver
loop script. The script owns the mechanics — frontier query, claim, spawn,
verify, close — and its header is the full reference. This skill is the
trigger and the ritual around it.

## Launch ritual

1. Confirm preconditions: clean worktree, `gh` authed, repo root as cwd.
2. Launch the script in a **hands-free overlay**:

   ```
   interactive_shell({ command: "bash scripts/run-wayfinder-loop.sh", mode: "hands-free", reason: "wayfinder map execution loop" })
   ```

   The user watches live and can `Ctrl+B` background / `/attach` later. Do not
   run it through the plain bash tool — the output would be invisible for hours.

3. Tell the user the two watch keys: `Ctrl+B` (background, loop keeps running)
   and `/attach <session>` (re-attach with accumulated output), plus `Ctrl+T`
   to transfer the stream to the agent.

## What each iteration does (summary)

- **Frontier** — lowest-numbered open `wayfinder:task` with
  `blocked_by == 0` (native issue dependencies; open blockers only) and no
  assignee. GitHub-native, no body parsing.
- **Claim** — assigns @me before spawning (anti-race).
- **Spawn** — one cold headless agent process per ticket (`AGENT_CMD`,
  default `pi -p`). Fresh context per ticket is deliberate: the session reads
  AGENTS.md → the issue → DESIGN.md (esp. §4) → the matching PLAN.md section,
  works TDD at the plan's seams, runs typecheck + full suite, commits
  referencing `#N`.
- **Verify** — HEAD must move and the tip commit must reference `#N`;
  otherwise hard stop, never a blind close.
- **Close** — comment with the commit SHA, loop to the next frontier ticket.

## Switches

- `AGENT_CMD="claude -p"` (or codex) — swap the headless agent CLI.
- `DRY_RUN=1` — print the next ticket's prompt and exit; smoke-test before a real run.
- `KEEP_ISSUES=1` — don't close tickets; leave them open + assigned for inspection.

## Caveats

- The loop commits straight to `main` in this repo — no branches, no PRs.
  Tickets are the review surface.
- The loop process is a child of this pi session: backgrounding is fine,
  quitting pi kills it.
- If a failure is a one-off (flaky test, transient auth), re-run the loop —
  the claim guard skips already-assigned tickets and picks up where it stopped.
- If failures show a _pattern_ (same ticket class flailing, downstream breaks),
  stop the loop and report to the user — do not improvise fixes inside the loop.
- Do not parallelize: the ticket graph has one shared repo and ~2× speedup
  ceiling; the script is deliberately sequential (one writer per worktree).
