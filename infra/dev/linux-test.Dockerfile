# Linux test target for the sandbox.
#
# The jail is a Linux artifact: macOS does not enforce RLIMIT_AS, so a
# memory-bomb assertion on the dev host passes while the limit silently does
# nothing. Isolation tests only mean something on Linux, which is why CI runs
# them Linux-only and why the local loop goes through this image.
#
# This is NOT the sandbox boundary — the jail inside still spawns processes
# directly (5A: no Docker on the sandbox path). Docker is only supplying the
# Linux host, the same role Fly's microVM plays in production.
FROM node:24-bookworm-slim

# util-linux -> prlimit, which applies rlimits and execs without a shell in the
# middle (no quoting surface). python3 -> the runner + the attack payloads.
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# The unprivileged uid the jail drops into. The container itself stays root
# because dropping privileges requires having them first. The uid is pinned so
# the isolation tests can assert on it exactly, and so RLIMIT_NPROC — which is
# enforced per-uid — is counting a uid that owns nothing else.
RUN groupadd --system --gid 1001 reprise-run \
  && useradd --system --uid 1001 --gid 1001 --no-create-home \
       --shell /usr/sbin/nologin reprise-run

WORKDIR /repo

# Dependency layer first so source edits don't reinstall on every run.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY worker/package.json worker/
COPY api/package.json api/
COPY shared/submission-state/package.json shared/submission-state/
COPY shared/api-error/package.json shared/api-error/
RUN pnpm install --frozen-lockfile

COPY . .

CMD ["pnpm", "-r", "test"]
