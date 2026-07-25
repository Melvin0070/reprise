#!/usr/bin/env bash
#
# Prove the production image serves the walking skeleton end to end (issue #4).
#
# Builds infra/Dockerfile and, against the container that results — the exact
# artifact the deploy runs — asserts three things:
#   1. an unknown route carries the DX7 404 envelope;
#   2. an unkeyed submission is rejected 401 with a WWW-Authenticate challenge
#      (OV-1);
#   3. a keyed `print("hello")` reaches terminal `succeeded`, exit 0, stdout
#      `hello`, executed in the jail inside the image.
#
# This is the containerized superset of api/src/main.smoke.test.ts, and unlike
# it actually runs code in the jail. Run locally with `pnpm smoke:image` (needs
# Docker) or in CI's `image` job.
set -euo pipefail

IMAGE=reprise-api-smoke
NAME="reprise-api-smoke-$$"
# Length clears MIN_API_KEY_LENGTH (32); the value is arbitrary.
KEY="smoke-key-$(printf 'x%.0s' {1..32})"

BODY=$(mktemp)
HEADERS=$(mktemp)
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "$BODY" "$HEADERS"
}
trap cleanup EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  docker logs "$NAME" 2>&1 | sed 's/^/  container| /' >&2 || true
  exit 1
}

echo "building $IMAGE ..."
docker build -q -f infra/Dockerfile -t "$IMAGE" . >/dev/null

echo "starting container ..."
docker run -d --name "$NAME" \
  -e REPRISE_API_KEY="$KEY" \
  -p 127.0.0.1::3000 \
  "$IMAGE" >/dev/null

BASE="http://$(docker port "$NAME" 3000/tcp | head -1)"

echo "waiting for $BASE ..."
ready=
for _ in $(seq 1 100); do
  if curl -s -o /dev/null "$BASE/nope"; then
    ready=1
    break
  fi
  sleep 0.2
done
[ -n "$ready" ] || fail "server never answered on $BASE"

# 1. unknown route -> DX7 404 envelope
code=$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/nope")
[ "$code" = "404" ] || fail "GET /nope expected 404, got $code"
grep -qF '"code":"not_found"' "$BODY" || fail "GET /nope missing not_found envelope"

# 2. unkeyed submission -> OV-1 401 + WWW-Authenticate challenge
code=$(curl -s -o "$BODY" -D "$HEADERS" -w '%{http_code}' -X POST "$BASE/submissions" \
  -H 'Content-Type: application/json' -d '{"language":"python","code":"print(1)"}')
[ "$code" = "401" ] || fail "unkeyed POST expected 401, got $code"
grep -qiF 'WWW-Authenticate: Bearer' "$HEADERS" || fail "401 missing WWW-Authenticate: Bearer"
grep -qF '"code":"unauthorized"' "$BODY" || fail "401 missing unauthorized envelope"

# 3. keyed walking skeleton -> succeeded, exit 0, stdout hello, run in the jail
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/submissions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"language":"python","code":"print(\"hello\")"}')
[ "$code" = "200" ] || fail "keyed POST expected 200, got $code ($(cat "$BODY"))"
grep -qF '"state":"succeeded"' "$BODY" || fail "expected succeeded ($(cat "$BODY"))"
grep -qF '"exit_code":0' "$BODY" || fail "expected exit_code 0 ($(cat "$BODY"))"
grep -qF '"stdout":"hello\n"' "$BODY" || fail "expected stdout hello ($(cat "$BODY"))"

echo "SMOKE PASS: the production image serves the walking skeleton"
