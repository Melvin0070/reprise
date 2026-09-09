#!/usr/bin/env bash
#
# Refuse to deploy while the Fly organization holds a second app (issue #79).
#
# Fly puts every app in an organization on one shared private IPv6 network
# (6PN). A jailed process resolves `_apps.internal` against Fly's resolver at
# `[fdaa::3]:53` and opens TCP to any `fdaa::/16` peer it gets back. That needs
# no container escape and no kernel bug — network exfil, which docs/threat-model.md
# already lists as NOT STOPPED at the crude tier, is sufficient. So the blast
# radius of the sandbox is the whole organization, and the day a Fly Postgres or
# Redis exists beside it, OV-10's "a worker can never reach the data layer" stops
# being true with no code change and nothing appearing to break.
#
# The real fix is a dedicated network (`fly apps create --network`), which means
# destroying and recreating `reprise-api` — infrastructure Melvin owns and pays
# for, so it is his call and is tracked separately. Until then the constraint is
# that the org stays a population of one, and this is that constraint with an
# exit code instead of a promise.
#
# Usage — before every `fly deploy`:
#
#   fly apps list --json | bash infra/preflight-org.sh
#
# Input is `fly apps list --json` on stdin rather than a `fly` call inside this
# script, so the decision is testable with no org and no credentials
# (infra/preflight-org.test.sh). Exit 0 clear, 1 refused, 2 unreadable input.
set -uo pipefail

# The one app the org is allowed to hold while the sandbox tier is crude.
SANDBOX_APP=${REPRISE_FLY_APP:-reprise-api}

# Parsing in node, not jq: node is already a hard requirement of this repo and
# jq is not, so the preflight has no dependency the deploy does not already have.
peers=$(SANDBOX_APP="$SANDBOX_APP" node -e '
  let raw = "";
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    let apps;
    try {
      apps = JSON.parse(raw);
    } catch {
      process.exit(2);
    }
    // `fly apps list --json` is not a stable contract. Anything that is not the
    // shape we know exits 2, because a guard that reads "I could not tell" as
    // "all clear" is worse than no guard: it is trusted.
    if (!Array.isArray(apps)) process.exit(2);
    if (!apps.every((a) => a && typeof a.Name === "string")) process.exit(2);
    const peers = apps
      .map((a) => a.Name)
      .filter((name) => name !== process.env.SANDBOX_APP);
    if (peers.length > 0) {
      process.stdout.write(peers.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
')
status=$?

if [ "$status" = 2 ]; then
  echo "PREFLIGHT FAIL: could not read \`fly apps list --json\` from stdin." >&2
  echo "  Refusing rather than assuming the org is clear. Check the fly CLI output shape." >&2
  exit 2
fi

if [ "$status" = 1 ]; then
  echo "PREFLIGHT FAIL: the Fly org holds an app beside $SANDBOX_APP:" >&2
  printf '%s\n' "$peers" | sed 's/^/  - /' >&2
  echo >&2
  echo "  Every app in a Fly org shares one private network (6PN), so each of these is" >&2
  echo "  reachable from inside the crude-tier sandbox with no escape required. Either" >&2
  echo "  move the sandbox to a dedicated network (\`fly apps create --network\`) or" >&2
  echo "  remove these apps before deploying. See issue #79 and docs/threat-model.md." >&2
  exit 1
fi

if [ "$status" != 0 ]; then
  echo "PREFLIGHT FAIL: the org check exited $status." >&2
  exit 2
fi

echo "preflight ok: $SANDBOX_APP is alone in the org; the 6PN blast radius is one machine."
