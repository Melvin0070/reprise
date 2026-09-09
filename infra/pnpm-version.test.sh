#!/usr/bin/env bash
#
# Self-test for the pnpm pin resolver (issue #89).
#
# The resolver's job is almost entirely refusal, so the refusals outnumber the
# passes here deliberately. Two of these cases are the measured defects that put
# this file in the repo at all -- `pnpm@` installing `latest` on a green build,
# and `pnpm@npm:...`/URL specs reaching `npm install` as root -- and both are
# pinned so a future simplification back to an inline `node -p` turns this red.
#
# Needs no network and no Docker: the resolver reads a manifest and prints a
# version, which is exactly why the decision was split out of the install.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK="$HERE/pnpm-version.mjs"

OK=0
REFUSED=1

failures=0

# A fixture directory this suite owns. `mktemp` failing has to be fatal rather
# than leaving WORK empty: an unset WORK turns every fixture path into an
# absolute one that does not exist, and a refusal case handed a missing file
# passes for the wrong reason. That is not hypothetical -- it happened on the
# first run of this file, and it is why `manifest` and `expect_refused` below
# both assert the fixture is real.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pnpm-version-test.XXXXXX") || {
  echo "FAIL: cannot create a fixture directory, so no case below would mean anything" >&2
  exit 1
}
trap 'rm -rf "$WORK"' EXIT

# manifest <packageManager-json-value> -> path to a package.json carrying it.
# The value is spliced in as raw JSON so a case can pin a non-string too.
manifest() {
  local file="$WORK/package.json"
  if ! printf '{"name":"fixture","packageManager":%s}\n' "$1" >"$file"; then
    echo "FAIL: cannot write the fixture $file" >&2
    exit 1
  fi
  printf '%s' "$file"
}

# expect_ok <want-version> <name> <manifest-path>
#
# Asserts the exit status AND that stdout is exactly the version. The second
# half is load-bearing: the caller reads this through a command substitution, so
# a diagnostic accidentally written to stdout, or a trailing newline inside the
# value, would be spliced into an `npm install` spec.
expect_ok() {
  local want=$1 name=$2 path=$3 out got
  out=$(node "$CHECK" "$path" 2>/dev/null)
  got=$?
  if [ "$got" != "$OK" ]; then
    echo "FAIL: $name — wanted exit $OK, got $got" >&2
    failures=$((failures + 1))
  elif [ "$out" != "$want" ]; then
    echo "FAIL: $name — wanted stdout '$want', got '$out'" >&2
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

# expect_refused <name> <manifest-path>
#
# Asserts exit 1 and that nothing reached stdout — a refusal that still printed
# something would be interpolated into the install spec by the caller.
expect_refused() {
  local name=$1 path=$2 out got
  # A refusal case must refuse for the reason it names. Handed a path that does
  # not exist it would refuse on the unreadable-manifest branch instead and pass
  # while proving nothing, so the fixture is asserted first. The two cases that
  # deliberately test unreadable input call the resolver directly below.
  if [ ! -f "$path" ]; then
    echo "FAIL: $name — fixture '$path' does not exist, so this case proves nothing" >&2
    failures=$((failures + 1))
    return
  fi
  out=$(node "$CHECK" "$path" 2>/dev/null)
  got=$?
  if [ "$got" != "$REFUSED" ]; then
    echo "FAIL: $name — wanted exit $REFUSED, got $got (stdout: '$out')" >&2
    failures=$((failures + 1))
  elif [ -n "$out" ]; then
    echo "FAIL: $name — refused but wrote '$out' to stdout" >&2
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

# A suite is only worth its CI slot if a wrong resolver turns it red, and that is
# a property of this file, not of the resolver. Same reasoning and same shape as
# infra/preflight-org.test.sh, which grew this guard after its own harness was
# found unable to fail.
harness_self_check() {
  local before=$failures
  # A version no fixture uses, so this canary fails on any input and stays
  # decoupled from what the resolver actually does.
  expect_ok '0.0.0-canary' 'CANARY, expected to fail' "$(manifest '"pnpm@9.15.9"')" 2>/dev/null
  if [ "$failures" -le "$before" ]; then
    echo "FAIL: the harness cannot detect a failing case, so every result below is meaningless" >&2
    exit 1
  fi
  failures=$before
  echo "ok: the harness fails when a case fails"
}
harness_self_check

# --- the usable case, which must stay reachable or the guard is just an outage --
expect_ok '9.15.9' 'the pin the repo actually declares resolves' \
  "$(manifest '"pnpm@9.15.9"')"
expect_ok '10.0.0-beta.1' 'a prerelease pin resolves' \
  "$(manifest '"pnpm@10.0.0-beta.1"')"
# Reads the real manifest, and the expected value is hardcoded on purpose: a
# `packageManager` bump has to be acknowledged here. The failure message on a
# legitimate bump reads "wanted stdout '9.15.9', got '10.x'", which looks like a
# resolver bug and is not -- it is this line asking to be updated alongside the
# pin.
expect_ok '9.15.9' 'the real root package.json resolves' "$HERE/../package.json"

# --- the measured defects. These two are why this file exists -------------------
# `node -p ... .replace(/^pnpm@/,'')` yielded '' here, and `npm install --global
# "pnpm@"` installs latest: npm-package-arg normalises an empty spec to `*`.
# Measured as a green `docker build -q` shipping pnpm 12.3.4 against a 9.15.9 pin.
expect_refused 'an empty version refuses instead of resolving to latest' \
  "$(manifest '"pnpm@"')"
# npm accepts an alias spec, so this installed an arbitrary package as the pnpm
# binary; its postinstall then ran as uid 0 during the image build.
expect_refused 'an npm: alias spec refuses' \
  "$(manifest '"pnpm@npm:left-pad@1.3.0"')"

# --- everything else npm would happily accept as a spec ------------------------
expect_refused 'an https tarball URL refuses' \
  "$(manifest '"pnpm@https://evil.example/pnpm.tgz"')"
expect_refused 'a file: path refuses' \
  "$(manifest '"pnpm@file:/tmp/evil.tgz"')"
expect_refused 'a git URL refuses' \
  "$(manifest '"pnpm@git+https://evil.example/pnpm.git"')"
expect_refused 'a dist-tag refuses' "$(manifest '"pnpm@latest"')"
expect_refused 'a caret range refuses' "$(manifest '"pnpm@^9.15.9"')"
expect_refused 'a major-only version refuses' "$(manifest '"pnpm@9"')"
expect_refused 'a major.minor version refuses' "$(manifest '"pnpm@9.15"')"

# The canonical form `corepack use` writes. npm reads `+sha512...` as semver
# build metadata and drops it, installing 9.15.9 with the hash never checked --
# measured against a registry serving a tampered tarball. Refusing keeps the
# manifest from advertising an integrity pin nothing honours (#91).
expect_refused 'an integrity-pinned spec refuses rather than ignoring the hash' \
  "$(manifest '"pnpm@9.15.9+sha512.deadbeef"')"

# --- a different package manager, or no pin at all -----------------------------
expect_refused 'yarn refuses, rather than becoming pnpm@4.5.0' \
  "$(manifest '"yarn@4.5.0"')"
expect_refused 'npm refuses' "$(manifest '"npm@10.9.0"')"
expect_refused 'a bare version with no package name refuses' \
  "$(manifest '"9.15.9"')"
expect_refused 'an empty string refuses' "$(manifest '""')"
expect_refused 'a null packageManager refuses' "$(manifest 'null')"
expect_refused 'a non-string packageManager refuses' "$(manifest '{"pnpm":"9.15.9"}')"
printf '{"name":"fixture"}\n' >"$WORK/none.json"
expect_refused 'a manifest with no packageManager refuses' "$WORK/none.json"

# --- the anchors. Each of these passes an unanchored regex ----------------------
expect_refused 'a leading space refuses' "$(manifest '" pnpm@9.15.9"')"
expect_refused 'a trailing newline refuses, so it cannot corrupt the spec' \
  "$(manifest '"pnpm@9.15.9\n"')"
expect_refused 'a suffix after the version refuses' \
  "$(manifest '"pnpm@9.15.9-then-anything/else"')"
expect_refused 'a prefix before the name refuses' \
  "$(manifest '"@scope/pnpm@9.15.9"')"

# --- unreadable input, which cannot use expect_refused's fixture assertion -----
printf 'not json at all\n' >"$WORK/bad.json"
expect_refused 'an unparseable manifest refuses' "$WORK/bad.json"

# The one case whose fixture is deliberately absent, so it asserts inline.
if node "$CHECK" "$WORK/does-not-exist.json" >/dev/null 2>&1; then
  echo "FAIL: a missing manifest was accepted" >&2
  failures=$((failures + 1))
else
  echo "ok: a missing manifest refuses"
fi

if [ "$failures" -gt 0 ]; then
  echo "pnpm-version: $failures case(s) failed" >&2
  exit 1
fi
echo "pnpm-version: all cases passed"
