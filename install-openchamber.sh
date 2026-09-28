#!/usr/bin/env bash
# One entry point for fresh installs, updates and repairs of OpenChamber + OpenCode.
# Downloads only the small exact-SHA manifest when the requested binary is present.
# Uses the same installed runtime and user systemd service; never runs source builds.
set -Eeuo pipefail

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-main}"
APP_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
APP_REF="${OPENCHAMBER_REF:-main}"
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/openchamber"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode/openchamber-install.state"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/openchamber.service"
DROP_DIR="$UNIT_DIR/openchamber.service.d"
DROP="$DROP_DIR/90-openchamber-runtime.conf"
LEGACY_DROP="$DROP_DIR/90-integration-bundle.conf"
PASSWORD_ENV="$HOME/.config/openchamber-live.env"
BIN="$HOME/.opencode/bin/opencode"
LOCK="$ROOT/.standard-install.lock"

case "${1:-}" in
  ''|--opencode-update) ;;
  --help) echo 'Usage: install-openchamber.sh [--opencode-update]'; echo 'Use OPENCHAMBER_REF and OPENCODE_CONFIG_REF to test integration refs.'; exit 0 ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
for cmd in gh curl tar node sha256sum mktemp flock systemctl ss ip; do
  if [[ "$cmd" != node ]] && ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing prerequisite: $cmd" >&2; exit 1
  fi
done
gh auth status >/dev/null 2>&1 || { echo 'Authenticate GitHub CLI with gh auth login' >&2; exit 1; }

ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  fi
  (( major >= 22 )) && return 0
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  [[ -s "$nvm_dir/nvm.sh" ]] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | PROFILE=/dev/null bash
  # shellcheck disable=SC1090
  . "$nvm_dir/nvm.sh"
  nvm install 22
  nvm alias default 22
  nvm use 22
  [[ -z "${NVM_BIN:-}" || ! -w /usr/local/bin ]] || ln -sfn "$NVM_BIN/node" /usr/local/bin/node
}
ensure_node
mkdir -p "$ROOT" "$(dirname "$STATE")" "$DROP_DIR" "$HOME/.opencode/bin" "$HOME/.config"
exec 9>"$LOCK"
flock -x 9
TMP="$(mktemp -d /tmp/openchamber-install.XXXXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT

ref_sha() { gh api "repos/$1/commits/$2" --jq .sha; }
state_value() { [[ ! -f "$STATE" ]] || sed -n "s/^$1=//p" "$STATE" | head -1; }
CONFIG_SHA="$(ref_sha "$CONFIG_REPO" "$CONFIG_REF")"
REF_SHA="$(ref_sha "$APP_REPO" "$APP_REF")"
TAG="linux-bundle-$REF_SHA"
MANIFEST="$TMP/manifest.json"
# Manifest download precedes the decision to transfer the large distribution.
gh release download "$TAG" --repo "$APP_REPO" --pattern manifest.json --dir "$TMP"
mapfile -t META < <(node - "$MANIFEST" "$REF_SHA" <<'NODE'
const fs=require('fs');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const expectedSource=process.argv[3];
if(![2,3].includes(m.schema_version) || m.platform!=='linux-x64' || m.source_sha!==expectedSource ||
   !/^[a-f0-9]{64}$/.test(String(m.sha256||'')) || !/^\d+\.\d+\.\d+$/.test(String(m.opencode_version||''))) process.exit(1);
const bundleSource=m.schema_version===3 ? m.bundle_source_sha : m.source_sha;
const bundleTag=m.schema_version===3 ? m.bundle_tag : `linux-bundle-${m.source_sha}`;
if(!/^[a-f0-9]{40}$/.test(String(bundleSource||'')) ||
   bundleTag!==`linux-bundle-${bundleSource}` ||
   m.asset!==`openchamber-integration-linux-x64-${bundleSource}.tar.gz`) process.exit(1);
if(m.schema_version===3 && !/^[a-f0-9]{64}$/.test(String(m.bundle_fingerprint||''))) process.exit(1);
console.log([m.asset,m.sha256,m.opencode_version,bundleTag,bundleSource].join('\n'));
NODE
)
[[ "${#META[@]}" == 5 ]] || { echo "Invalid distribution manifest for $REF_SHA" >&2; exit 1; }
ASSET="${META[0]}"; DIGEST="${META[1]}"; OPENCODE_VERSION="${META[2]}"
BUNDLE_TAG="${META[3]}"; BUNDLE_SOURCE_SHA="${META[4]}"
RELEASE="$ROOT/releases/$BUNDLE_SOURCE_SHA"

# The Docker bridge needs a host listener reachable by NPM. A wildcard bind
# also exposes loopback, which upstream uses for the managed OpenCode callback.
# The operator is responsible for restricting public access with a firewall.
# Hosts without this bridge retain the loopback-only default. Explicit override
# remains available for other network layouts and rollback.
if ip -4 addr show | grep -Fq 'inet 172.18.0.1/'; then default_host=0.0.0.0; else default_host=127.0.0.1; fi
HOST="${OPENCHAMBER_BIND_HOST:-$default_host}"
PORT="${OPENCHAMBER_BIND_PORT:-3000}"
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || { echo 'Invalid bind port' >&2; exit 1; }
if [[ "$HOST" != 127.0.0.1 && "$HOST" != localhost && "$HOST" != 0.0.0.0 ]]; then
  ip -4 addr show | grep -Fq "inet $HOST/" || { echo "Bind host $HOST not assigned" >&2; exit 1; }
fi
# Do not mistakenly replace a competing Docker proxy's port with this service.
if ss -H -lntp "sport = :$PORT" | grep -q 'docker-proxy'; then
  echo "Host port $PORT belongs to docker-proxy; update hh-auto first" >&2
  exit 1
fi

cached_release_ok() {
  [[ -f "$RELEASE/packages/web/bin/cli.js" && -f "$RELEASE/packages/sdk/dist/index.js" &&
     -x "$RELEASE/opencode-cli/node_modules/.bin/opencode" ]] || return 1
  [[ "$("$RELEASE/opencode-cli/node_modules/.bin/opencode" --version 2>/dev/null)" == "$OPENCODE_VERSION" ]]
}
installed_ok() {
  cached_release_ok && [[ -L "$ROOT/current" && "$(readlink -f "$ROOT/current")" == "$RELEASE" ]] &&
    [[ -x "$ROOT/bin/openchamber" && -x "$ROOT/bin/opencode" && -x /usr/local/bin/openchamber && -x "$BIN" ]] &&
    [[ "$("$BIN" --version 2>/dev/null)" == "$OPENCODE_VERSION" ]]
}
prev_config="$(state_value config_sha)"
prev_ref="$(state_value openchamber_sha)"
config_changed=0
[[ "$CONFIG_SHA" == "$prev_config" ]] || config_changed=1
binary_changed=0
installed_ok || binary_changed=1
ref_changed=0
[[ "$REF_SHA" == "$prev_ref" ]] || ref_changed=1
# Repair a missing/incorrect service without transferring an unchanged archive.
need_service=0
[[ -f "$DROP" ]] && grep -Fq -- "--host $HOST --port $PORT" "$DROP" 2>/dev/null || need_service=1
[[ -f "$UNIT" ]] || need_service=1
systemctl --user is-active --quiet openchamber.service || need_service=1
if (( config_changed == 0 && binary_changed == 0 && need_service == 0 && ref_changed == 0 )) && [[ "${1:-}" != --opencode-update ]]; then
  echo "Already current: OpenChamber $REF_SHA, bundle $BUNDLE_SOURCE_SHA, OpenCode $OPENCODE_VERSION; large downloads: 0"
  exit 0
fi
if (( config_changed == 0 && binary_changed == 0 && need_service == 0 && ref_changed == 1 )) && [[ "${1:-}" != --opencode-update ]]; then
  printf 'config_sha=%s\nopenchamber_sha=%s\nbundle_source_sha=%s\nopencode_version=%s\n' "$CONFIG_SHA" "$REF_SHA" "$BUNDLE_SOURCE_SHA" "$OPENCODE_VERSION" > "$STATE.tmp.$"
  mv -f "$STATE.tmp.$" "$STATE"
  echo "Advanced OpenChamber source to $REF_SHA using cached bundle $BUNDLE_SOURCE_SHA; large downloads: 0"
  exit 0
fi

BACKUP="$(mktemp -d "$ROOT/backups.XXXXXXXX")"
OLD_TARGET=''
[[ ! -L "$ROOT/current" ]] || OLD_TARGET="$(readlink -f "$ROOT/current")"
[[ ! -e /usr/local/bin/openchamber && ! -L /usr/local/bin/openchamber ]] || cp -a /usr/local/bin/openchamber "$BACKUP/launcher"
[[ ! -e "$BIN" && ! -L "$BIN" ]] || cp -a "$BIN" "$BACKUP/opencode"
[[ ! -e "$DROP" ]] || cp -a "$DROP" "$BACKUP/drop"
[[ ! -e "$LEGACY_DROP" ]] || cp -a "$LEGACY_DROP" "$BACKUP/legacy-drop"
[[ ! -e "$UNIT" ]] || cp -a "$UNIT" "$BACKUP/unit"
[[ ! -e "$PASSWORD_ENV" ]] || cp -a "$PASSWORD_ENV" "$BACKUP/password"
[[ ! -e "$STATE" ]] || cp -a "$STATE" "$BACKUP/state"
rollback() {
  local rc="$1" failed_line="$2"
  trap - ERR
  set +e
  if [[ -n "$OLD_TARGET" ]]; then ln -s "$OLD_TARGET" "$ROOT/.current-rollback.$$"; mv -Tf "$ROOT/.current-rollback.$$" "$ROOT/current"; else rm -f "$ROOT/current"; fi
  for spec in "launcher:/usr/local/bin/openchamber" "opencode:$BIN" "drop:$DROP" "legacy-drop:$LEGACY_DROP" "unit:$UNIT" "password:$PASSWORD_ENV" "state:$STATE"; do
    src="${spec%%:*}"; dest="${spec#*:}"
    rm -f "$dest"
    [[ ! -e "$BACKUP/$src" && ! -L "$BACKUP/$src" ]] || cp -a "$BACKUP/$src" "$dest"
  done
  systemctl --user daemon-reload
  [[ ! -f "$UNIT" ]] || systemctl --user restart openchamber.service
  echo "FAILED ($rc) at installer line $failed_line. Runtime restored; backup: $BACKUP" >&2
  exit "$rc"
}
trap 'rollback "$?" "$LINENO"' ERR

if (( binary_changed == 1 )); then
  if cached_release_ok; then
    echo "Using cached exact-SHA release $REF_SHA; large downloads: 0"
    ln -s "releases/$REF_SHA" "$ROOT/.current-new.$$"
    mv -Tf "$ROOT/.current-new.$$" "$ROOT/current"
  else
    echo "Downloading verified GitHub-built bundle $BUNDLE_SOURCE_SHA for OpenChamber source $REF_SHA"
    if [[ "$BUNDLE_TAG" == "$TAG" ]]; then
      gh release download "$TAG" --repo "$APP_REPO" \
        --pattern "$ASSET" --pattern install-linux-integration-bundle.sh --dir "$TMP"
    else
      gh release download "$TAG" --repo "$APP_REPO" \
        --pattern install-linux-integration-bundle.sh --dir "$TMP"
      gh release download "$BUNDLE_TAG" --repo "$APP_REPO" \
        --pattern "$ASSET" --dir "$TMP"
    fi
    printf '%s  %s\n' "$DIGEST" "$TMP/$ASSET" | sha256sum -c -
    bash "$TMP/install-linux-integration-bundle.sh" "$TMP/$ASSET" "$MANIFEST" "$ROOT"
  fi
fi
# Reconcile launchers even when only the config or service changed.
mkdir -p "$ROOT/bin" "$HOME/.opencode/bin"
cat > "$ROOT/bin/.openchamber.$$" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
base="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export OPENCODE_BINARY="$base/current/opencode-cli/node_modules/.bin/opencode"
export PATH="$base/current/opencode-cli/node_modules/.bin:$PATH"
exec node "$base/current/packages/web/bin/cli.js" "$@"
LAUNCHER
chmod 755 "$ROOT/bin/.openchamber.$$"
mv -f "$ROOT/bin/.openchamber.$$" "$ROOT/bin/openchamber"
ln -sfn "../current/opencode-cli/node_modules/.bin/opencode" "$ROOT/bin/opencode"
cat > /usr/local/bin/.openchamber-standard.$$ <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
set -a
[[ ! -f "$HOME/.config/opencode.env" ]] || . "$HOME/.config/opencode.env"
[[ ! -f "$HOME/.config/openchamber-live.env" ]] || . "$HOME/.config/openchamber-live.env"
set +a
exec "$HOME/.local/share/openchamber/bin/openchamber" "$@"
LAUNCHER
chmod 755 /usr/local/bin/.openchamber-standard.$$
mv -f /usr/local/bin/.openchamber-standard.$$ /usr/local/bin/openchamber
ln -s "$ROOT/bin/opencode" "$HOME/.opencode/bin/.opencode-standard.$$"
mv -Tf "$HOME/.opencode/bin/.opencode-standard.$$" "$BIN"

# Configuration installation is skipped for unchanged config commits, and
# always uses the already-verified bundled OpenCode instead of the official updater.
if (( config_changed == 1 )); then
  echo "Installing changed OpenCode config $CONFIG_SHA"
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/$CONFIG_REPO/contents/install.sh?ref=$CONFIG_REF" > "$TMP/config-install.sh"
  OPENCODE_CONFIG_REPO="$CONFIG_REPO" OPENCODE_CONFIG_REF="$CONFIG_REF" \
    OPENCODE_SKIP_BINARY_INSTALL=1 bash "$TMP/config-install.sh"
fi

set +u
[[ ! -f "$HOME/.config/opencode.env" ]] || . "$HOME/.config/opencode.env"
[[ ! -f "$PASSWORD_ENV" ]] || . "$PASSWORD_ENV"
set -u
NEW_PASSWORD=''
if [[ "$HOST" != 127.0.0.1 && "$HOST" != localhost && -z "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
  NEW_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
  (umask 077; printf 'OPENCHAMBER_UI_PASSWORD=%s\n' "$NEW_PASSWORD" > "$PASSWORD_ENV")
fi
if [[ ! -f "$UNIT" ]]; then
  cat > "$UNIT" <<'UNIT'
[Unit]
Description=OpenChamber web
After=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/bin/openchamber serve --foreground
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT
fi
cat > "$DROP" <<EOF
[Service]
EnvironmentFile=-$HOME/.config/opencode.env
EnvironmentFile=-$PASSWORD_ENV
Environment="OPENCODE_BINARY=$ROOT/bin/opencode"
ExecStart=
ExecStart=/usr/local/bin/openchamber serve --foreground --host $HOST --port $PORT
EOF
# The old one-off override is superseded by this permanent managed drop-in.
rm -f "$LEGACY_DROP"
systemctl --user daemon-reload
systemctl --user enable --now openchamber.service
systemctl --user restart openchamber.service
# systemctl can report active before Node has bound its HTTP socket. Observe
# the actual configured address and HTTP response, not an instantaneous status.
# A wildcard listener must be probed over loopback, not through 0.0.0.0.
PROBE_HOST="$HOST"
[[ "$HOST" != 0.0.0.0 ]] || PROBE_HOST=127.0.0.1
HTTP=''
ready=0
for attempt in {1..45}; do
  if systemctl --user is-active --quiet openchamber.service &&
     ss -H -lnt "sport = :$PORT" | grep -Fq "$HOST:$PORT"; then
    HTTP="$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "http://$PROBE_HOST:$PORT/" || true)"
    case "$HTTP" in
      200|301|302|303|307|308|401|403) ready=1; break ;;
    esac
  fi
  sleep 1
done
if (( ready != 1 )); then
  echo "OpenChamber did not become ready on $HOST:$PORT; last HTTP: ${HTTP:-unavailable}" >&2
  systemctl --user status openchamber.service --no-pager -l >&2 || true
  false
fi
[[ "$("$BIN" --version)" == "$OPENCODE_VERSION" ]]
"$ROOT/bin/openchamber" --version
printf 'config_sha=%s\nopenchamber_sha=%s\nbundle_source_sha=%s\nopencode_version=%s\n' "$CONFIG_SHA" "$REF_SHA" "$BUNDLE_SOURCE_SHA" "$OPENCODE_VERSION" > "$STATE.tmp.$"
mv -f "$STATE.tmp.$$" "$STATE"
trap - ERR
echo "SUCCESS: OpenChamber $REF_SHA (bundle $BUNDLE_SOURCE_SHA) + OpenCode $OPENCODE_VERSION; http://$PROBE_HOST:$PORT/ ($HTTP)"
echo "Bind: $HOST:$PORT (firewall is managed by the operator)"
echo "Rollback backup: $BACKUP"
[[ -z "$NEW_PASSWORD" ]] || echo "NEW UI PASSWORD (store securely): $NEW_PASSWORD"
