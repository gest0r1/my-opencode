#!/usr/bin/env bash
# Bootstrap for OpenCode 2.x installation.
# In the OpenChamber orchestrated path, an unchanged exact config SHA permits a
# true binary-only update. All standalone/config changes delegate to the full
# atomic generation installer stored in scripts/install-opencode-generation.sh.
set -Eeuo pipefail

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"
OPENCODE_INSTALL_VERSION="${OPENCODE_INSTALL_VERSION:-2.0.21}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode/openchamber-v2-install.state"
GENERATION_PATH="scripts/install-opencode-generation.sh"

for cmd in gh curl mktemp cp mv rm sed; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Ошибка: требуется команда '$cmd'." >&2
    exit 1
  }
done

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "Ошибка: GitHub CLI не авторизован. Выполни: gh auth login" >&2
  exit 1
fi

state_value() {
  [[ -f "$STATE" ]] || return 0
  sed -n "s/^$1=//p" "$STATE" | head -1
}

# The installed helper verifies both remote managed source content and local
# managed files. No archive, normalization or dependency install on a true no-op.
generation_unchanged=0
GENERATION_HELPER="$HOME/.config/opencode/.managed-generation.mjs"
GENERATION_RECEIPT="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode/config-generation.json"
CONFIG_SHA="$REF"
if [[ ! "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  CONFIG_SHA="$(gh api "repos/$REPO/commits/$REF" --jq .sha)"
fi
export OPENCODE_RESOLVED_CONFIG_SHA="$CONFIG_SHA"
if [[ -f "$GENERATION_HELPER" && -f "$GENERATION_RECEIPT" ]]; then
  CONFIG_FINGERPRINT="$(node "$GENERATION_HELPER" remote "$REPO" "$CONFIG_SHA")"
  export OPENCODE_CONFIG_FINGERPRINT="$CONFIG_FINGERPRINT"
  if node "$GENERATION_HELPER" check "$GENERATION_RECEIPT" "$REPO" "$CONFIG_FINGERPRINT" "$HOME"; then
    generation_unchanged=1
    if [[ -x "$OPENCODE_BIN" ]] &&
       [[ "$("$OPENCODE_BIN" --version | sed -E 's/^opencode[[:space:]]+v?//')" == "$OPENCODE_INSTALL_VERSION" ]]; then
      echo "OpenCode binary/config fingerprint unchanged: no-op; downloads and normalization skipped"
      exit 0
    fi
  fi
fi

# The orchestrator pins both refs to immutable commits before it downloads this
# file. If its recorded config generation is the same exact commit and the
# canonical config is present, downloading/rebuilding that config again adds no
# safety: only the OpenCode executable needs replacement. OPENCHAMBER_REF is a
# deliberate guard so a direct standalone install.sh invocation keeps the full
# binary+config validation semantics.
binary_only=0
if [[ "$generation_unchanged" == 1 && "${OPENCODE_SKIP_BINARY_INSTALL:-0}" != 1 &&
      "$REF" =~ ^[a-f0-9]{40}$ &&
      "${OPENCHAMBER_REF:-}" =~ ^[a-f0-9]{40}$ &&
      "$(state_value config_sha)" == "$REF" &&
      -f "$HOME/.config/opencode/opencode.json" &&
      -d "$HOME/.config/opencode/agents" ]]; then
  binary_only=1
fi

if (( binary_only == 1 )); then
  TMP_DIR="$(mktemp -d /tmp/opencode-binary-only.XXXXXXXX)"
  BINARY_BACKUP="$TMP_DIR/opencode.previous"
  HAD_BINARY=0
  UPDATE_ATTEMPTED=0
  UPDATE_COMMITTED=0

  if [[ -x "$OPENCODE_BIN" ]]; then
    cp -p "$OPENCODE_BIN" "$BINARY_BACKUP"
    HAD_BINARY=1
  fi

  rollback_binary_only() {
    (( UPDATE_ATTEMPTED == 1 && UPDATE_COMMITTED == 0 )) || return 0
    if (( HAD_BINARY == 1 )) && [[ -f "$BINARY_BACKUP" ]]; then
      mkdir -p "$(dirname "$OPENCODE_BIN")"
      local tmp="${OPENCODE_BIN}.rollback.${BASHPID}"
      cp -p "$BINARY_BACKUP" "$tmp"
      mv -f "$tmp" "$OPENCODE_BIN"
      echo "OpenCode binary-only rollback: restored previous executable." >&2
    else
      rm -f -- "$OPENCODE_BIN"
      echo "OpenCode binary-only rollback: removed incomplete executable." >&2
    fi
  }

  cleanup_binary_only() {
    local status=$?
    if (( status != 0 )); then
      rollback_binary_only || true
    fi
    rm -rf -- "$TMP_DIR"
    return "$status"
  }
  trap cleanup_binary_only EXIT

  echo "Binary-only update: config SHA $REF is unchanged"
  UPDATE_ATTEMPTED=1
  curl -fsSL https://opencode.ai/v2/install | bash -s -- --version "$OPENCODE_INSTALL_VERSION"

  [[ -x "$OPENCODE_BIN" ]] || {
    echo "Ошибка: OpenCode не найден после binary-only update: $OPENCODE_BIN" >&2
    exit 1
  }
  installed_version="$("$OPENCODE_BIN" --version | sed -E 's/^opencode[[:space:]]+v?//')"
  [[ "$installed_version" == "$OPENCODE_INSTALL_VERSION" ]] || {
    echo "Ошибка версии OpenCode: expected=$OPENCODE_INSTALL_VERSION actual=$installed_version" >&2
    exit 1
  }

  UPDATE_COMMITTED=1
  echo "OpenCode binary-only update complete: $installed_version"
  exit 0
fi

TMP_DIR="$(mktemp -d /tmp/opencode-generation-bootstrap.XXXXXXXX)"
GENERATION="$TMP_DIR/install-opencode-generation.sh"
cleanup_generation() {
  local status=$?
  rm -rf -- "$TMP_DIR"
  return "$status"
}
trap cleanup_generation EXIT

gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$REPO/contents/$GENERATION_PATH?ref=$REF" > "$GENERATION"

# Environment flags such as OPENCODE_SKIP_BINARY_INSTALL are inherited by the
# generation installer unchanged.
bash "$GENERATION" "$@"
