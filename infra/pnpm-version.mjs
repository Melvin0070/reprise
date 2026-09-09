#!/usr/bin/env node
//
// Resolve the pnpm version the images must install, from the one place that
// declares it (issue #89).
//
// Node 26's image dropped corepack. infra/install-pnpm.sh's header carries why
// corepack was replaced rather than reinstalled from npm, and why the removal
// landed a commit ahead of the base bump rather than with it.
//
// This exists as a separate decision step, testable without installing
// anything, for the same reason `preflight-org-check.mjs` does: the interesting
// half is which inputs it REFUSES, and a guard whose refusals are untested is
// a guard that fails open.
//
// It fails open in one specific way if written inline, which is how it was
// written first and why this file exists. The obvious form is
//
//   npm install --global "pnpm@$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '')")"
//
// and it has two holes, both measured rather than reasoned about:
//
//   1. A command substitution in argument position discards its exit status.
//      Delete `packageManager` and `node -p` throws, the substitution yields
//      the empty string, and `npm install --global "pnpm@"` installs `latest`
//      -- npm-package-arg normalises an empty spec to `*`. Measured: a green
//      `docker build -q` producing an image on pnpm 12.3.4 instead of 9.15.9,
//      with the TypeError swallowed because every build path here passes `-q`.
//   2. `npm install` accepts far more than a semver. `pnpm@npm:evil@1.0.0`,
//      `pnpm@https://host/x.tgz` and `pnpm@file:/tmp/x.tgz` are all valid
//      specs, so the field decides which tarball runs as root at image build.
//      Measured: a payload's postinstall executing as uid 0, and a `bin.pnpm`
//      shim executing as root on the following `pnpm install` line.
//
// `corepack enable` refused both -- its `parseSpec` requires `semver.valid()`
// and rejects URLs for a known package manager. Dropping corepack therefore
// has to bring its parsing along, or the crude tier's only filesystem boundary
// (non-root perms) is one manifest token away from being nothing. That is what
// this file is: corepack's validation, kept, without corepack.
//
// Prints the bare version on stdout and nothing else, so a caller can read it
// with a command substitution. Diagnostics go to stderr. Exit 0 = usable
// version printed; exit 1 = refused, and the caller must not install anything.

import { readFileSync } from "node:fs";

const REFUSED = 1;

// Exactly `pnpm`, then a strict semver with an optional prerelease. Anchored at
// both ends, so nothing that is also a valid npm spec -- an `npm:` alias, a URL,
// a `file:` path, a dist-tag, a range -- can reach `npm install`.
//
// A prerelease is accepted (`pnpm@10.0.0-beta.1`). Nothing in the repo pins one
// today; it is allowed because it is still a published version of the `pnpm`
// package, so it widens WHICH pnpm can be installed without widening WHAT can
// be installed -- no other tarball becomes reachable. The strictness that
// matters is the package name and the absence of a spec syntax, not the shape
// of the version.
//
// Build metadata (`+sha512.<hex>`) is deliberately NOT accepted. It is the
// canonical form `corepack use` writes, and npm reads it as semver build
// metadata and silently drops it: `pnpm@9.15.9+sha512.deadbeef` installs 9.15.9
// with the hash unchecked (measured, against a registry serving a tampered
// tarball whose self-consistent integrity npm accepted and corepack rejected).
// Accepting it here would mean the manifest advertises an integrity pin that no
// build step honours, which is worse than not having one. Refusing keeps the
// property honest, loudly, until #91 makes the hash actually load-bearing.
const PIN = /^pnpm@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

const refuse = (why) => {
  process.stderr.write(`pnpm-version: refusing to install pnpm -- ${why}\n`);
  process.exit(REFUSED);
};

const path = process.argv[2] ?? "./package.json";

let manifest;
try {
  manifest = JSON.parse(readFileSync(path, "utf-8"));
} catch (error) {
  refuse(`cannot read ${path} as JSON (${error.message})`);
}

const declared = manifest?.packageManager;

if (typeof declared !== "string" || declared.length === 0) {
  refuse(
    `${path} declares no "packageManager". That field IS the pin; without it ` +
      "there is no version to install and the build must stop rather than " +
      "choose one."
  );
}

const matched = PIN.exec(declared);

if (matched === null) {
  refuse(
    `"packageManager": ${JSON.stringify(declared)} is not pnpm at a plain ` +
      'semver. Expected exactly "pnpm@<major>.<minor>.<patch>". Anything ' +
      "else -- another package manager, a range, a dist-tag, an npm: alias, " +
      "a URL, a file: path, or a +sha512 integrity suffix -- is refused " +
      "because npm would accept it as a package spec and install it."
  );
}

// No `process.exit()` here. Exiting immediately after a write truncates it at
// the pipe buffer -- measured at exactly 65536 bytes through the command
// substitution install-pnpm.sh reads this with. It needs an absurd manifest to
// reach, and it fails closed when it does, but letting node exit on its own
// after the stream drains removes the class rather than reasoning about it.
process.stdout.write(matched.groups.version);
