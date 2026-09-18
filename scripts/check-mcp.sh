#!/usr/bin/env bash
# Read-only MCP readiness report. Never print tokens or full environment.
set -Eeuo pipefail

fail() { echo "MCP check: $*" >&2; exit 1; }
command -v opencode >/dev/null 2>&1 || fail 'opencode executable unavailable'
command -v timeout >/dev/null 2>&1 || fail 'timeout executable unavailable'
[[ -x "$HOME/.local/bin/yadisk-mcp" ]] || fail 'yadisk executable missing; run install.sh'
[[ -n "${YANDEX_DISK_TOKEN:-}" ]] || echo 'WARNING yadisk: missing YANDEX_DISK_TOKEN' >&2
[[ -n "${YANDEX_METRIKA_TOKEN:-}" ]] || echo 'WARNING ya-metrika: missing YANDEX_METRIKA_TOKEN' >&2
if command -v docker >/dev/null 2>&1 && docker container inspect my-opencode-1c-buddy >/dev/null 2>&1; then
  HEALTH="$(docker inspect -f '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}unknown{{ end }}' my-opencode-1c-buddy)"
  [[ "$HEALTH" == healthy ]] || fail "1c-buddy container health=$HEALTH"
  curl --noproxy '*' --fail --silent --max-time 5 http://127.0.0.1:6002/health >/dev/null || fail '1c-buddy HTTP health failed'
else
  fail 'managed 1c-buddy container missing'
fi

# The native CLI validates the actual merged OpenCode config and remote MCP handshake.
# Suppress raw connection errors here: they can contain URLs or credentials.
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
chmod 600 "$OUT"
if ! timeout 90 opencode mcp list > "$OUT" 2>&1; then
  fail 'opencode mcp list failed or timed out; inspect the command locally (do not share unredacted logs)'
fi
for name in context7 gh_grep exa yadisk memory ya-metrika 1c-buddy; do
  if grep -F "$name" "$OUT" | grep -Eiq '(^|[[:space:]])connected([[:space:]]|$)'; then
    printf 'PASS %s connected\n' "$name"
  else
    printf 'CHECK %s: not confirmed connected; inspect opencode mcp list locally\n' "$name"
    exit_status=1
  fi
done
exit "${exit_status:-0}"
