#!/usr/bin/env bash
# Tell Melvin when a fresh session would be the better choice.
#
# The autonomous loop runs many slices per session, and quality degrades as
# context fills — but the degradation is invisible from outside, so "restart
# when it feels long" puts the judgement on the person with the least
# information. This makes the signal mechanical.
#
# Transcript bytes are the proxy for context used. Calibrated 2026-09-08 against
# real sessions in this repo: ones that ended at a natural point ran 1.2-1.5MB,
# and the session that built this hook had reached 2.2MB and was overdue.
#
# The size alone is only half the answer. Restarting mid-slice is expensive — an
# unopened PR and a half-built branch are the one state that costs something to
# resume — so the hook also reports whether NOW is a safe seam.

set -uo pipefail

STATE_DIR="${TMPDIR:-/tmp}/reprise-session-health"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

payload_file="$STATE_DIR/.payload.$$"
cat > "$payload_file"
trap 'rm -f "$payload_file"' EXIT

# Two plain lines out, read with `read` rather than eval'd — the payload is
# JSON from the harness and must never reach the shell as code.
{ read -r SESSION_ID; read -r TRANSCRIPT; } < <(
  python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(); print(); sys.exit(0)
print(str(d.get("session_id", "")).replace("\n", ""))
print(str(d.get("transcript_path", "")).replace("\n", ""))
' "$payload_file" 2>/dev/null
)

[ -n "${TRANSCRIPT:-}" ] && [ -f "$TRANSCRIPT" ] || exit 0

bytes=$(wc -c < "$TRANSCRIPT" 2>/dev/null | tr -d ' ')
[ -n "$bytes" ] || exit 0

# Thresholds in bytes. See calibration note above.
WARN=1258291    # 1.2MB — a fresh session is now the better choice at the next seam
HARD=2097152    # 2.0MB — restart even if it means finishing one slice first

if   [ "$bytes" -ge "$HARD" ]; then tier=hard
elif [ "$bytes" -ge "$WARN" ]; then tier=warn
else exit 0
fi

# One announcement per tier per session. A Stop hook fires on every turn, and a
# banner repeated twenty times is a banner nobody reads.
marker="$STATE_DIR/${SESSION_ID:-unknown}.$tier"
[ -e "$marker" ] && exit 0
: > "$marker"

mb=$(awk -v b="$bytes" 'BEGIN{printf "%.1f", b/1048576}')

branch=$(git branch --show-current 2>/dev/null || echo "?")
dirty=$(git status --porcelain 2>/dev/null | head -1)
unpushed=$(git log --oneline @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ')

if [ "$branch" = "main" ] && [ -z "$dirty" ] && [ "${unpushed:-0}" = "0" ]; then
  seam="SAFE SEAM — clean tree on main, nothing unpushed. Restarting now costs nothing."
else
  seam="MID-SLICE — branch '$branch'"
  [ -n "$dirty" ] && seam="$seam, uncommitted changes"
  [ "${unpushed:-0}" != "0" ] && seam="$seam, $unpushed unpushed commit(s)"
  seam="$seam. Land this slice first, THEN restart."
fi

echo ""
echo "──────────────────────────────────────────────────────────"
if [ "$tier" = "hard" ]; then
  echo "  SESSION HANDOFF: start a new session (${mb}MB of context used)"
else
  echo "  SESSION HANDOFF: a fresh session is now the better choice (${mb}MB)"
fi
echo "──────────────────────────────────────────────────────────"
echo "  $seam"
echo ""
echo "  Nothing is lost: the backlog holds the work, docs/notebook.md holds"
echo "  the reasoning, CLAUDE.md holds the rules. Open a session and type 'go'."
echo "──────────────────────────────────────────────────────────"
echo ""
