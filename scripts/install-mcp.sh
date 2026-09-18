#!/usr/bin/env bash
# Managed MCP installation. No changes to unknown Docker containers or existing secrets.
set -Eeuo pipefail

SOURCE_ROOT="${OPENCODE_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${OPENCODE_ENV_FILE:-$HOME/.config/opencode.env}"
LOCK="$SOURCE_ROOT/mcp/1c-buddy/source.lock"
COMPOSE="$SOURCE_ROOT/mcp/1c-buddy/compose.yml"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/my-opencode/mcp/1c-buddy"
UV="$(command -v uv || true)"
[[ -n "$UV" ]] || UV="$HOME/.local/bin/uv"

fail() { echo "MCP install: $*" >&2; exit 1; }
for executable in gh tar curl docker; do
  command -v "$executable" >/dev/null 2>&1 || fail "required command missing: $executable"
done
[[ -x "$UV" ]] || fail "uv missing: $UV (run install.sh first)"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 required"
docker info >/dev/null 2>&1 || fail "cannot access Docker daemon; check Docker group/socket"
[[ -f "$LOCK" && -f "$COMPOSE" ]] || fail "1c-buddy source.lock/compose.yml missing"

# Install independently of system Python and without modifying global pip packages.
"$UV" tool install --python 3.13 'yadisk-mcp==0.1.2'
[[ -x "$HOME/.local/bin/yadisk-mcp" ]] || fail "yadisk-mcp executable was not created"
[[ -n "${YANDEX_DISK_TOKEN:-}" ]] || echo 'MCP warning: YANDEX_DISK_TOKEN is not set; yadisk cannot authenticate.' >&2
[[ -n "${YANDEX_METRIKA_TOKEN:-}" ]] || echo 'MCP warning: YANDEX_METRIKA_TOKEN is not set; ya-metrika cannot authenticate.' >&2
command -v npx >/dev/null 2>&1 || fail 'npx missing (required by memory and ya-metrika)'

# Verify lock metadata as data; do not source executable code from this file.
REPO="$(sed -n 's/^repo=//p' "$LOCK")"
SHA="$(sed -n 's/^sha=//p' "$LOCK")"
[[ "$REPO" == 'ROCTUP/1c-buddy' && "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'unrecognized upstream lock'
[[ "$(gh api "repos/$REPO/commits/$SHA" --jq .sha)" == "$SHA" ]] || fail 'upstream SHA cannot be verified'
[[ -n "${ONEC_AI_TOKEN:-}" && "${ONEC_AI_TOKEN}" != *$'\n'* && "${ONEC_AI_TOKEN}" != *$'\r'* ]] || fail 'ONEC_AI_TOKEN missing/invalid in ~/.config/opencode.env; not starting unauthenticated 1c-buddy'

# Never take over an unknown container, even if it happens to have the same name.
if docker container inspect my-opencode-1c-buddy >/dev/null 2>&1; then
  MANAGED="$(docker inspect -f '{{ index .Config.Labels "my-opencode.managed" }}' my-opencode-1c-buddy)"
  [[ "$MANAGED" == 'true' ]] || fail 'container my-opencode-1c-buddy exists but is not managed by my-opencode; refusing to replace it'
fi

mkdir -p "$DATA" "$STATE"
chmod 700 "$STATE"
SOURCE_DIR="$DATA/$SHA"
if [[ ! -d "$SOURCE_DIR" ]]; then
  TMP="$(mktemp -d "$DATA/.checkout.XXXXXX")"
  trap '[[ -z "${TMP:-}" ]] || rm -rf -- "$TMP"' EXIT
  gh api "repos/$REPO/tarball/$SHA" > "$TMP/source.tar.gz"
  mkdir -p "$TMP/source"
  tar -xzf "$TMP/source.tar.gz" -C "$TMP/source" --strip-components=1
  [[ -f "$TMP/source/Dockerfile" && -f "$TMP/source/LICENSE" && -d "$TMP/source/app" ]] || fail 'upstream archive missing required files'
  mv "$TMP/source" "$SOURCE_DIR"
  rm -rf -- "$TMP"
  TMP=''
  trap - EXIT
fi

# A container gets ONE credential only, not the whole opencode.env containing other integrations.
TOKEN_FILE="$STATE/1c-buddy.env"
( umask 077; printf 'ONEC_AI_TOKEN=%s\n' "$ONEC_AI_TOKEN" > "$TOKEN_FILE.tmp"; mv -f "$TOKEN_FILE.tmp" "$TOKEN_FILE" )
chmod 600 "$TOKEN_FILE"
export ONEC_BUDDY_SOURCE_DIR="$SOURCE_DIR" ONEC_BUDDY_SOURCE_SHA="$SHA" ONEC_BUDDY_ENV_FILE="$TOKEN_FILE"

# Preserve existing healthy managed instance with the exact same source revision.
REUSE=0
if docker container inspect my-opencode-1c-buddy >/dev/null 2>&1; then
  ACTIVE_SHA="$(docker inspect -f '{{ index .Config.Labels "my-opencode.source-sha" }}' my-opencode-1c-buddy)"
  STATUS="$(docker inspect -f '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}no-healthcheck{{ end }}' my-opencode-1c-buddy)"
  [[ "$ACTIVE_SHA" == "$SHA" && "$STATUS" == healthy ]] && REUSE=1
fi
if [[ "$REUSE" == 0 ]]; then
  docker compose --project-name my-opencode-1c-buddy --file "$COMPOSE" up -d --build --no-deps buddy
fi

# The upstream Dockerfile has its own HTTP healthcheck. Fail rather than report success prematurely.
HEALTH=''
for (( attempt=1; attempt<=30; attempt++ )); do
  HEALTH="$(docker inspect -f '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}no-healthcheck{{ end }}' my-opencode-1c-buddy 2>/dev/null || true)"
  [[ "$HEALTH" == healthy ]] && break
  [[ "$HEALTH" == unhealthy ]] && fail '1c-buddy container unhealthy; inspect docker logs (do not paste credentials)'
  sleep 2
done
[[ "$HEALTH" == healthy ]] || fail "1c-buddy did not become healthy: ${HEALTH:-missing}"
curl --noproxy '*' --fail --silent --show-error --max-time 8 'http://127.0.0.1:6002/health' >/dev/null || fail '1c-buddy HTTP health endpoint unavailable'
MCP_STATUS="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time 12 --request POST \
  --header 'Content-Type: application/json' --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"my-opencode-installer","version":"1"}}}' \
  'http://127.0.0.1:6002/mcp')" || fail '1c-buddy MCP initialize connection failed'
[[ "$MCP_STATUS" == 200 ]] || fail "1c-buddy MCP initialize returned HTTP $MCP_STATUS"
echo "MCP installed: yadisk-mcp 0.1.2; 1c-buddy $SHA; health and MCP initialize OK."
