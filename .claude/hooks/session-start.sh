#!/usr/bin/env bash
# Print the state a session needs before it can pick up work.
#
# CLAUDE.md's first instruction tells the session this block is already here, so
# without the hook every session opens by rediscovering the same six facts — and
# worse, is told not to ask for them. Read-only by construction: nothing below
# writes, fetches, or mutates anything.
#
# Network calls are the slow part, so `gh` is bounded and every one of them
# degrades to a printed note rather than a hang or a failed session start.

set -uo pipefail

REPO="Melvin0070/reprise"
GH_TIMEOUT=8

say() { printf '%s\n' "$*"; }
rule() { say "────────────────────────────────────────────────────────"; }

# `timeout` is GNU coreutils and absent on a stock macOS; fall back to gtimeout,
# then to running the command bare rather than skipping the section entirely.
run_bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout "$GH_TIMEOUT" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$GH_TIMEOUT" "$@"
  else "$@"
  fi
}

say ""
rule
say "REPRISE — session state"
rule

say ""
say "BRANCH: $(git branch --show-current 2>/dev/null || echo unknown)"

dirty=$(git status --porcelain 2>/dev/null)
if [ -z "$dirty" ]; then
  say "TREE:   clean"
else
  say "TREE:   dirty — run \`pnpm verify\` and confirm a green baseline before changing anything"
  printf '%s\n' "$dirty" | sed 's/^/        /'
fi

ahead=$(git log --oneline @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ')
if [ "${ahead:-0}" != "0" ] && [ -n "${ahead:-}" ]; then
  say "UNPUSHED: $ahead commit(s) ahead of upstream"
fi

say ""
say "RECENT COMMITS"
git log --oneline -5 2>/dev/null | sed 's/^/  /'

say ""
if ! command -v gh >/dev/null 2>&1; then
  say "ISSUES: gh not installed — read the backlog at github.com/$REPO/issues"
else
  # The loop takes the lowest-numbered unblocked issue in the current milestone,
  # so the open milestone with the lowest number is the one that matters. Sorting
  # by title works because the milestones are named S2..S8 in build order.
  milestone=$(run_bounded gh api "repos/$REPO/milestones?state=open" \
    --jq 'map(select(.open_issues > 0)) | sort_by(.title) | .[0].title' 2>/dev/null)

  if [ -z "$milestone" ] || [ "$milestone" = "null" ]; then
    say "ISSUES: could not reach GitHub — read the backlog at github.com/$REPO/issues"
  else
    say "CURRENT MILESTONE: $milestone"
    say ""
    say "NEXT UP (lowest-numbered unblocked issues in this milestone)"
    run_bounded gh issue list --repo "$REPO" --state open \
      --milestone "$milestone" --limit 60 \
      --json number,title,labels \
      --jq '[ .[] | select([.labels[].name] | index("blocked") | not) ]
            | sort_by(.number) | .[:5][]
            | "  #\(.number)  \(.title[:72])"' 2>/dev/null \
      || say "  (could not list issues)"

    blocked=$(run_bounded gh issue list --repo "$REPO" --state open --label blocked \
      --limit 20 --json number,title \
      --jq '.[] | "  #\(.number)  \(.title[:60])"' 2>/dev/null)
    if [ -n "$blocked" ]; then
      say ""
      say "BLOCKED — needs Melvin (credentials, billing, identity)"
      printf '%s\n' "$blocked"
    fi
  fi
fi

say ""
say "LATEST NOTEBOOK ENTRY"
if [ -f docs/notebook.md ]; then
  # Entries are `## <date> — <title>`; show the last one's heading and opening
  # lines, which is enough to know what the previous session concluded.
  awk '/^## /{ n = NR } { line[NR] = $0 } END { for (i = n; i <= NR && i < n + 8; i++) print "  " line[i] }' \
    docs/notebook.md
else
  say "  (docs/notebook.md missing)"
fi

say ""
rule
say "The loop: lowest-numbered unblocked issue -> red test from its Verify line"
say "-> green -> pnpm verify -> review gate -> PR -> merge on green CI -> notebook."
say "Full manual in CLAUDE.md. Stop conditions are credentials, billing, identity."
rule
say ""
