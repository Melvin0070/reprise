#!/usr/bin/env bash
#
# Self-test for the pnpm installer script (issue #89).
#
# infra/pnpm-version.test.sh covers the resolver's refusals. This covers the
# thing the resolver cannot: whether install-pnpm.sh actually STOPS when the
# resolver refuses. That is the half of the original defect that lived in shell
# structure rather than in a regex -- a command substitution in argument position
# discards its exit status, so `npm install --global "pnpm@$(node -p ...)"`
# installed `pnpm@latest` on a fully green build. Moving it back into argument
# position would pass every other check in this repo, including a real image
# build, because the happy path is identical. So it is pinned here.
#
# `npm` and `pnpm` are stubbed on PATH: this installs nothing, needs no network
# and no Docker, and asserts on what the script WOULD have run.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/install-pnpm.sh"

failures=0

WORK=$(mktemp -d "${TMPDIR:-/tmp}/install-pnpm-test.XXXXXX") || {
  echo "FAIL: cannot create a fixture directory, so no case below would mean anything" >&2
  exit 1
}
trap 'rm -rf "$WORK"' EXIT

BIN="$WORK/bin"
mkdir -p "$BIN"

# The npm stub records its arguments instead of installing. Recording rather than
# just exiting 0 is what lets a case assert the script never reached npm, which
# is the actual claim for a refused manifest.
cat >"$BIN/npm" <<'STUB'
#!/bin/sh
echo "$@" >>"$NPM_LOG"
STUB

# The pnpm stub reports whatever a case wants, so the post-install assertion can
# be driven in both directions without a real install.
cat >"$BIN/pnpm" <<'STUB'
#!/bin/sh
cat "$PNPM_REPORTS"
STUB
chmod +x "$BIN/npm" "$BIN/pnpm"

# run <packageManager-json-value-or-EMPTY> <version-pnpm-reports>
# Echoes the script's exit status. The npm log is left at $WORK/case/npm.log for
# the caller to inspect with npm_log.
run() {
  local pm=$1 reports=$2 dir="$WORK/case" log
  rm -rf "$dir" && mkdir -p "$dir"
  log="$dir/npm.log"
  if [ "$pm" = EMPTY ]; then
    printf '{"name":"fixture"}\n' >"$dir/package.json"
  else
    printf '{"name":"fixture","packageManager":%s}\n' "$pm" >"$dir/package.json"
  fi
  : >"$log"
  printf '%s\n' "$reports" >"$dir/pnpm-reports"
  (
    cd "$dir" || exit 99
    PATH="$BIN:$PATH" NPM_LOG="$log" PNPM_REPORTS="$dir/pnpm-reports" \
      sh "$SCRIPT" ./package.json >/dev/null 2>&1
  )
  echo $?
}

npm_log() { cat "$WORK/case/npm.log"; }

pass() { echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

# Same reasoning as the other two suites in this directory: a suite that cannot
# fail is not evidence. Drive one deliberately wrong expectation and confirm the
# counter moves.
harness_self_check() {
  local before=$failures
  fail 'CANARY, expected to fail' 2>/dev/null
  if [ "$failures" -le "$before" ]; then
    echo "FAIL: the harness cannot detect a failing case, so every result below is meaningless" >&2
    exit 1
  fi
  failures=$before
  pass 'the harness fails when a case fails'
}
harness_self_check

# --- the happy path, including the flags the install must carry -----------------
got=$(run '"pnpm@9.15.9"' 9.15.9)
if [ "$got" != 0 ]; then
  fail "the real pin exited $got"
else
  # One verdict for the case, not one per assertion, so a partial failure cannot
  # print FAIL and ok for the same case.
  logged=$(npm_log)
  bad=
  case "$logged" in *--global*) ;; *) bad="missing --global" ;; esac
  # --ignore-scripts is pinned deliberately: it is what keeps a substituted
  # tarball's postinstall from running as root during the image build, and
  # dropping it is a silent change nothing else in the repo would notice.
  case "$logged" in *--ignore-scripts*) ;; *) bad="${bad:+$bad, }missing --ignore-scripts" ;; esac
  case "$logged" in *"pnpm@9.15.9"*) ;; *) bad="${bad:+$bad, }did not name pnpm@9.15.9" ;; esac
  if [ -n "$bad" ]; then
    fail "the real pin: $bad (npm got: $logged)"
  else
    pass 'the real pin installs pnpm@9.15.9 with --global --ignore-scripts'
  fi
fi

# --- the measured defect: a refused manifest must stop BEFORE npm runs ---------
got=$(run EMPTY 9.15.9)
if [ "$got" = 0 ]; then
  fail "a manifest with no packageManager exited 0 (an inline substitution would install pnpm@latest here)"
elif [ -s "$WORK/case/npm.log" ]; then
  fail "a manifest with no packageManager still invoked npm: $(npm_log)"
else
  pass 'a manifest with no packageManager exits non-zero and never reaches npm'
fi

got=$(run '"pnpm@npm:left-pad@1.3.0"' 9.15.9)
if [ "$got" = 0 ]; then
  fail 'an npm: alias spec exited 0'
elif [ -s "$WORK/case/npm.log" ]; then
  fail "an npm: alias spec still invoked npm: $(npm_log)"
else
  pass 'an npm: alias spec exits non-zero and never reaches npm'
fi

# --- the drift assertion, in both directions -----------------------------------
got=$(run '"pnpm@9.15.9"' 10.0.0)
if [ "$got" = 0 ]; then
  fail 'an installed version disagreeing with the pin exited 0'
else
  pass 'an installed version disagreeing with the pin fails the build'
fi

if [ "$failures" -gt 0 ]; then
  echo "install-pnpm: $failures case(s) failed" >&2
  exit 1
fi
echo "install-pnpm: all cases passed"
