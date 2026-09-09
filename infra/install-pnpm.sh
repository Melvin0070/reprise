#!/usr/bin/env sh
#
# Install pnpm into an image, at the version the workspace pins (issue #89).
#
# WHY THIS EXISTS AT ALL. Node 26's official image no longer ships corepack, so
# `corepack enable` exits 127 and the images cannot obtain pnpm at all.
#
# This landed one commit BEFORE the base bumped to 26 (#89 ahead of #66/#67), at
# a point where node:24 still shipped corepack and nothing here was broken yet.
# That ordering is the reason the removal is unconditional rather than guarded:
# it let the two Dependabot PRs rebase onto Dockerfiles that already built, and
# it means no version of this file has ever depended on corepack being present.
# Restoring `corepack enable` on a node 24 base would have passed all three CI
# jobs and broken the instant the base moved -- a failure mode worth
# recognising, because CI could not see it. On the 26 base the tree now pins,
# `corepack enable` fails the `image` and `isolation` jobs outright.
#
# WHY NOT JUST REINSTALL COREPACK. `npm install --global corepack && corepack
# enable` works on node 24 and 26 alike (verified: corepack 0.36.0 installs fine
# on 26, which ships none) and is one line instead of this file, so it is the obvious alternative and
# it was rejected for three reasons:
#   1. Pinning the pinner is circular. corepack exists to pin the package
#      manager, so installing it UNpinned to read a pin is a knot, and pinning
#      it needs a second literal version -- a second place to bump, which is
#      the thing #89 is about.
#   2. corepack's shim downloads pnpm lazily, on first invocation, not at the
#      build step that names it. The image stops being hermetic at the layer
#      that claims to install pnpm, and the download surfaces later inside
#      whatever command happened to run pnpm first.
#   3. corepack is the component the platform just deleted. Building on it again
#      buys the same breakage a second time on some future major.
# What corepack was also doing, and what therefore has to come along, is
# VALIDATION -- see pnpm-version.mjs. It is not optional: an unvalidated read of
# `packageManager` is an install-and-run-anything-as-root channel, measured.
#
# WHY ONE FILE FOR THREE SITES. The builder and runtime stages of
# infra/Dockerfile and infra/dev/linux-test.Dockerfile all run this. The version
# is only pinned in one place if the code reading that place is also in one
# place: three copies of an inline incantation is the same drift moved up a
# level, where a correction has to land three times and a partial one leaves the
# isolation image and the shipped artifact able to resolve different pnpm
# majors -- which would break the one property the isolation suite exists for,
# testing what actually ships.
#
# `sh`, not `bash`: it is invoked as `RUN sh infra/install-pnpm.sh`, nothing here
# needs more than POSIX, and staying POSIX means a base image without bash would
# not break it. (bookworm ships bash 5.2.15 on node 24 and 26 alike, so this is
# a portability choice, not a necessity.)
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)

# The refusal path is the point -- see pnpm-version.mjs. This is an ASSIGNMENT
# rather than an argument, and that is the whole defect this line was rewritten
# to fix: a command substitution in argument position discards its exit status,
# so `npm install --global "pnpm@$(node -p ...)"` installed `pnpm@latest` on a
# green build when the read threw. As the whole right-hand side of an
# assignment the substitution's status IS the command's, so `set -e` stops here.
# infra/install-pnpm.test.sh pins that, because the property is invisible in a
# passing build and lives in one character of structure.
VERSION=$(node "$HERE/pnpm-version.mjs" "${1:-./package.json}")

# --ignore-scripts: nothing in the fetched tarball runs a lifecycle script as
# root during install. pnpm 9.15.9 declares no install scripts, so this costs
# nothing today. It narrows the escalation surface without closing it -- see the
# assertion below.
npm install --global --ignore-scripts "pnpm@$VERSION"

# Assert the version that landed, not the version that was asked for. This
# catches DRIFT -- a spec that resolved to something else, a registry redirect,
# a tag that moved, a later layer clobbering pnpm -- and every build now proves
# that rather than trusting it.
#
# It is worth being exact about what it does NOT catch, because the honest
# boundary is the interesting part: it is a self-report. A tampered tarball whose
# `bin` answers "9.15.9" passes, and running `pnpm --version` at all executes
# that bin as root, so this line is not a containment boundary against an
# attacker who controls the tarball. Provenance is #91's job (integrity-pin the
# fetch); this is a correctness check against accident.
GOT=$(pnpm --version)
if [ "$GOT" != "$VERSION" ]; then
  echo "install-pnpm: installed pnpm $GOT but package.json pins $VERSION" >&2
  exit 1
fi

echo "install-pnpm: pnpm $VERSION, matching the packageManager pin"
