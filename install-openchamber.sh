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
RESTART_MODE="${OPENCHAMBER_RESTART_MODE:-auto}"

STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"
STATE="$STATE_ROOT/openchamber-v2-install.state"
CACHE_ROOT="$STATE_ROOT/openchamber-v2-cache"
LOCK="$STATE_ROOT/openchamber-v2-install.lock"

OPENCODE_BIN="$HOME/.opencode/bin/opencode"
COMMON_ENV="$HOME/.config/opencode.env"
LEGACY_PASSWORD_ENV="$HOME/.config/openchamber-live.env"
NATIVE_STARTUP_ENV="$HOME/.config/openchamber/startup.env"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/openchamber.service"
DROP_DIR="$UNIT_DIR/openchamber.service.d"
ENV_DROP="$DROP_DIR/95-my-opencode-env.conf"
LEGACY_DROP_A="$DROP_DIR/90-openchamber-runtime.conf"
LEGACY_DROP_B="$DROP_DIR/90-integration-bundle.conf"

BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export BUN_INSTALL
export PATH="$HOME/.opencode/bin:$BUN_INSTALL/bin:$PATH"

FORCE_OPENCODE_UPDATE=0

case "${1:-}" in
  '') ;;
  --opencode-update) FORCE_OPENCODE_UPDATE=1 ;;
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
  OPENCHAMBER_RESTART_MODE (auto|now|defer; default: auto)

Restart modes:
  auto   Never restart OpenChamber from its own embedded terminal.
  now    Apply package/service changes immediately. Use from SSH/CD.
  defer  Stage runtime/config changes without restarting OpenChamber.
EOF
    exit 0
    ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

for cmd in gh curl tar node mktemp systemctl ip ss sha256sum flock ps awk sed grep; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
gh auth status --hostname github.com >/dev/null 2>&1 || {
  echo 'Authenticate GitHub CLI with: gh auth login' >&2
  exit 1
}
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || {
  echo 'OPENCHAMBER_BIND_PORT must be 1..65535' >&2; exit 2;
}
case "$OPENCHAMBER_PACKAGE_MODE" in
  auto|release|source) ;;
  *) echo 'OPENCHAMBER_PACKAGE_MODE must be auto, release or source' >&2; exit 2 ;;
esac
case "$RESTART_MODE" in
  auto|now|defer) ;;
  *) echo 'OPENCHAMBER_RESTART_MODE must be auto, now or defer' >&2; exit 2 ;;
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

ref_sha() {
  gh api "repos/$1/commits/$2" --jq .sha
}

state_value() {
  [[ -f "$STATE" ]] || return 0
  sed -n "s/^$1=//p" "$STATE" | head -1
}

file_sha256() {
  local file=$1
  [[ -f "$file" ]] || { printf 'missing'; return 0; }
  sha256sum "$file" | awk '{print $1}'
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

sanitize_native_startup_env() {
  [[ -f "$NATIVE_STARTUP_ENV" ]] || return 0

  local password='' data_dir='' api_only=''
  password="$(read_ui_password_from_env_file "$NATIVE_STARTUP_ENV" 2>/dev/null || true)"
  data_dir="$(
    set +u
    unset OPENCHAMBER_DATA_DIR
    # shellcheck disable=SC1090
    source "$NATIVE_STARTUP_ENV" >/dev/null 2>&1 || true
    printf '%s' "${OPENCHAMBER_DATA_DIR:-}"
  )"
  api_only="$(
    set +u
    unset OPENCHAMBER_API_ONLY
    # shellcheck disable=SC1090
    source "$NATIVE_STARTUP_ENV" >/dev/null 2>&1 || true
    printf '%s' "${OPENCHAMBER_API_ONLY:-}"
  )"

  local tmp="${NATIVE_STARTUP_ENV}.tmp.${BASHPID}"
  umask 077
  : > "$tmp"
  [[ -z "$password" ]] || printf 'OPENCHAMBER_UI_PASSWORD=%q\n' "$password" >> "$tmp"
  [[ -z "$data_dir" ]] || printf 'OPENCHAMBER_DATA_DIR=%q\n' "$data_dir" >> "$tmp"
  [[ -z "$api_only" ]] || printf 'OPENCHAMBER_API_ONLY=%q\n' "$api_only" >> "$tmp"
  printf 'OPENCODE_BINARY=%q\n' "$OPENCODE_BIN" >> "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$NATIVE_STARTUP_ENV"

  echo "Sanitized OpenChamber startup environment: removed transient/session variables."
}

inside_openchamber_terminal() {
  [[ "${OPENCHAMBER_EMBEDDED_TERMINAL:-}" == 1 ]] && return 0

  # Fallback for the migration from an older OpenChamber that did not export
  # OPENCHAMBER_EMBEDDED_TERMINAL yet.
  local pid="$$" parent='' args='' depth=0
  while [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$depth" -lt 12 ]]; do
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$parent" =~ ^[0-9]+$ && "$parent" -gt 1 ]] || break
    args="$(ps -o args= -p "$parent" 2>/dev/null || true)"
    case "$args" in
      *openchamber*serve*|*openchamber*/server/*|*packages/web/server/*|*packages/web/bin/cli.js*)
        return 0
        ;;
    esac
    pid="$parent"
    depth=$((depth + 1))
  done
  return 1
}

validate_bind_host() {
  if [[ "$HOST" =~ ^[0-9]+(\\.[0-9]+){3}$ && "$HOST" != "0.0.0.0" && "$HOST" != 127.* ]]; then
    if ! ip -4 -o addr show | grep -Fq " $HOST/"; then
      echo "OPENCHAMBER_BIND_HOST=$HOST is not assigned to this host." >&2
      echo "Check the NPM Docker bridge address or override OPENCHAMBER_BIND_HOST." >&2
      exit 1
    fi
  fi
}

wait_for_service() {
  local probe_host="$HOST" code='' attempt
  [[ "$probe_host" != "0.0.0.0" ]] || probe_host="127.0.0.1"

  for attempt in {1..45}; do
    if systemctl --user is-active --quiet openchamber.service &&
       ss -H -lnt | awk -v target="$HOST:$PORT" '$4 == target { found=1 } END { exit(found ? 0 : 1) }'; then
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://$probe_host:$PORT/" || true)"
      case "$code" in
        200|301|302|303|307|308|401|403)
          echo "OpenChamber ready: http://$probe_host:$PORT/ ($code)"
          return 0
          ;;
      esac
    fi
    sleep 1
  done

  echo "OpenChamber did not become ready on $HOST:$PORT." >&2
  systemctl --user status openchamber.service --no-pager -l >&2 || true
  journalctl --user -u openchamber.service -n 80 --no-pager >&2 || true
  return 1
}

write_env_dropin() {
  mkdir -p "$DROP_DIR"
  local tmp="$ENV_DROP.tmp.${BASHPID}"
  cat > "$tmp" <<EOF
# managed-by: my-opencode
[Service]
EnvironmentFile=-$COMMON_ENV
Environment="OPENCODE_BINARY=$OPENCODE_BIN"
EOF
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_DROP"
}

write_state() {
  local restart_pending=$1 package_source=$2 package_fingerprint=$3
  local tmp="${STATE}.tmp.${BASHPID}"
  printf '%s\n' \
    "config_sha=$CONFIG_SHA" \
    "openchamber_sha=$APP_SHA" \
    "package_source_sha=$package_source" \
    "package_fingerprint=$package_fingerprint" \
    "openchamber_version=$EXPECTED_OPENCHAMBER_VERSION" \
    "opencode_version=$OPENCODE_VERSION" \
    "bind_host=$HOST" \
    "bind_port=$PORT" \
    "common_env_sha=$(file_sha256 "$COMMON_ENV")" \
    "restart_pending=$restart_pending" \
    > "$tmp"
  mv -f "$tmp" "$STATE"
}

ensure_node22
validate_bind_host
mkdir -p "$STATE_ROOT" "$CACHE_ROOT" "$UNIT_DIR"
exec 9>"$LOCK"
flock -x 9

TMP="$(mktemp -d /tmp/openchamber-v2-install.XXXXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT

CONFIG_SHA="$(ref_sha "$CONFIG_REPO" "$CONFIG_REF")"
APP_SHA="$(ref_sha "$APP_REPO" "$APP_REF")"

prev_config="$(state_value config_sha)"
prev_app="$(state_value openchamber_sha)"
prev_package_source="$(state_value package_source_sha)"
prev_package_fingerprint="$(state_value package_fingerprint)"
prev_host="$(state_value bind_host)"
prev_port="$(state_value bind_port)"
prev_env_sha="$(state_value common_env_sha)"
prev_restart_pending="$(state_value restart_pending)"

embedded_terminal=0
if inside_openchamber_terminal; then
  embedded_terminal=1
fi

effective_restart_mode="$RESTART_MODE"
if [[ "$effective_restart_mode" == auto && "$embedded_terminal" == 1 ]]; then
  effective_restart_mode=defer
  echo "Embedded OpenChamber terminal detected: runtime/service restart will be deferred."
elif [[ "$effective_restart_mode" == auto ]]; then
  effective_restart_mode=now
fi

# ---- OpenCode binary/config decisions -------------------------------------

installed_opencode=''
if [[ -x "$OPENCODE_BIN" ]]; then
  installed_opencode="$("$OPENCODE_BIN" --version 2>/dev/null | sed -E 's/^opencode[[:space:]]+v?//' || true)"
fi

opencode_binary_changed=0
if [[ "$installed_opencode" != "$OPENCODE_VERSION" || "$FORCE_OPENCODE_UPDATE" == 1 ]]; then
  opencode_binary_changed=1
fi

config_changed=0
if [[ "$CONFIG_SHA" != "$prev_config" || ! -f "$HOME/.config/opencode/opencode.json" || ! -d "$HOME/.config/opencode/agents" ]]; then
  config_changed=1
fi

if (( opencode_binary_changed == 1 || config_changed == 1 )); then
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/$CONFIG_REPO/contents/install.sh?ref=$CONFIG_REF" > "$TMP/install-opencode.sh"

  if (( opencode_binary_changed == 1 )); then
    echo "Installing/updating OpenCode binary to $OPENCODE_VERSION"
    OPENCODE_CONFIG_REPO="$CONFIG_REPO" \
    OPENCODE_CONFIG_REF="$CONFIG_REF" \
    OPENCODE_INSTALL_VERSION="$OPENCODE_VERSION" \
      bash "$TMP/install-opencode.sh"
  else
    echo "Config-only update: OpenCode binary $OPENCODE_VERSION is unchanged"
    OPENCODE_CONFIG_REPO="$CONFIG_REPO" \
    OPENCODE_CONFIG_REF="$CONFIG_REF" \
    OPENCODE_INSTALL_VERSION="$OPENCODE_VERSION" \
    OPENCODE_SKIP_BINARY_INSTALL=1 \
      bash "$TMP/install-opencode.sh"
  fi
else
  echo "OpenCode binary/config unchanged: downloads skipped"
fi

[[ -x "$OPENCODE_BIN" ]] || { echo "OpenCode binary missing: $OPENCODE_BIN" >&2; exit 1; }
installed_opencode="$("$OPENCODE_BIN" --version | sed -E 's/^opencode[[:space:]]+v?//')"
[[ "$installed_opencode" == "$OPENCODE_VERSION" ]] || {
  echo "OpenCode version mismatch: expected=$OPENCODE_VERSION actual=$installed_opencode" >&2
  exit 1
}

env_after="$(file_sha256 "$COMMON_ENV")"
env_changed=0
[[ "$env_after" == "$prev_env_sha" ]] || env_changed=1

# ---- OpenChamber package decision ----------------------------------------

manifest_available=0
PACKAGE_SOURCE_SHA=''
PACKAGE_FINGERPRINT=''
PACKAGE_TAG=''
PACKAGE_ASSET=''
PACKAGE_SHA256=''

fetch_package_manifest() {
  local tag="v2-web-package-$APP_SHA"
  local dir="$TMP/manifest"
  mkdir -p "$dir"
  if ! gh release download "$tag" \
      --repo "$APP_REPO" \
      --pattern manifest.json \
      --dir "$dir" \
      --clobber >/dev/null 2>&1; then
    return 1
  fi

  mapfile -t meta < <(node - "$dir/manifest.json" "$APP_SHA" "$EXPECTED_OPENCHAMBER_VERSION" <<'NODE'
const fs = require('node:fs');
const [file, expectedSource, expectedVersion] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
if (m.schema_version !== 1 ||
    m.platform !== 'linux-x64' ||
    m.source_sha !== expectedSource ||
    !/^[a-f0-9]{40}$/.test(String(m.package_source_sha || '')) ||
    m.package_tag !== `v2-web-package-${m.package_source_sha}` ||
    m.asset !== `openchamber-web-${m.package_source_sha}.tgz` ||
    !/^[a-f0-9]{64}$/.test(String(m.sha256 || '')) ||
    !/^[a-f0-9]{64}$/.test(String(m.runtime_fingerprint || '')) ||
    m.openchamber_version !== expectedVersion) {
  process.exit(1);
}
console.log([
  m.package_source_sha,
  m.runtime_fingerprint,
  m.package_tag,
  m.asset,
  m.sha256,
].join('\n'));
NODE
  )
  [[ "${#meta[@]}" -eq 5 ]] || return 1
  PACKAGE_SOURCE_SHA="${meta[0]}"
  PACKAGE_FINGERPRINT="${meta[1]}"
  PACKAGE_TAG="${meta[2]}"
  PACKAGE_ASSET="${meta[3]}"
  PACKAGE_SHA256="${meta[4]}"
  manifest_available=1
}

case "$OPENCHAMBER_PACKAGE_MODE" in
  auto|release)
    fetch_package_manifest || true
    ;;
  source) ;;
esac

if [[ "$OPENCHAMBER_PACKAGE_MODE" == release && "$manifest_available" != 1 ]]; then
  echo "Verified exact-SHA OpenChamber web package manifest is unavailable for $APP_REPO@$APP_SHA" >&2
  exit 1
fi

installed_openchamber="$(openchamber --version 2>/dev/null | sed -E 's/^OpenChamber[[:space:]]+v?//; s/^v//' || true)"
package_changed=0
runtime_needs_apply=0

if (( manifest_available == 1 )); then
  if [[ "$installed_openchamber" != "$EXPECTED_OPENCHAMBER_VERSION" ||
        "$prev_package_source" != "$PACKAGE_SOURCE_SHA" ||
        "$prev_restart_pending" == 1 ]]; then
    runtime_needs_apply=1
  fi
else
  PACKAGE_SOURCE_SHA="$APP_SHA"
  PACKAGE_FINGERPRINT="source-$APP_SHA"
  if [[ "$installed_openchamber" != "$EXPECTED_OPENCHAMBER_VERSION" ||
        "$prev_app" != "$APP_SHA" ||
        "$prev_restart_pending" == 1 ]]; then
    runtime_needs_apply=1
  fi
fi

cache_package_from_release() {
  local cache="$CACHE_ROOT/$PACKAGE_ASSET"
  if [[ -f "$cache" ]] && printf '%s  %s\n' "$PACKAGE_SHA256" "$cache" | sha256sum -c - >/dev/null 2>&1; then
    echo "Using cached verified OpenChamber package: $cache"
    PACKAGE_FILE="$cache"
    return 0
  fi

  local dir="$TMP/package"
  mkdir -p "$dir"
  gh release download "$PACKAGE_TAG" \
    --repo "$APP_REPO" \
    --pattern "$PACKAGE_ASSET" \
    --dir "$dir" \
    --clobber
  printf '%s  %s\n' "$PACKAGE_SHA256" "$dir/$PACKAGE_ASSET" | sha256sum -c -
  cp -f "$dir/$PACKAGE_ASSET" "$cache"
  PACKAGE_FILE="$cache"
}

build_source_package() {
  ensure_bun
  echo "Building OpenChamber fork $APP_REPO@$APP_SHA (release package unavailable)"
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
  [[ "${#packages[@]}" -eq 1 ]] || {
    echo 'Expected exactly one packed OpenChamber web package' >&2
    exit 1
  }

  local cache="$CACHE_ROOT/openchamber-web-$APP_SHA.tgz"
  cp -f "${packages[0]}" "$cache"
  PACKAGE_FILE="$cache"
}

PACKAGE_FILE=''
if (( runtime_needs_apply == 1 )); then
  if (( manifest_available == 1 )); then
    cache_package_from_release
  else
    build_source_package
  fi

  if [[ "$effective_restart_mode" == defer && -n "$installed_openchamber" ]]; then
    echo "OpenChamber runtime update cached but not activated to preserve the current terminal:"
    echo "  $PACKAGE_FILE"
  else
    ensure_bun
    bun add -g "$PACKAGE_FILE"
    package_changed=1
    installed_openchamber="$(openchamber --version 2>/dev/null | sed -E 's/^OpenChamber[[:space:]]+v?//; s/^v//' || true)"
    [[ "$installed_openchamber" == "$EXPECTED_OPENCHAMBER_VERSION" ]] || {
      echo "OpenChamber version mismatch after package install: expected=$EXPECTED_OPENCHAMBER_VERSION actual=$installed_openchamber" >&2
      exit 1
    }
  fi
else
  echo "OpenChamber runtime fingerprint/package unchanged: package download skipped"
fi

# Fresh install: there is no running OpenChamber runtime to preserve.
if [[ -z "$installed_openchamber" && -n "$PACKAGE_FILE" ]]; then
  ensure_bun
  bun add -g "$PACKAGE_FILE"
  package_changed=1
  installed_openchamber="$(openchamber --version 2>/dev/null | sed -E 's/^OpenChamber[[:space:]]+v?//; s/^v//' || true)"
fi

[[ "$installed_openchamber" == "$EXPECTED_OPENCHAMBER_VERSION" ]] || {
  if [[ "$effective_restart_mode" == defer && -n "$PACKAGE_FILE" ]]; then
    echo "Current OpenChamber remains $installed_openchamber; $EXPECTED_OPENCHAMBER_VERSION is staged for external apply."
  else
    echo "OpenChamber $EXPECTED_OPENCHAMBER_VERSION is not installed." >&2
    exit 1
  fi
}

PASSWORD_SOURCE=''
NEW_PASSWORD=''
sanitize_native_startup_env

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
export OPENCODE_BINARY="$OPENCODE_BIN"

drop_before="$(file_sha256 "$ENV_DROP")"
write_env_dropin
drop_after="$(file_sha256 "$ENV_DROP")"
drop_changed=0
[[ "$drop_before" == "$drop_after" ]] || drop_changed=1

service_active=0
systemctl --user is-active --quiet openchamber.service && service_active=1 || true

service_needs_reconcile=0
[[ -f "$UNIT" ]] || service_needs_reconcile=1
[[ "$prev_host" == "$HOST" ]] || service_needs_reconcile=1
[[ "$prev_port" == "$PORT" ]] || service_needs_reconcile=1
(( package_changed == 0 )) || service_needs_reconcile=1
(( opencode_binary_changed == 0 )) || service_needs_reconcile=1
(( env_changed == 0 )) || service_needs_reconcile=1
(( drop_changed == 0 )) || service_needs_reconcile=1
[[ -f "$NATIVE_STARTUP_ENV" ]] || service_needs_reconcile=1

restart_pending=0
if (( runtime_needs_apply == 1 && package_changed == 0 )); then
  restart_pending=1
fi

if [[ "$restart_pending" == 1 && "$package_changed" == 0 ]]; then
  # The desired package is staged, but activating it would replace the runtime
  # currently serving this terminal. Do not invoke startup through the old CLI.
  echo "OpenChamber package/service activation deferred; current console remains alive."
elif (( service_needs_reconcile == 1 )); then
  startup_args=(startup enable --host "$HOST" --port "$PORT" --no-env-snapshot)
  if [[ -n "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
    startup_args+=(--ui-password "$OPENCHAMBER_UI_PASSWORD")
  fi

  if [[ "$effective_restart_mode" == defer ]]; then
    startup_args+=(--no-start)
    openchamber "${startup_args[@]}"
    restart_pending=1
    echo "OpenChamber service restart deferred; current console remains alive."
  else
    openchamber "${startup_args[@]}"
    systemctl --user restart openchamber.service
    wait_for_service
    restart_pending=0
  fi
elif (( service_active == 0 )); then
  if [[ "$effective_restart_mode" == defer ]]; then
    systemctl --user enable openchamber.service >/dev/null
    restart_pending=1
    echo "OpenChamber service is installed but start is deferred."
  else
    systemctl --user enable --now openchamber.service
    wait_for_service
  fi
else
  echo "OpenChamber service unchanged and active: restart skipped"
fi

# Remove legacy password only after native persistence is verified and no apply
# is pending. Until then it remains the migration fallback.
if [[ "$restart_pending" == 0 && -f "$LEGACY_PASSWORD_ENV" && -n "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
  persisted_password="$(read_ui_password_from_env_file "$NATIVE_STARTUP_ENV" 2>/dev/null || true)"
  if [[ -n "$persisted_password" && "$persisted_password" == "$OPENCHAMBER_UI_PASSWORD" ]]; then
    rm -f -- "$LEGACY_PASSWORD_ENV"
    echo "Removed migrated legacy password file: $LEGACY_PASSWORD_ENV"
  fi
fi

# Retire obsolete 1.x overrides only after the new managed environment drop-in
# exists. They must not be allowed to override the V2 native unit later.
rm -f -- "$LEGACY_DROP_A" "$LEGACY_DROP_B"
systemctl --user daemon-reload

write_state "$restart_pending" "$PACKAGE_SOURCE_SHA" "$PACKAGE_FINGERPRINT"

echo
echo "SUCCESS: config=$CONFIG_SHA OpenChamber=$APP_SHA OpenCode=$installed_opencode"
if [[ "$restart_pending" == 1 ]]; then
  echo "PENDING APPLY: current OpenChamber terminal was preserved."
  if [[ -n "$PACKAGE_FILE" && "$package_changed" == 0 ]]; then
    echo "Run the same installer from SSH/external console with:"
    echo "  OPENCHAMBER_RESTART_MODE=now"
  else
    echo "Run from SSH/external console:"
    echo "  systemctl --user restart openchamber.service"
  fi
else
  echo "OpenChamber service: http://$HOST:$PORT"
fi
[[ -z "$NEW_PASSWORD" ]] || echo "NEW UI PASSWORD (store securely): $NEW_PASSWORD"
