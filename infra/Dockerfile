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
FROM node:24-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app

# Manifests first, so editing a source file does not reinstall dependencies.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY shared/submission-state/package.json shared/submission-state/
COPY shared/api-error/package.json shared/api-error/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime

# util-linux -> prlimit (applies the rlimits and execs the runner with no shell
# in between); python3 -> the only v1.0 runtime (OV-2, stdlib-only). Nothing
# else is added: a small userland is the point of the crude tier's image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

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
