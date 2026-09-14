#!/usr/bin/env bash
# Install the forked OpenChamber web/CLI runtime from a verified GitHub bundle.
# Source builds are an explicit recovery path only.
set -Eeuo pipefail

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-main}"
OPENCHAMBER_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
OPENCHAMBER_REF="${OPENCHAMBER_REF:-main}"
RELEASE_TAG="${OPENCHAMBER_LINUX_RELEASE_TAG:-linux-web}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"
STATE_FILE="$STATE_DIR/openchamber-install.state"
RUNTIME_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/openchamber"
VERSIONS_DIR="$RUNTIME_ROOT/versions"
CURRENT_LINK="$RUNTIME_ROOT/current"

build_from_source=0
force_opencode_update=0
for argument in "$@"; do
  case "$argument" in
    --build-from-source) build_from_source=1 ;;
    --opencode-update) force_opencode_update=1 ;;
    --help)
      cat <<'HELP'
Usage: install-openchamber.sh [--opencode-update] [--build-from-source]

Default: download an immutable Linux web/CLI bundle built by GitHub Actions.
--opencode-update: additionally run the official OpenCode binary installer.
--build-from-source: recovery path; build OpenChamber on this host.
HELP
      exit 0 ;;
    *) echo "Ошибка: неизвестный аргумент: $argument" >&2; exit 2 ;;
  esac
done

for cmd in gh curl tar sha256sum mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Ошибка: требуется команда '$cmd'." >&2
    exit 1
  }
done
gh auth status >/dev/null 2>&1 || {
  echo "Ошибка: GitHub CLI не авторизован. Выполни: gh auth login" >&2
  exit 1
}

state_value() {
  local key="$1"
  [[ -f "$STATE_FILE" ]] || return 0
  sed -n "s/^$key=//p" "$STATE_FILE" | head -n 1
}

ref_sha() {
  gh api "repos/$1/commits/$2" --jq .sha
}

ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if (( major >= 22 )); then return; fi

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$nvm_dir/nvm.sh" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | PROFILE=/dev/null bash
  fi
  # shellcheck disable=SC1090
  . "$nvm_dir/nvm.sh"
  nvm install 22
  nvm alias default 22
  nvm use 22
  if [[ -n "${NVM_BIN:-}" && -d /usr/local/bin && -w /usr/local/bin ]]; then
    ln -sfn "$NVM_BIN/node" /usr/local/bin/node
  fi
}

restart_service() {
  if command -v systemctl >/dev/null 2>&1 && [[ -f "$HOME/.config/systemd/user/openchamber.service" ]]; then
    systemctl --user daemon-reload
    systemctl --user restart openchamber.service
    echo "OpenChamber service restarted."
  fi
}

write_state() {
  mkdir -p "$STATE_DIR"
  local temporary
  temporary="$(mktemp "$STATE_DIR/openchamber-install.state.XXXXXX")"
  printf 'config_sha=%s\nopenchamber_sha=%s\n' "$CONFIG_SHA" "$OPENCHAMBER_SHA" > "$temporary"
  mv "$temporary" "$STATE_FILE"
}

install_config_if_needed() {
  local config_changed="$1"
  if [[ "$config_changed" != 1 && ! -x "$HOME/.opencode/bin/opencode" && "$force_opencode_update" != 1 ]]; then
    config_changed=1
    force_opencode_update=1
  fi
  if [[ "$config_changed" != 1 && "$force_opencode_update" != 1 ]]; then return; fi

  local skip=1
  [[ "$force_opencode_update" == 1 ]] && skip=0
  echo "Синхронизирую OpenCode/configuration $CONFIG_REPO@$CONFIG_REF..."
  gh api -H "Accept: application/vnd.github.raw" \
    "repos/$CONFIG_REPO/contents/install.sh?ref=$CONFIG_REF" | \
    OPENCODE_CONFIG_REPO="$CONFIG_REPO" \
    OPENCODE_CONFIG_REF="$CONFIG_REF" \
    OPENCODE_SKIP_BINARY_INSTALL="$skip" bash
}

CONFIG_SHA="$(ref_sha "$CONFIG_REPO" "$CONFIG_REF")"
OPENCHAMBER_SHA="$(ref_sha "$OPENCHAMBER_REPO" "$OPENCHAMBER_REF")"
PREVIOUS_CONFIG_SHA="$(state_value config_sha)"
PREVIOUS_OPENCHAMBER_SHA="$(state_value openchamber_sha)"
config_changed=0
[[ "$CONFIG_SHA" != "$PREVIOUS_CONFIG_SHA" ]] && config_changed=1
install_config_if_needed "$config_changed"

if (( build_from_source == 1 )); then
  echo "Запущен явный fallback: сборка OpenChamber из исходников."
  gh api -H "Accept: application/vnd.github.raw" \
    "repos/$CONFIG_REPO/contents/scripts/install-openchamber-from-source.sh?ref=$CONFIG_REF" | \
    OPENCODE_CONFIG_REPO="$CONFIG_REPO" OPENCODE_CONFIG_REF="$CONFIG_REF" \
    OPENCHAMBER_REPO="$OPENCHAMBER_REPO" OPENCHAMBER_REF="$OPENCHAMBER_REF" bash
  mkdir -p "$STATE_DIR"
  printf 'config_sha=%s\nopenchamber_sha=%s\n' "$CONFIG_SHA" "$OPENCHAMBER_SHA" > "$STATE_FILE"
  exit 0
fi

if [[ "$OPENCHAMBER_SHA" == "$PREVIOUS_OPENCHAMBER_SHA" && -x "$CURRENT_LINK/bin/cli.js" ]]; then
  write_state
  if (( config_changed == 1 )); then restart_service; fi
  echo "OpenChamber bundle already current: $OPENCHAMBER_SHA"
  exit 0
fi

ensure_node
if [[ ! -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]]; then
  curl -fsSL https://bun.sh/install | bash
fi
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
[[ -x "$BUN_BIN" ]] || { echo "Ошибка: Bun недоступен после установки." >&2; exit 1; }
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
MANIFEST_NAME="openchamber-web-linux-x64-$OPENCHAMBER_SHA.json"

if ! gh release download "$RELEASE_TAG" --repo "$OPENCHAMBER_REPO" \
  --pattern "$MANIFEST_NAME" --dir "$TMP_DIR"; then
  echo "Ошибка: release bundle для exact SHA $OPENCHAMBER_SHA ещё не опубликован." >&2
  echo "Дождись завершения GitHub Actions или используй явный --build-from-source." >&2
  exit 1
fi

MANIFEST="$TMP_DIR/$MANIFEST_NAME"
readarray -t bundle_info < <(MANIFEST="$MANIFEST" node - <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.MANIFEST, 'utf8'));
if (value.schema_version !== 1 || value.platform !== 'linux-x64' ||
    !/^[0-9a-f]{40}$/i.test(value.source_sha) ||
    !/^openchamber-web-linux-x64-[0-9a-f]{40}\\.tar\\.gz$/.test(value.asset) ||
    !/^[0-9a-f]{64}$/i.test(value.sha256)) process.exit(2);
process.stdout.write(value.source_sha + '\\n' + value.asset + '\\n' + value.sha256 + '\\n');
NODE
)
[[ "${#bundle_info[@]}" == 3 && "${bundle_info[0]}" == "$OPENCHAMBER_SHA" ]] || {
  echo "Ошибка: release manifest некорректен или не соответствует requested SHA." >&2
  exit 1
}
ASSET="${bundle_info[1]}"
EXPECTED_SHA256="${bundle_info[2]}"
gh release download "$RELEASE_TAG" --repo "$OPENCHAMBER_REPO" --pattern "$ASSET" --dir "$TMP_DIR"
printf '%s  %s\n' "$EXPECTED_SHA256" "$TMP_DIR/$ASSET" | sha256sum -c -

mkdir -p "$VERSIONS_DIR"
TARGET="$VERSIONS_DIR/$OPENCHAMBER_SHA"
if [[ ! -d "$TARGET" ]]; then
  UNPACK="$VERSIONS_DIR/.unpack-$OPENCHAMBER_SHA-$$"
  mkdir -p "$UNPACK"
  tar -xzf "$TMP_DIR/$ASSET" -C "$UNPACK"
  [[ -f "$UNPACK/package/bin/cli.js" ]] || {
    echo "Ошибка: bundle не содержит OpenChamber CLI." >&2
    exit 1
  }
  mv "$UNPACK/package" "$TARGET"
  rmdir "$UNPACK"
fi
ln -s "$TARGET" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"

if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
  cat > /usr/local/bin/openchamber <<'LAUNCHER'
#!/usr/bin/env bash
# managed-by: my-opencode-openchamber
set -a
[[ -f "$HOME/.config/opencode.env" ]] && . "$HOME/.config/opencode.env"
set +a
exec "${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.local/share/openchamber/current/bin/cli.js" "$@"
LAUNCHER
  chmod 755 /usr/local/bin/openchamber
else
  echo "Ошибка: /usr/local/bin недоступен для managed launcher." >&2
  exit 1
fi

mkdir -p "$HOME/.config/systemd/user/openchamber.service.d"
cat > "$HOME/.config/systemd/user/openchamber.service.d/10-opencode-env.conf" <<EOF
[Service]
EnvironmentFile=-$HOME/.config/opencode.env
Environment="OPENCODE_BINARY=$HOME/.opencode/bin/opencode"
EOF
chmod 600 "$HOME/.config/systemd/user/openchamber.service.d/10-opencode-env.conf"

write_state
restart_service

echo "Готово."
echo "OpenChamber: $OPENCHAMBER_SHA"
echo "Runtime: $TARGET"
echo "CLI: /usr/local/bin/openchamber"
