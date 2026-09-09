# syntax=docker/dockerfile:1

# Production image for the Reprise API (issue #4).
#
# Two stages: a builder that compiles the TypeScript workspace to `dist`, and a
# lean runtime that ships only the built output and production dependencies.
#
# The runtime carries the jail's userland — util-linux's `prlimit` and
# `python3` — and a pinned unprivileged account, because v0.1 runs the sandbox
# inline in this process (a budgeted downgrade; the worker split is later) and
# must drop to that uid per run. The process itself stays root: dropping a
# privilege requires holding it first, the same reason as
# `infra/dev/linux-test.Dockerfile`. On the Fly microVM target that root is
# confined to the VM, which is the isolation boundary OV-10 relies on.

# ---- builder ----
FROM node:26-bookworm-slim AS builder
WORKDIR /app

# Manifests first, so editing a source file does not reinstall dependencies.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY shared/submission-state/package.json shared/submission-state/
COPY shared/api-error/package.json shared/api-error/

# pnpm, at the version `packageManager` pins (#89).
#
# corepack used to supply pnpm here and the base above no longer ships it.
# `infra/install-pnpm.sh` carries the why, including why corepack was not simply
# reinstalled from npm, why this landed a commit ahead of the bump to 26, and the
# validation it has to bring along: an unvalidated read of this field installs
# and runs anything as root at build time, measured rather than theorised.
#
# It runs after the manifests land because package.json IS the version source.
# The cost is a pnpm re-fetch whenever any manifest changes, where `corepack
# enable` sat above these COPYs and cached forever. A cheaper ordering exists --
# COPY the root manifest, install pnpm, then COPY the rest, since only the root
# manifest carries `packageManager` -- and is not taken: it splits one readable
# COPY block in two to save an npm install on local rebuilds, and CI builds cold
# every time, so it buys nothing where it counts.
COPY infra/install-pnpm.sh infra/pnpm-version.mjs infra/
RUN sh infra/install-pnpm.sh
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---- runtime ----
FROM node:26-bookworm-slim AS runtime

# util-linux -> prlimit (applies the rlimits and execs the runner with no shell
# in between); python3 -> the only v1.0 runtime (OV-2, stdlib-only). util-linux
# is Debian-essential, so `prlimit` is in the bare base already and this line
# does not put it there -- it declares the dependency, so a base that ever
# stopped supplying it would fail here rather than at the first jailed run.
#
# A small
# userland is the point of the crude tier's image, so nothing else is apt-
# installed.
#
# Not "nothing else is added", though: the pnpm below ships in this image, where
# uid 1001 can read and execute it. That is a real fact about the artifact and
# not a capability change -- this is the `node` base image, so /usr/local/bin's
# node and npm already do everything pnpm can, and at the crude tier there is no
# egress containment at all, which is why execution is key-gated (OV-1) and the
# image is never public. What did change: pnpm used to sit in root's corepack
# cache under /root (0700, unreachable by 1001) and now sits world-readable in
# /usr/local/lib/node_modules. The two infra/ files COPY'd below ship as well,
# and the smoke check depends on their being here; both are root-owned and not
# writable by 1001, and running the installer as 1001 fails on /usr/local/lib.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 util-linux \
  && rm -rf /var/lib/apt/lists/*

# The unprivileged identity submitted code runs as. The uid is pinned to match
# what the deploy passes in and what the isolation image asserts, and so
# RLIMIT_NPROC — enforced per-uid — counts a uid that owns nothing else.
RUN groupadd --system --gid 1001 reprise-run \
  && useradd --system --uid 1001 --gid 1001 --no-create-home \
       --shell /usr/sbin/nologin reprise-run

WORKDIR /app

# Production dependencies only: the compiled server needs @nestjs/*, express,
# zod and reflect-metadata, but none of the test or build toolchain.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY shared/submission-state/package.json shared/submission-state/
COPY shared/api-error/package.json shared/api-error/

# The runtime stage installs pnpm separately, because build stages share no
# filesystem -- same script and same pin, so the two cannot diverge.
COPY infra/install-pnpm.sh infra/pnpm-version.mjs infra/
RUN sh infra/install-pnpm.sh
RUN pnpm install --prod --frozen-lockfile

# The compiled workspace. Each package resolves to its `dist` here because the
# runtime sets no `development` export condition (see the package `exports`).
COPY --from=builder /app/api/dist api/dist
COPY --from=builder /app/worker/dist worker/dist
COPY --from=builder /app/shared/api-error/dist shared/api-error/dist
COPY --from=builder /app/shared/submission-state/dist shared/submission-state/dist

# The runner identity is read at boot; naming it here documents the contract
# and matches the account created above.
#
# A deploy may override it, but only with another DEDICATED account that owns
# nothing else. The jail reaps by uid (#78), so pointing this at a shared
# account — `www-data` on a root VPS is the easy mistake — makes one timing-out
# submission SIGKILL every process that account owns. `runInJail` refuses to
# spawn when the uid is not clean, so the misconfiguration stops the instance
# instead of the host.
ENV NODE_ENV=production \
    PORT=3000 \
    REPRISE_RUN_UID=1001 \
    REPRISE_RUN_GID=1001
EXPOSE 3000

# REPRISE_API_KEY is deliberately NOT baked in: the server refuses to boot
# without it (OV-1), so a keyless image fails loudly instead of deploying an
# open code-execution endpoint. The deploy supplies it as a secret.
CMD ["node", "api/dist/main.js"]
