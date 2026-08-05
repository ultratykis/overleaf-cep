#!/usr/bin/env bash

set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
develop_dir="$(cd "$test_dir/.." && pwd)"
fixture_bin="$test_dir/fixtures"
test_log="$(mktemp)"
trap 'rm -f "$test_log"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_log_contains() {
  grep -Fq "$1" "$test_log" || fail "missing log entry: $1"
}

: > "$test_log"
PATH="$fixture_bin:$PATH" \
  FAKE_DOCKER_LOG="$test_log" \
  FAKE_DOCKER_IMAGE_ID="fresh-image" \
  FAKE_DOCKER_CREATED="2100-01-01T00:00:00Z" \
  "$develop_dir/bin/ensure-fresh-web-images" web
[[ ! -s $test_log ]] || fail "a fresh image triggered a build"

: > "$test_log"
PATH="$fixture_bin:$PATH" \
  FAKE_DOCKER_LOG="$test_log" \
  FAKE_DOCKER_IMAGE_ID="stale-image" \
  FAKE_DOCKER_CREATED="1970-01-01T00:00:00Z" \
  "$develop_dir/bin/up" web
assert_log_contains "docker compose build web"
assert_log_contains "docker compose up --detach web"

: > "$test_log"
PATH="$fixture_bin:$PATH" \
  FAKE_DOCKER_LOG="$test_log" \
  FAKE_DOCKER_IMAGE_ID="stale-image" \
  FAKE_DOCKER_CREATED="1970-01-01T00:00:00Z" \
  "$develop_dir/bin/dev" webpack
assert_log_contains "docker compose build webpack"
assert_log_contains "docker-compose -f docker-compose.yml -f docker-compose.dev.yml up --no-deps --detach webpack"

: > "$test_log"
if PATH="$fixture_bin:$PATH" \
  FAKE_DOCKER_LOG="$test_log" \
  FAKE_DOCKER_IMAGE_ID="stale-image" \
  FAKE_DOCKER_CREATED="1970-01-01T00:00:00Z" \
  FAKE_DOCKER_FAIL_BUILD=1 \
  "$develop_dir/bin/up" web; then
  fail "up continued after a failed stale-image rebuild"
fi
assert_log_contains "docker compose build web"
if grep -Fq "docker compose up" "$test_log"; then
  fail "up started after a failed stale-image rebuild"
fi

printf 'image freshness tests passed\n'
