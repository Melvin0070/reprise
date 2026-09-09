#!/usr/bin/env bash
#
# Refuse to deploy while the Fly organization holds anything but the sandbox app
# (issue #79). Run it before every `fly deploy`, as `pnpm preflight:org`.
#
# Fly puts everything in an organization on one shared private IPv6 network
# (6PN). A jailed process resolves `_apps.internal` against Fly's resolver at
# `[fdaa::3]:53` and opens TCP to any `fdaa::/16` peer it gets back. That needs
# no container escape and no kernel bug -- network exfil, which
# docs/threat-model.md lists as NOT STOPPED at the crude tier, is sufficient. So
# the blast radius of the sandbox is the whole organization, and the day a
# Postgres or Redis exists beside it, OV-10's "a worker can never reach the data
# layer" stops being true with no code change and nothing appearing to break.
#
# The real fix is a dedicated network (`fly apps create --network`), which means
# destroying and recreating `reprise-api` -- infrastructure Melvin owns and pays
# for, so it is his call, tracked in issue #88. Until then the constraint is that
# the org stays a population of one, and this is that constraint with an exit
# code instead of a promise.
#
# This half collects; infra/preflight-org-check.mjs decides. Three resource
# listings are needed rather than one (plus `fly orgs list`, which checks the
# credential rather than the org's contents), because `fly apps list` queries
# `apps(type:
# "container")` and managed add-ons are not container apps: Upstash Redis lives
# under a different GraphQL root field entirely and Managed Postgres under a
# different API. Both sit on 6PN. An apps-only check would have certified an org
# holding a reachable database as clear.
#
# Note what this is NOT. It is advisory: it fires when someone runs it, so a
# `fly redis create` typed at a terminal is caught on the next deploy, not at
# the moment of provisioning. It does nothing about 6PN itself -- the sandbox can
# still reach `fdaa::/16`; the point is that nothing is there. And it is bounded
# by the credential it runs under, which is why it refuses unless that credential
# can see the org (see the `fly orgs list` step below).
# `set -e` is deliberately absent, and it is load-bearing. With it, the
# `out=$(fly "$@" ...)` in run_fly would abort the shell before `rc=$?` runs,
# making the whole quote-flyctl's-own-error path below dead code -- the failure
# would be silent again, which is the bug that path exists to fix.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)

# The app under scrutiny is read out of fly.toml, never from the environment.
# `fly deploy` takes its target from that file, so anything else here would let
# the guard certify an org the deploy will never touch -- and it would do it
# quietly, in the one direction that matters. An env override was tried and
# removed for exactly that reason.
# Matches the exact spelling fly emits, which fly.toml's own header pins ("DO
# NOT re-run `fly launch` ... Formatting here matches what fly emits"). `head -1`
# is safe for a stronger reason than first-wins: TOML requires bare top-level
# keys to precede the first table header, so the first `^app =` is always the
# top-level one, and a fly.toml with no top-level `app` fails `fly deploy` too.
APP=$(sed -n "s/^app = '\([^']*\)'.*/\1/p" "$ROOT/fly.toml" | head -1)
if [ -z "$APP" ]; then
  echo "PREFLIGHT REFUSED: no \`app\` line in fly.toml, so there is no deploy" >&2
  echo "  target to check the organization against." >&2
  exit 2
fi

# The org is stated, not discovered -- deliberately, and not because flyctl
# cannot tell us: an unscoped `fly apps list --json` carries `Organization.Slug`
# on every entry, so deriving it is possible. Deriving it would mean auditing
# whatever org flyctl says the app is in, which is the question answering
# itself. Stating it lets the guard report "you asked about X and I checked X".
#
# A wrong value fails CLOSED rather than open: Fly app names are globally
# unique, so `$APP` will not appear in another org's listing and the checker
# refuses on the missing app. The success line prints both values so what was
# actually checked is never in doubt.
ORG=${REPRISE_FLY_ORG:-personal}

if ! command -v fly >/dev/null 2>&1; then
  echo "PREFLIGHT REFUSED: no \`fly\` on PATH, so the org cannot be read." >&2
  exit 2
fi

# flyctl's own diagnosis is kept, not discarded. An expired session is a routine
# event, and swallowing stderr made it surface as "was not an object" -- which
# reads as flyctl format drift, teaches the operator that the guard is stale
# rather than that they need to log in, and invites them to deploy without it.
# Three of the checker's refusals really are about format drift, so the two must
# not be confusable.
run_fly() {
  local what=$1
  shift
  local out err rc
  err=$(mktemp)
  out=$(fly "$@" 2>"$err")
  rc=$?
  if [ "$rc" != 0 ]; then
    echo "PREFLIGHT REFUSED: \`fly $*\` failed (exit $rc), so the $what could" >&2
    echo "  not be read. This is flyctl talking, not a format change:" >&2
    sed 's/^/    fly| /' "$err" >&2
    rm -f "$err"
    # `return`, not `exit`: every caller is a command substitution, which is a
    # subshell, so an exit here would kill only that subshell and let the script
    # run all four listings and then refuse for the wrong reason. The `|| exit`
    # at each call site is what actually stops it.
    return 2
  fi
  rm -f "$err"
  printf '%s' "$out"
}

# `fly orgs list` takes no --org (there is no flag for it): it is the listing
# that establishes the credential can see "$ORG" at all, which is what catches
# an app-scoped deploy token whose view of an org is indistinguishable from an
# empty one. The other three are scoped, because `fly apps list` otherwise spans
# every organization the user belongs to.
orgs=$(run_fly "organization list" orgs list --json) || exit 2
apps=$(run_fly "app listing" apps list --org "$ORG" --json) || exit 2
# Neither of these speaks JSON on the empty path: `fly redis list` has no --json
# flag at all, and `fly mpg list -j` prints a sentence. The checker is written to
# the shapes they actually emit and refuses anything else.
redis=$(run_fly "Upstash Redis listing" redis list --org "$ORG") || exit 2
# `fly mpg` rejects older-style Fly tokens outright, so a stale credential makes
# this refuse every time rather than intermittently. That is the right direction
# -- but a guard that always refuses is a guard that gets skipped, which is the
# failure this whole slice exists to prevent. If it starts refusing here, the fix
# is `fly auth login`, not deleting the step.
mpg=$(run_fly "Managed Postgres listing" mpg list --org "$ORG" -j) || exit 2

# Assembled by node rather than by string interpolation so that CLI output
# containing a quote or a backslash cannot forge envelope structure.
ORG="$ORG" APP="$APP" ORGS="$orgs" APPS="$apps" REDIS="$redis" MPG="$mpg" \
  node -e '
    const env = process.env;
    const parse = (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    process.stdout.write(
      JSON.stringify({
        org: env.ORG,
        app: env.APP,
        orgs: parse(env.ORGS),
        apps: parse(env.APPS),
        redis: env.REDIS,
        mpg: env.MPG,
      })
    );
  ' | node "$HERE/preflight-org-check.mjs"
