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
# This half collects; infra/preflight-org-check.mjs decides. Three listings are
# needed rather than one, because `fly apps list` queries `apps(type:
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
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The one app the org may hold while the sandbox tier is crude, and the org it
# lives in. Overridable so a fork or a second environment can run the same guard
# without editing it; neither can widen the check, because both are single
# values and every resource that is not this app in this org counts as a peer.
APP=${REPRISE_FLY_APP:-reprise-api}
ORG=${REPRISE_FLY_ORG:-personal}

if ! command -v fly >/dev/null 2>&1; then
  echo "PREFLIGHT REFUSED: no \`fly\` on PATH, so the org cannot be read." >&2
  exit 2
fi

# Every listing is scoped with --org. `fly apps list` otherwise spans every
# organization the user belongs to ("The list includes applications from all the
# organizations the user is a member of"), which would name apps on unrelated
# private networks as sandbox peers -- a false refusal that teaches an operator
# to stop running the guard.
orgs=$(fly orgs list --json 2>/dev/null)
apps=$(fly apps list --org "$ORG" --json 2>/dev/null)
# Neither of these speaks JSON on the empty path: `fly redis list` has no --json
# flag at all, and `fly mpg list -j` prints a sentence. The checker is written to
# the shapes they actually emit and refuses anything else.
redis=$(fly redis list --org "$ORG" 2>/dev/null)
mpg=$(fly mpg list --org "$ORG" -j 2>/dev/null)

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
