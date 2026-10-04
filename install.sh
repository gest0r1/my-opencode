#!/usr/bin/env bash
# Always stage and validate a full configuration generation. Binary downloads
# remain independent and are skipped when the installed version matches.
set -Eeuo pipefail

RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
for cmd in id getent cut; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
CURRENT_USER="$(id -un)"
RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6 || true)"
if [[ "$CURRENT_USER" != "$RUNTIME_USER" ]]; then
  echo "OpenCode must be installed and run as user '$RUNTIME_USER' (current: '$CURRENT_USER')." >&2
  echo "Use: sudo -iu $RUNTIME_USER" >&2
  exit 2
fi
if [[ -z "$RUNTIME_HOME" || "$HOME" != "$RUNTIME_HOME" ]]; then
  echo "Invalid HOME for runtime user '$RUNTIME_USER': HOME='$HOME', expected='$RUNTIME_HOME'." >&2
  echo "Use a login shell: sudo -iu $RUNTIME_USER" >&2
  exit 2
fi

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_INSTALL_VERSION="${OPENCODE_INSTALL_VERSION:-2.0.21}"
GENERATION_PATH="scripts/install-opencode-generation.sh"
for cmd in gh mktemp rm sed; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
gh auth status --hostname github.com >/dev/null 2>&1 || { echo 'Authenticate GitHub CLI with: gh auth login' >&2; exit 1; }
CONFIG_SHA="${OPENCODE_RESOLVED_CONFIG_SHA:-$REF}"
if [[ ! "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  CONFIG_SHA="$(gh api "repos/$REPO/commits/$REF" --jq .sha)"
fi
export OPENCODE_RESOLVED_CONFIG_SHA="$CONFIG_SHA"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"
if [[ "${OPENCODE_SKIP_BINARY_INSTALL:-0}" != 1 && "${OPENCODE_FORCE_BINARY_INSTALL:-0}" != 1 && -x "$OPENCODE_BIN" ]] &&
   [[ "$("$OPENCODE_BIN" --version | sed -E 's/^opencode[[:space:]]+v?//')" == "$OPENCODE_INSTALL_VERSION" ]]; then
  export OPENCODE_SKIP_BINARY_INSTALL=1
fi
TMP_DIR="$(mktemp -d /tmp/opencode-generation-bootstrap.XXXXXXXX)"
GENERATION="$TMP_DIR/install-opencode-generation.sh"
trap 'rm -rf -- "$TMP_DIR"' EXIT
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$REPO/contents/$GENERATION_PATH?ref=$CONFIG_SHA" > "$GENERATION"
bash "$GENERATION" "$@"
