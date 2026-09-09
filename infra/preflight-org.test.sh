#!/usr/bin/env bash
#
# Self-test for the 6PN deploy preflight's decision half (issue #79).
#
# The guard needs to be right in three directions, not two: a clean org deploys,
# a populated org stops the deploy, and an org it cannot actually see stops the
# deploy as well. That third direction is the one a guard usually gets wrong,
# because the failure looks like success -- so the refusals below outnumber the
# passes deliberately, and every case asserts the exit code rather than the
# message.
#
# Reads no network and no Fly credentials: preflight-org-check.mjs takes its
# listings on stdin precisely so this can run anywhere.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK="$HERE/preflight-org-check.mjs"

CLEAR=0
PEER=1
REFUSED=2

failures=0

# The empty forms, copied from what flyctl 0.4.100 actually printed against the
# live org on 2026-09-09 rather than guessed -- including the box-drawing
# separator in the redis header and mpg's prose-instead-of-JSON empty case.
ORGS='{"personal":"Melvin Kannan"}'
REDIS_EMPTY=' NAME │ ORG │ PLAN │ EVICTION │ PRIMARY REGION │ READ REGIONS '
MPG_EMPTY='No managed postgres clusters found in organization personal'
# A real `fly apps list --json` entry, trimmed to the fields the check reads.
# Committed so the capital-N `Name` contract is pinned to something. The fields
# dropped include `Network`/`NetworkID`, which are what turn this from an
# inventory check into a real network check once #88 lands.
APP_ONLY='[{"Name":"reprise-api","Status":"deployed","Organization":{"Slug":"personal"}}]'

# envelope <apps-json> <redis-text> <mpg-text> [orgs-json]
envelope() {
  APPS="$1" REDIS="$2" MPG="$3" ORGS="${4:-$ORGS}" node -e '
    const env = process.env;
    const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
    process.stdout.write(JSON.stringify({
      org: "personal", app: "reprise-api",
      orgs: parse(env.ORGS), apps: parse(env.APPS),
      redis: env.REDIS, mpg: env.MPG,
    }));
  '
}

# Runs the check over stdin, asserting exit status $1. $2 names the case.
#
# Callers pass the envelope on a here-string, never through a pipe. A pipeline
# runs every stage in a subshell, so a `failures` increment here would be lost
# in the parent and the suite would report success no matter how many cases
# failed -- which is exactly what it did until the review gate mutated the
# checker to certify every input as clear and watched 13 cases print FAIL under
# a green exit 0. `harness_self_check` below is the standing guard against it.
expect() {
  local want=$1 name=$2 out got
  out=$(node "$CHECK" 2>&1)
  got=$?
  if [ "$got" != "$want" ]; then
    echo "FAIL: $name — wanted exit $want, got $got" >&2
    printf '%s\n' "$out" | sed 's/^/  check| /' >&2
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

# This suite is only worth its CI slot if a wrong checker turns it red, and that
# is a property of this file rather than of the checker. So assert it directly:
# drive one deliberately wrong expectation, confirm the counter moved, put it
# back. A self-test whose own failure path is untested is what produced the bug
# this function exists to prevent.
# The regress stops here on purpose, and not arbitrarily: this function is not
# an instance of the pattern that failed. It reads the counter directly with
# `[ -le ]` and calls `exit 1` itself, with no helper and no pipeline in
# between, and both of its failure directions are loud.
harness_self_check() {
  local before=$failures
  # 99 is unreachable -- the checker only ever exits 0, 1 or 2 -- so this canary
  # fails on any input and stays decoupled from what the checker actually does.
  # An input that a real case also uses would make a checker regression surface
  # here as "the harness is broken", masking the case that names the real
  # defect.
  expect 99 'CANARY, expected to fail' <<<'{}' 2>/dev/null
  if [ "$failures" -le "$before" ]; then
    echo "FAIL: the harness cannot detect a failing case, so every result below is meaningless" >&2
    exit 1
  fi
  failures=$before
  echo "ok: the harness fails when a case fails"
}
harness_self_check

# --- the clear case, which must stay reachable or the guard is just an outage --
expect $CLEAR 'the sandbox app alone, no add-ons, passes' \
  <<<"$(envelope "$APP_ONLY" "$REDIS_EMPTY" "$MPG_EMPTY")"
expect $CLEAR 'mpg may answer with an empty array instead of prose' \
  <<<"$(envelope "$APP_ONLY" "$REDIS_EMPTY" '[]')"

# --- peers, each of which the apps-only first draft of this guard missed -------
expect $PEER 'a second container app is a peer' \
  <<<"$(envelope '[{"Name":"reprise-api","Organization":{"Slug":"personal"}},{"Name":"reprise-db","Organization":{"Slug":"personal"}}]' "$REDIS_EMPTY" "$MPG_EMPTY")"
expect $PEER 'an Upstash Redis is a peer, though no app listing shows it' \
  <<<"$(envelope "$APP_ONLY" "$REDIS_EMPTY"$'\n cache │ personal │ free │ noeviction │ sin │ ' "$MPG_EMPTY")"
expect $PEER 'a Managed Postgres cluster is a peer' \
  <<<"$(envelope "$APP_ONLY" "$REDIS_EMPTY" '[{"name":"reprise-pg"}]')"

# --- cannot tell. Each of these passed the first draft, which is the point -----
expect $REFUSED 'an app listing without the sandbox app proves nothing' \
  <<<"$(envelope '[]' "$REDIS_EMPTY" "$MPG_EMPTY")"
expect $REFUSED 'a credential that cannot see the org refuses' \
  <<<"$(envelope "$APP_ONLY" "$REDIS_EMPTY" "$MPG_EMPTY" '{"other":"Someone Else"}')"
expect $REFUSED 'an unscoped cross-org listing refuses instead of accusing' \
  <<<"$(envelope '[{"Name":"reprise-api","Organization":{"Slug":"personal"}},{"Name":"old-demo","Organization":{"Slug":"acme"}}]' "$REDIS_EMPTY" "$MPG_EMPTY")"
expect $REFUSED 'an app entry with no Organization refuses, so the scope recheck cannot no-op' \
  <<<"$(envelope '[{"Name":"reprise-api"}]' "$REDIS_EMPTY" "$MPG_EMPTY")"
expect $REFUSED 'a changed redis table header refuses' \
  <<<"$(envelope "$APP_ONLY" ' NAME │ ORG │ TIER ' "$MPG_EMPTY")"
expect $REFUSED 'an empty redis listing refuses' \
  <<<"$(envelope "$APP_ONLY" '' "$MPG_EMPTY")"
expect $REFUSED 'unrecognised mpg output refuses' \
  <<<"$(envelope "$APP_ONLY" "$REDIS_EMPTY" 'Some new flyctl wording')"
expect $REFUSED 'mpg answering about a different org proves nothing about this one' \
  <<<"$(envelope "$APP_ONLY" "$REDIS_EMPTY" 'No managed postgres clusters found in organization acme')"
expect $REFUSED 'the empty mpg sentence with a cluster list after it refuses' \
  <<<"$(envelope "$APP_ONLY" "$REDIS_EMPTY" "$MPG_EMPTY"$'\n[{"name":"pg"}]')"
expect $REFUSED 'an unparseable app listing refuses' \
  <<<"$(envelope 'not-json' "$REDIS_EMPTY" "$MPG_EMPTY")"
expect $REFUSED 'a non-array app listing refuses' \
  <<<"$(envelope '{"Name":"reprise-api"}' "$REDIS_EMPTY" "$MPG_EMPTY")"
expect $REFUSED 'an app entry without Name refuses' \
  <<<"$(envelope '[{"id":"reprise-api"}]' "$REDIS_EMPTY" "$MPG_EMPTY")"
expect $REFUSED 'an unparseable envelope refuses' <<<'not an envelope at all'

if [ "$failures" -gt 0 ]; then
  echo "preflight-org: $failures case(s) failed" >&2
  exit 1
fi
echo "preflight-org: all cases passed"
