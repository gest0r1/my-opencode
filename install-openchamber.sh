#!/usr/bin/env bash
# Thin OpenChamber 2.x + OpenCode 2.x installer.
# Installs an exact fork web release package when available, otherwise builds
# the exact source SHA, then delegates service lifecycle to native "startup".
set -Eeuo pipefail

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}"
APP_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
APP_REF="${OPENCHAMBER_REF:-main}"
OPENCODE_VERSION="${OPENCODE_INSTALL_VERSION:-2.0.21}"
EXPECTED_OPENCHAMBER_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-2.1.0}"
OPENCHAMBER_PACKAGE_MODE="${OPENCHAMBER_PACKAGE_MODE:-auto}"
HOST="${OPENCHAMBER_BIND_HOST:-172.18.0.1}"
PORT="${OPENCHAMBER_BIND_PORT:-3000}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode/openchamber-v2-install.state"
LEGACY_DROP_DIR="$HOME/.config/systemd/user/openchamber.service.d"
LEGACY_DROP_A="$LEGACY_DROP_DIR/90-openchamber-runtime.conf"
LEGACY_DROP_B="$LEGACY_DROP_DIR/90-integration-bundle.conf"
LEGACY_PASSWORD_ENV="$HOME/.config/openchamber-live.env"
NATIVE_STARTUP_ENV="$HOME/.config/openchamber/startup.env"

case "${1:-}" in
  ''|--opencode-update) ;;
  --help)
    cat <<EOF
Usage: install-openchamber.sh [--opencode-update]
Environment:
  OPENCODE_CONFIG_REF / MY_OPENCODE_REF
  OPENCHAMBER_REF
  OPENCODE_INSTALL_VERSION (default: 2.0.21)
  OPENCHAMBER_EXPECTED_VERSION (default: 2.1.0)
  OPENCHAMBER_PACKAGE_MODE (auto|release|source; default: auto)
  OPENCHAMBER_BIND_HOST (default: 172.18.0.1)
  OPENCHAMBER_BIND_PORT (default: 3000)
EOF
    exit 0
    ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

for cmd in gh curl tar node mktemp systemctl ip ss; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
gh auth status --hostname github.com >/dev/null 2>&1 || {
  echo 'Authenticate GitHub CLI with: gh auth login' >&2
  exit 1
}
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || {
  echo 'OPENCHAMBER_BIND_PORT must be 1..65535' >&2; exit 1;
}
case "$OPENCHAMBER_PACKAGE_MODE" in
  auto|release|source) ;;
  *) echo 'OPENCHAMBER_PACKAGE_MODE must be auto, release or source' >&2; exit 1 ;;
esac

ensure_node22() {
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  (( major >= 22 )) || {
    echo "Node.js 22+ is required (found: $(node --version 2>/dev/null || echo missing))" >&2
    exit 1
  }
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then return 0; fi
  echo 'Installing Bun for the fork package build'
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || { echo 'Bun installation failed' >&2; exit 1; }
}

legacy_service_guard() {
  if [[ -e "$LEGACY_DROP_A" || -e "$LEGACY_DROP_B" ]]; then
    cat >&2 <<EOF
LEGACY_SERVICE_DETECTED
OpenChamber 1.x service overrides are still installed:
  $LEGACY_DROP_A
  $LEGACY_DROP_B
This installer will not delete them. Disable the old service and remove only
those legacy overrides explicitly, then run this installer again.
EOF
    exit 3
  fi
}

ref_sha() {
  gh api "repos/$1/commits/$2" --jq .sha
}

read_ui_password_from_env_file() {
  local file=$1 value=''
  [[ -f "$file" ]] || return 1
  value="$(
    set +u
    unset OPENCHAMBER_UI_PASSWORD
    # shellcheck disable=SC1090
    source "$file" >/dev/null 2>&1 || true
    printf '%s' "${OPENCHAMBER_UI_PASSWORD:-}"
  )"
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

validate_bind_host() {
  # For an explicit IPv4 address, fail before touching startup if the address is
  # not assigned to this host. This catches a changed Docker bridge cleanly.
  if [[ "$HOST" =~ ^[0-9]+(\.[0-9]+){3}$ && "$HOST" != "0.0.0.0" && "$HOST" != 127.* ]]; then
    if ! ip -4 -o addr show | grep -Fq " $HOST/"; then
      echo "OPENCHAMBER_BIND_HOST=$HOST is not assigned to this host." >&2
      echo "Check the NPM Docker bridge address or override OPENCHAMBER_BIND_HOST explicitly." >&2
      exit 1
    fi
  fi
}

ensure_node22
ensure_bun
legacy_service_guard
validate_bind_host
mkdir -p "$(dirname "$STATE")"
TMP="$(mktemp -d /tmp/openchamber-v2-install.XXXXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT

CONFIG_SHA="$(ref_sha "$CONFIG_REPO" "$CONFIG_REF")"
APP_SHA="$(ref_sha "$APP_REPO" "$APP_REF")"

# Install OpenCode/config first. The config installer is authoritative for
# OpenCode 2.0.21 and does not remove legacy OpenCode files.
gh api -H 'Accept: application/vnd.github.raw'   "repos/$CONFIG_REPO/contents/install.sh?ref=$CONFIG_REF" > "$TMP/install-opencode.sh"
OPENCODE_CONFIG_REPO="$CONFIG_REPO" OPENCODE_CONFIG_REF="$CONFIG_REF" OPENCODE_INSTALL_VERSION="$OPENCODE_VERSION"   bash "$TMP/install-opencode.sh"
export PATH="$HOME/.opencode/bin:${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
command -v opencode >/dev/null 2>&1 || { echo 'OpenCode binary is not on PATH after install' >&2; exit 1; }
installed_opencode="$(opencode --version | sed -E 's/^opencode[[:space:]]+v?//')"
[[ "$installed_opencode" == "$OPENCODE_VERSION" ]] || {
  echo "OpenCode version mismatch: expected=$OPENCODE_VERSION actual=$installed_opencode" >&2
  exit 1
}

previous_app_sha=''
[[ ! -f "$STATE" ]] || previous_app_sha="$(sed -n 's/^openchamber_sha=//p' "$STATE" | head -1)"
installed_openchamber="$(openchamber --version 2>/dev/null | sed -E 's/^OpenChamber[[:space:]]+v?//; s/^v//' || true)"

install_release_package() {
  local tag="v$EXPECTED_OPENCHAMBER_VERSION"
  local tag_sha=''
  tag_sha="$(ref_sha "$APP_REPO" "$tag" 2>/dev/null || true)"
  [[ -n "$tag_sha" && "$tag_sha" == "$APP_SHA" ]] || return 1

  mkdir -p "$TMP/release"
  if ! gh release download "$tag" \
      --repo "$APP_REPO" \
      --pattern "openchamber-web-$EXPECTED_OPENCHAMBER_VERSION.tgz" \
      --dir "$TMP/release" \
      --clobber; then
    return 1
  fi

  shopt -s nullglob
  local packages=("$TMP"/release/openchamber-web-"$EXPECTED_OPENCHAMBER_VERSION".tgz)
  shopt -u nullglob
  [[ "${#packages[@]}" -eq 1 ]] || return 1
  bun add -g "${packages[0]}"
  echo "Installed OpenChamber from $APP_REPO release $tag at exact SHA $APP_SHA"
}

install_source_package() {
  echo "Building OpenChamber fork $APP_REPO@$APP_SHA"
  gh api "repos/$APP_REPO/tarball/$APP_SHA" > "$TMP/openchamber.tar.gz"
  mkdir -p "$TMP/src"
  tar -xzf "$TMP/openchamber.tar.gz" -C "$TMP/src" --strip-components=1
  local actual_version
  actual_version="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version))' "$TMP/src/packages/web/package.json")"
  [[ "$actual_version" == "$EXPECTED_OPENCHAMBER_VERSION" ]] || {
    echo "OpenChamber package version mismatch: expected=$EXPECTED_OPENCHAMBER_VERSION actual=$actual_version" >&2
    exit 1
  }
  (
    cd "$TMP/src"
    bun install --frozen-lockfile
    bun run --cwd packages/web build
    mkdir -p "$TMP/pack"
    cd packages/web
    bun pm pack --destination "$TMP/pack"
  )
  shopt -s nullglob
  local packages=("$TMP"/pack/*.tgz)
  shopt -u nullglob
  [[ "${#packages[@]}" -eq 1 ]] || { echo 'Expected exactly one packed OpenChamber web package' >&2; exit 1; }
  bun add -g "${packages[0]}"
}

if [[ "$previous_app_sha" != "$APP_SHA" || "$installed_openchamber" != "$EXPECTED_OPENCHAMBER_VERSION" ]]; then
  case "$OPENCHAMBER_PACKAGE_MODE" in
    release)
      install_release_package || {
        echo "Exact release package unavailable for $APP_REPO@$APP_SHA (v$EXPECTED_OPENCHAMBER_VERSION)" >&2
        exit 1
      }
      ;;
    source)
      install_source_package
      ;;
    auto)
      if ! install_release_package; then
        echo "Exact release package is not available yet; falling back to source build"
        install_source_package
      fi
      ;;
  esac
fi

export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
command -v openchamber >/dev/null 2>&1 || { echo 'openchamber is not on PATH after install' >&2; exit 1; }
installed_openchamber="$(openchamber --version | sed -E 's/^OpenChamber[[:space:]]+v?//; s/^v//')"
[[ "$installed_openchamber" == "$EXPECTED_OPENCHAMBER_VERSION" ]] || {
  echo "OpenChamber version mismatch: expected=$EXPECTED_OPENCHAMBER_VERSION actual=$installed_openchamber" >&2
  exit 1
}

PASSWORD_SOURCE=''
NEW_PASSWORD=''
if [[ "$HOST" != 127.0.0.1 && "$HOST" != localhost ]]; then
  if [[ -n "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
    PASSWORD_SOURCE='environment'
  elif existing_password="$(read_ui_password_from_env_file "$LEGACY_PASSWORD_ENV" 2>/dev/null)"; then
    export OPENCHAMBER_UI_PASSWORD="$existing_password"
    PASSWORD_SOURCE='legacy-openchamber-live'
    echo "Reusing existing OpenChamber UI password from $LEGACY_PASSWORD_ENV"
  elif existing_password="$(read_ui_password_from_env_file "$NATIVE_STARTUP_ENV" 2>/dev/null)"; then
    export OPENCHAMBER_UI_PASSWORD="$existing_password"
    PASSWORD_SOURCE='native-startup-env'
    echo "Reusing existing OpenChamber UI password from $NATIVE_STARTUP_ENV"
  else
    NEW_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
    export OPENCHAMBER_UI_PASSWORD="$NEW_PASSWORD"
    PASSWORD_SOURCE='generated'
  fi
fi
export OPENCODE_BINARY="$(command -v opencode)"

# Native OpenChamber owns the systemd --user unit and its environment snapshot.
startup_args=(startup enable --host "$HOST" --port "$PORT")
if [[ -n "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
  startup_args+=(--ui-password "$OPENCHAMBER_UI_PASSWORD")
fi
openchamber "${startup_args[@]}"
openchamber startup status

systemctl --user is-active --quiet openchamber.service || {
  echo "OpenChamber startup service is not active." >&2
  exit 1
}

if ! ss -H -lnt | awk -v target="$HOST:$PORT" '$4 == target { found=1 } END { exit(found ? 0 : 1) }'; then
  echo "OpenChamber is active but is not listening on $HOST:$PORT." >&2
  ss -H -lnt >&2 || true
  exit 1
fi

http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://$HOST:$PORT/" || true)"
case "$http_code" in
  200|301|302|303|307|308|401|403) ;;
  *)
    echo "OpenChamber HTTP health check failed on http://$HOST:$PORT/ (status=$http_code)." >&2
    exit 1
    ;;
esac

# Only after the native service has persisted and passed health checks may the
# 1.x password file be removed. The password itself remains in startup.env.
if [[ -f "$LEGACY_PASSWORD_ENV" && -n "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
  persisted_password="$(read_ui_password_from_env_file "$NATIVE_STARTUP_ENV" 2>/dev/null || true)"
  if [[ -n "$persisted_password" && "$persisted_password" == "$OPENCHAMBER_UI_PASSWORD" ]]; then
    rm -f -- "$LEGACY_PASSWORD_ENV"
    echo "Removed migrated legacy password file: $LEGACY_PASSWORD_ENV"
  else
    echo "Legacy password file retained because native password persistence could not be verified." >&2
  fi
fi

printf 'config_sha=%s\nopenchamber_sha=%s\nopenchamber_version=%s\nopencode_version=%s\nbind_host=%s\nbind_port=%s\n' \
  "$CONFIG_SHA" "$APP_SHA" "$installed_openchamber" "$installed_opencode" "$HOST" "$PORT" > "${STATE}.tmp.${BASHPID}"
mv -f "${STATE}.tmp.${BASHPID}" "$STATE"

echo "SUCCESS: OpenChamber $installed_openchamber ($APP_SHA) + OpenCode $installed_opencode"
echo "Native startup service: http://$HOST:$PORT"
[[ -z "$NEW_PASSWORD" ]] || echo "NEW UI PASSWORD (store securely): $NEW_PASSWORD"
