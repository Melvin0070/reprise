#!/usr/bin/env bash
#
# Self-test for infra/preflight-org.sh (issue #79).
#
# The preflight is the mechanical half of the 6PN standing constraint, so it
# needs to be right in both directions: a lone app must deploy, and a second app
# in the org must stop the deploy. A guard that never fires and a guard that
# always fires are indistinguishable until the day it matters, which is why the
# refusal case is asserted on the exit code and not merely on the message.
#
# Reads no network and no Fly credentials — the preflight takes `fly apps list
# --json` on stdin precisely so its decision is testable without an org.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREFLIGHT="$HERE/preflight-org.sh"

failures=0

# Runs the preflight over $2, asserting exit status $1. $3 names the case.
expect() {
  local want=$1 json=$2 name=$3 out got
  out=$(printf '%s' "$json" | bash "$PREFLIGHT" 2>&1)
  got=$?
  if [ "$got" != "$want" ]; then
    echo "FAIL: $name — wanted exit $want, got $got" >&2
    printf '%s\n' "$out" | sed 's/^/  preflight| /' >&2
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

expect 0 '[{"Name":"reprise-api"}]' 'the sandbox app alone passes'
expect 0 '[]' 'an empty org passes'

# The finding itself: a database in the org is reachable over 6PN from inside a
# crude-tier jail, with no escape and no code change.
expect 1 '[{"Name":"reprise-api"},{"Name":"reprise-db"}]' 'a second app refuses'
expect 1 '[{"Name":"reprise-db"}]' 'a peer without the sandbox app refuses'

# Fly renames things and `fly apps list --json` is not a stable contract. An
# unreadable list must refuse rather than pass: a preflight that treats "I could
# not tell" as "all clear" is worse than no preflight, because it is trusted.
expect 2 'not json at all' 'unparseable input refuses'
expect 2 '{"Name":"reprise-api"}' 'a non-array refuses'
expect 2 '[{"id":"reprise-api"}]' 'an array without Name refuses'

if [ "$failures" -gt 0 ]; then
  echo "preflight-org: $failures case(s) failed" >&2
  exit 1
fi
echo "preflight-org: all cases passed"
