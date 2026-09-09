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

ORGS='{"personal":"Melvin Kannan"}'
# The empty forms, copied from what flyctl 0.4.100 actually printed on
# 2026-09-09 rather than guessed -- including the box-drawing separator in the
# redis header and mpg's prose-instead-of-JSON empty case.
REDIS_EMPTY=' NAME │ ORG │ PLAN │ EVICTION │ PRIMARY REGION │ READ REGIONS '
MPG_EMPTY='No managed postgres clusters found in organization personal'
# The real `fly apps list --json` entry shape, trimmed to the fields the check
# reads. Committed so the capital-N `Name` contract is pinned to something.
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

# --- the clear case, which must stay reachable or the guard is just an outage --
envelope "$APP_ONLY" "$REDIS_EMPTY" "$MPG_EMPTY" |
  expect $CLEAR 'the sandbox app alone, no add-ons, passes'
envelope "$APP_ONLY" "$REDIS_EMPTY" '[]' |
  expect $CLEAR 'mpg may answer with an empty array instead of prose'

# --- peers, each of which the apps-only first draft of this guard missed -------
envelope '[{"Name":"reprise-api","Organization":{"Slug":"personal"}},{"Name":"reprise-db","Organization":{"Slug":"personal"}}]' \
  "$REDIS_EMPTY" "$MPG_EMPTY" |
  expect $PEER 'a second container app is a peer'
envelope "$APP_ONLY" \
  "$REDIS_EMPTY"$'\n cache │ personal │ free │ noeviction │ sin │ ' "$MPG_EMPTY" |
  expect $PEER 'an Upstash Redis is a peer, though no app listing shows it'
envelope "$APP_ONLY" "$REDIS_EMPTY" '[{"name":"reprise-pg"}]' |
  expect $PEER 'a Managed Postgres cluster is a peer'

# --- cannot tell. Each of these passed the first draft, which is the point -----
envelope '[]' "$REDIS_EMPTY" "$MPG_EMPTY" |
  expect $REFUSED 'an app listing without the sandbox app proves nothing'
envelope "$APP_ONLY" "$REDIS_EMPTY" "$MPG_EMPTY" '{"other":"Someone Else"}' |
  expect $REFUSED 'a credential that cannot see the org refuses'
envelope '[{"Name":"reprise-api","Organization":{"Slug":"personal"}},{"Name":"old-demo","Organization":{"Slug":"acme"}}]' \
  "$REDIS_EMPTY" "$MPG_EMPTY" |
  expect $REFUSED 'an unscoped cross-org listing refuses instead of accusing'
envelope "$APP_ONLY" ' NAME │ ORG │ TIER ' "$MPG_EMPTY" |
  expect $REFUSED 'a changed redis table header refuses'
envelope "$APP_ONLY" '' "$MPG_EMPTY" |
  expect $REFUSED 'an empty redis listing refuses'
envelope "$APP_ONLY" "$REDIS_EMPTY" 'Some new flyctl wording' |
  expect $REFUSED 'unrecognised mpg output refuses'
envelope 'not-json' "$REDIS_EMPTY" "$MPG_EMPTY" |
  expect $REFUSED 'an unparseable app listing refuses'
envelope '{"Name":"reprise-api"}' "$REDIS_EMPTY" "$MPG_EMPTY" |
  expect $REFUSED 'a non-array app listing refuses'
envelope '[{"id":"reprise-api"}]' "$REDIS_EMPTY" "$MPG_EMPTY" |
  expect $REFUSED 'an app entry without Name refuses'
printf 'not an envelope at all' | expect $REFUSED 'an unparseable envelope refuses'

if [ "$failures" -gt 0 ]; then
  echo "preflight-org: $failures case(s) failed" >&2
  exit 1
fi
echo "preflight-org: all cases passed"
