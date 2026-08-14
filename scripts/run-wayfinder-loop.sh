#!/usr/bin/env bash
#
# run-wayfinder-loop.sh — execute the opencode-cmd-provider wayfinder map (#15)
# ticket by ticket, one fresh agent session per ticket.
#
# Each iteration:
#   1. Frontier  — pick the lowest-numbered open `wayfinder:task` issue whose
#                  native blocked_by count is 0 (GitHub reports OPEN blockers
#                  only, so this is the live gate) and that has no assignee.
#   2. Claim     — assign @me. Guards against double-run races: if two loops
#                  start, the second skips claimed tickets.
#   3. Spawn     — a COLD headless agent process implements the ticket in this
#                  repo. Fresh context per ticket is the point: the agent's
#                  window contains only the prompt + AGENTS.md (injected) +
#                  what it reads (issue, DESIGN.md, PLAN.md section).
#   4. Verify    — HEAD must move and the tip commit must reference #N.
#                  Anything else = hard stop with an error, never a blind close.
#   5. Close     — close the ticket with a comment linking the commit.
#
# Prereqs:  gh (authed), git, and a headless agent CLI (default `pi -p`).
#           Run from the repo root. Commits land straight on the current
#           branch (solo repo, no PRs — the tickets are the review surface).
#
# Env:
#   AGENT_CMD        Headless agent invocation. Default: "pi -p".
#                    The prompt is appended as the last argument; the CLI runs
#                    with this repo as its cwd.
#   DRY_RUN=1        Print the ticket's prompt instead of spawning an agent
#                    (then exit — for checking the loop before a real run).
#   KEEP_ISSUES=1    Don't close tickets; leave them assigned for inspection.
#
# Exit codes: 0 = queue drained, 1 = hard failure on the current ticket,
#             2 = usage/prereq failure.

set -euo pipefail

REPO_OWNER="${REPO_OWNER:-}"
AGENT_CMD="${AGENT_CMD:-pi -p}"

say() { printf '\033[1;36m[loop]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[loop] FATAL:\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

# --- prereqs ---------------------------------------------------------------
command -v gh >/dev/null 2>&1 || die "gh not found" 2
command -v git >/dev/null 2>&1 || die "git not found" 2
gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)" 2
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git work tree" 2
# shellcheck disable=SC2086
command -v ${AGENT_CMD%% *} >/dev/null 2>&1 || die "agent CLI not found: '${AGENT_CMD%% *}'" 2
[ -n "$(git status --porcelain)" ] && die "working tree is dirty — commit or stash before running the loop" 2

# Resolve the repo for gh api (works in any clone; explicit override honored).
: "${REPO_OWNER:=$(gh repo view --json owner --jq .owner.login)}"
: "${REPO_NAME:=$(gh repo view --json name --jq .name)}"

# --- frontier --------------------------------------------------------------
# Lowest-numbered open wayfinder:task with zero open native blockers and no
# assignee. Prints the issue number, or nothing when the queue is drained.
frontier() {
  gh issue list --state open --label wayfinder:task \
    --json number,assignees \
    --jq '.[] | select(.assignees | length == 0) | .number' \
    | sort -n \
    | while read -r n; do
        blocked=$(gh api "repos/$REPO_OWNER/$REPO_NAME/issues/$n" \
          --jq '.issue_dependencies_summary.blocked_by // 0')
        if [ "$blocked" = "0" ]; then
          echo "$n"
          break
        fi
      done
}

# --- per-ticket prompt -----------------------------------------------------
prompt_for() {
  cat <<EOF
Implement GitHub issue #$1 in this repository ($REPO_OWNER/$REPO_NAME).

Order of reading, before writing any code:
1. AGENTS.md — repo conventions.
2. The issue: gh issue view $1 --json body,labels
3. DESIGN.md — especially §4 (verified opencode loader behavior).
4. The "Issue $1" section of PLAN.md — it mirrors the issue one-to-one and is
   the source of truth. If the issue and the plan disagree, the plan wins;
   note the discrepancy in a comment on issue #$1.

How to work:
- TDD at the seams the plan prescribes: write the plan's failing test first,
  run it to watch it fail, implement, run it green.
- Run the single test file repeatedly while working; run the full test suite
  and typecheck before finishing.
- Review the full diff against the issue's acceptance criteria.

When done:
- Commit on the current branch: git add -A && git commit -m "<type>(scope): <summary> (#$1)"
  (choose type/scope per the plan's commit lines).
- Do NOT close the issue and do NOT push; the driver loop handles both.
- Report a short summary: files touched, test results, any acceptance
  criteria you could not satisfy, and the commit SHA.
EOF
}

# --- main loop -------------------------------------------------------------
while true; do
  N=$(frontier)
  if [ -z "$N" ]; then
    say "queue drained — no unblocked, unassigned wayfinder:task left"
    exit 0
  fi

  say "frontier → issue #$N: $(gh issue view "$N" --json title --jq .title)"
  say "claiming #$N"
  gh issue edit "$N" --add-assignee @me >/dev/null

  before=$(git rev-parse HEAD)
  say "spawning fresh agent session for #$N"

  if [ "${DRY_RUN:-0}" = "1" ]; then
    say "DRY_RUN: agent would run with this prompt:"
    prompt_for "$N"
    exit 0
  fi

  # shellcheck disable=SC2086
  if ! $AGENT_CMD "$(prompt_for "$N")"; then
    die "agent session for #$N exited non-zero — ticket left open and assigned, no close" 1
  fi

  after=$(git rev-parse HEAD)
  [ "$after" != "$before" ] || die "agent made no commit for #$N — ticket left open and assigned" 1
  git log --format=%s -1 | grep -q "#$N" || die "tip commit does not reference #$N — ticket left open and assigned" 1

  say "verified commit $(git rev-parse --short HEAD) for #$N"

  if [ "${KEEP_ISSUES:-0}" = "1" ]; then
    say "KEEP_ISSUES: leaving #$N open (assigned) for inspection"
  else
    gh issue close "$N" --comment "Implemented in $(git rev-parse --short HEAD) (driver loop)."
    say "closed #$N"
  fi
done
