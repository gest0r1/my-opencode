#!/usr/bin/env bash
# Execute the real V2 core against deterministic fake external commands.
# This verifies the 1.x incremental behavior rather than only grepping for it.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/scripts/install-openchamber-v2-core.sh"
# The installed fixture is the pinned release, so the runtime counts as unchanged.
OC_VERSION="$(sed -n 's/^EXPECTED_OPENCHAMBER_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-\(.*\)}"$/\1/p' "$CORE")"
[[ -n "$OC_VERSION" ]] || { echo "FAIL: OpenChamber pin not found in core" >&2; exit 1; }
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT
# Isolate the process inventory boundary; detector semantics are tested in
# test_runtime_state_recovery.py, including malformed output and ps failure.
cp "$CORE" "$TMP_ROOT/core.sh"
CORE="$TMP_ROOT/core.sh"
printf 'print("external")\n' > "$TMP_ROOT/runtime-processes.py"

CONFIG_SHA="1111111111111111111111111111111111111111"
APP_SHA="2222222222222222222222222222222222222222"
OLD_APP_SHA="3333333333333333333333333333333333333333"
PACKAGE_SOURCE_SHA="4444444444444444444444444444444444444444"
PACKAGE_FINGERPRINT="5555555555555555555555555555555555555555555555555555555555555555"
PACKAGE_SHA256="6666666666666666666666666666666666666666666666666666666666666666"
CONFIG_REPO="test/config"
APP_REPO="test/openchamber"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file=$1 text=$2
  grep -Fq -- "$text" "$file" || fail "expected '$text' in $file"
}

assert_not_contains() {
  local file=$1 text=$2
  if grep -Fq -- "$text" "$file"; then
    fail "did not expect '$text' in $file"
  fi
}

write_fake_tools() {
  local fakebin=$1
  mkdir -p "$fakebin"

  cat > "$fakebin/gh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'gh %s\n' "$*" >> "$TRACE"

if [[ "${1:-}" == auth && "${2:-}" == status ]]; then
  exit 0
fi

if [[ "${1:-}" == api ]]; then
  args="$*"
  case "$args" in
    *"repos/$OPENCODE_CONFIG_REPO/commits/"*) printf '%s\n' "$CONFIG_SHA" ;;
    *"repos/$OPENCHAMBER_REPO/commits/"*) printf '%s\n' "$APP_SHA" ;;
    *"repos/$OPENCODE_CONFIG_REPO/contents/install.sh?ref="*)
      cat "$FAKE_INSTALLER"
      ;;
    *)
      echo "unexpected gh api: $args" >&2
      exit 91
      ;;
  esac
  exit 0
fi

if [[ "${1:-}" == release && "${2:-}" == download ]]; then
  shift 2
  tag="${1:-}"
  shift || true
  pattern=''
  dir=''
  while (($#)); do
    case "$1" in
      --pattern) pattern="${2:-}"; shift 2 ;;
      --dir) dir="${2:-}"; shift 2 ;;
      --repo|--clobber) [[ "$1" == --repo ]] && shift 2 || shift ;;
      *) shift ;;
    esac
  done
  if [[ "$pattern" == manifest.json && -f "$MANIFEST_FILE" ]]; then
    mkdir -p "$dir"
    cp "$MANIFEST_FILE" "$dir/manifest.json"
    printf 'release-manifest %s\n' "$tag" >> "$TRACE"
    exit 0
  fi
  printf 'unexpected-release-download tag=%s pattern=%s\n' "$tag" "$pattern" >> "$TRACE"
  exit 92
fi

echo "unexpected gh command: $*" >&2
exit 93
EOF

  cat > "$fakebin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'systemctl %s\n' "$*" >> "$TRACE"
if [[ "$*" == *"is-active"* ]]; then exit 0; fi
exit 0
EOF

  cat > "$fakebin/ip" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '2: br-test    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-test'
EOF

  cat > "$fakebin/ss" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'LISTEN 0 128 172.18.0.1:3000 0.0.0.0:*'
EOF

  cat > "$fakebin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'curl %s\n' "$*" >> "$TRACE"
if [[ "$*" == *"%{http_code}"* ]]; then
  printf '200'
  exit 0
fi
echo "unexpected network curl: $*" >&2
exit 94
EOF

  cat > "$fakebin/openchamber" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  --version)
    printf '%s\n' 'OpenChamber __OC_VERSION__'
    ;;
  startup)
    if [[ "${2:-}" == --help ]]; then
      printf '%s\n' 'startup enable --no-start --no-env-snapshot'
    else
      printf 'openchamber %s\n' "$*" >> "$TRACE"
    fi
    ;;
  *)
    echo "unexpected openchamber command: $*" >&2
    exit 95
    ;;
esac
EOF

  cat > "$fakebin/bun" <<'EOF'
#!/usr/bin/env bash
printf 'UNEXPECTED bun %s\n' "$*" >> "$TRACE"
exit 96
EOF


  sed -i "s/__OC_VERSION__/$OC_VERSION/" "$fakebin/openchamber"
  chmod +x "$fakebin"/*
}

write_fake_installer() {
  local file=$1
  cat > "$file" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'install skip=%s\n' "${OPENCODE_SKIP_BINARY_INSTALL:-0}" >> "$TRACE"
if [[ "${OPENCODE_SKIP_BINARY_INSTALL:-0}" != 1 ]]; then
  mkdir -p "$HOME/.opencode/bin"
  cat > "$HOME/.opencode/bin/opencode" <<'INNER'
#!/usr/bin/env bash
printf '%s\n' 'opencode 2.1.4'
INNER
  chmod +x "$HOME/.opencode/bin/opencode"
fi
EOF
  chmod +x "$file"
}

prepare_case() {
  local dir=$1 initial_opencode=$2 prev_config=$3 prev_app=$4
  local home="$dir/home"
  mkdir -p \
    "$home/.opencode/bin" \
    "$home/.config/opencode/agents" \
    "$home/.config/openchamber" \
    "$home/.config/systemd/user/openchamber.service.d" \
    "$home/.local/state/my-opencode"

  cat > "$home/.opencode/bin/opencode" <<EOF
#!/usr/bin/env bash
printf '%s\\n' 'opencode $initial_opencode'
EOF
  chmod +x "$home/.opencode/bin/opencode"
  printf '%s\n' '{}' > "$home/.config/opencode/opencode.json"
  printf '%s\n' 'TEST_VALUE=1' > "$home/.config/opencode.env"
  cat > "$home/.config/openchamber/startup.env" <<EOF
OPENCHAMBER_UI_PASSWORD=test-password
OPENCODE_BINARY=$home/.opencode/bin/opencode
EOF
  printf '%s\n' '[Unit]' 'Description=test OpenChamber' > "$home/.config/systemd/user/openchamber.service"
  cat > "$home/.config/systemd/user/openchamber.service.d/95-my-opencode-env.conf" <<EOF
# managed-by: my-opencode
[Service]
EnvironmentFile=-$home/.config/opencode.env
Environment="OPENCODE_BINARY=$home/.opencode/bin/opencode"
EOF

  cat > "$home/.config/opencode/.managed-generation.mjs" <<EOF
import fs from 'node:fs';
const [action, receipt] = process.argv.slice(2);
if (action === 'remote') console.log('$CONFIG_SHA');
else if (action === 'check') process.exit(fs.readFileSync(receipt, 'utf8').trim() === '$CONFIG_SHA' ? 0 : 1);
EOF
  printf '%s\n' "$prev_config" > "$home/.local/state/my-opencode/config-generation.json"

  local env_sha
  env_sha="$(sha256sum "$home/.config/opencode.env" | awk '{print $1}')"
  cat > "$home/.local/state/my-opencode/openchamber-v2-install.state" <<EOF
config_sha=$prev_config
openchamber_sha=$prev_app
package_source_sha=$PACKAGE_SOURCE_SHA
package_fingerprint=$PACKAGE_FINGERPRINT
package_sha256=$PACKAGE_SHA256
openchamber_version=$OC_VERSION
opencode_version=2.1.4
bind_host=172.18.0.1
bind_port=3000
common_env_sha=$env_sha
runtime_pending=0
service_restart_pending=0
EOF
}

run_case() {
  local name=$1 initial_opencode=$2 prev_config=$3 prev_app=$4 with_manifest=$5 restart_mode=${6:-now}
  local dir="$TMP_ROOT/$name"
  local fakebin="$dir/fakebin"
  local trace="$dir/trace.log"
  local output="$dir/output.log"
  local manifest="$dir/manifest.json"
  local installer="$dir/fake-install.sh"
  mkdir -p "$dir"
  : > "$trace"
  : > "$manifest"
  write_fake_tools "$fakebin"
  write_fake_installer "$installer"
  prepare_case "$dir" "$initial_opencode" "$prev_config" "$prev_app"

  if [[ "$with_manifest" == 1 ]]; then
    cat > "$manifest" <<EOF
{
  "schema_version": 1,
  "platform": "linux-x64",
  "source_sha": "$APP_SHA",
  "package_source_sha": "$PACKAGE_SOURCE_SHA",
  "package_tag": "v2-web-package-$PACKAGE_SOURCE_SHA",
  "asset": "openchamber-web-$PACKAGE_SOURCE_SHA.tgz",
  "sha256": "$PACKAGE_SHA256",
  "runtime_fingerprint": "$PACKAGE_FINGERPRINT",
  "openchamber_version": "$OC_VERSION"
}
EOF
  else
    rm -f "$manifest"
  fi

  HOME="$dir/home" \
  XDG_STATE_HOME="$dir/home/.local/state" \
  PATH="$fakebin:$PATH" \
  TRACE="$trace" \
  FAKE_INSTALLER="$installer" \
  MANIFEST_FILE="$manifest" \
  CONFIG_SHA="$CONFIG_SHA" \
  APP_SHA="$APP_SHA" \
  OPENCODE_CONFIG_REPO="$CONFIG_REPO" \
  OPENCODE_CONFIG_REF="$CONFIG_SHA" \
  OPENCHAMBER_REPO="$APP_REPO" \
  OPENCHAMBER_REF="$APP_SHA" \
  OPENCHAMBER_UI_PASSWORD='test-password' \
  OPENCHAMBER_RESTART_MODE="$restart_mode" \
  OPENCHAMBER_BIND_HOST=172.18.0.1 \
  OPENCHAMBER_BIND_PORT=3000 \
    bash "$CORE" > "$output" 2>&1 || {
      cat "$output" >&2
      fail "$name core execution failed"
    }

  printf '%s\n' "$dir"
}

# 1. Identical invocation refreshes configuration but preserves runtime downloads.
dir="$(run_case noop 2.1.4 "$CONFIG_SHA" "$APP_SHA" 0)"
assert_contains "$dir/output.log" 'Config-only update: OpenCode binary 2.1.4 is unchanged'
assert_contains "$dir/output.log" 'OpenChamber source/runtime metadata unchanged: release lookup skipped'
assert_contains "$dir/output.log" 'OpenChamber runtime fingerprint/package unchanged: package download skipped'
assert_contains "$dir/output.log" 'Delivery prepared:'
assert_not_contains "$dir/trace.log" 'systemctl --user restart openchamber.service'
assert_contains "$dir/trace.log" 'contents/install.sh'
assert_not_contains "$dir/trace.log" 'release download'
assert_not_contains "$dir/trace.log" 'openchamber startup enable'
assert_not_contains "$dir/trace.log" 'UNEXPECTED bun'

# 2. Config-only: fetch/run the config installer with binary installation disabled.
dir="$(run_case config-only 2.1.4 "$OLD_APP_SHA" "$APP_SHA" 0)"
assert_contains "$dir/output.log" 'Config-only update: OpenCode binary 2.1.4 is unchanged'
assert_contains "$dir/trace.log" 'contents/install.sh?ref='
assert_contains "$dir/trace.log" 'install skip=1'
assert_not_contains "$dir/trace.log" 'systemctl --user restart openchamber.service'
assert_not_contains "$dir/trace.log" 'release download'
assert_not_contains "$dir/trace.log" 'UNEXPECTED bun'

# 3. Binary-only: update OpenCode, but do not fetch/reinstall OpenChamber runtime.
dir="$(run_case binary-only 2.0.20 "$CONFIG_SHA" "$APP_SHA" 0)"
assert_contains "$dir/output.log" 'Installing/updating OpenCode binary to 2.1.4'
assert_contains "$dir/trace.log" 'install skip=0'
assert_contains "$dir/output.log" 'OpenChamber runtime fingerprint/package unchanged: package download skipped'
assert_not_contains "$dir/trace.log" 'release download'
assert_not_contains "$dir/trace.log" 'UNEXPECTED bun'
assert_not_contains "$dir/trace.log" 'openchamber startup enable'
assert_not_contains "$dir/trace.log" 'systemctl --user restart openchamber.service'

# 4. OpenChamber source SHA advances but runtime fingerprint points to the same
# package source: download only the small exact-SHA manifest, not the package.
dir="$(run_case app-sha-reuse 2.1.4 "$CONFIG_SHA" "$OLD_APP_SHA" 1)"
assert_contains "$dir/trace.log" "release-manifest v2-web-package-$APP_SHA"
assert_contains "$dir/output.log" 'OpenChamber runtime fingerprint/package unchanged: package download skipped'
assert_not_contains "$dir/trace.log" 'unexpected-release-download'
assert_not_contains "$dir/trace.log" 'UNEXPECTED bun'
assert_contains "$dir/home/.local/state/my-opencode/openchamber-v2-install.state" "openchamber_sha=$APP_SHA"
assert_contains "$dir/home/.local/state/my-opencode/openchamber-v2-install.state" "package_source_sha=$PACKAGE_SOURCE_SHA"

echo 'PASS: incremental V2 execution keeps binary/config/runtime/service updates independent'


# Config-only updates inside the running console must report pending activation
# and preserve the console instead of silently leaving stale agents live.
dir="$(run_case config-defer 2.1.4 "$CONFIG_SHA" "$APP_SHA" 0 defer)"
assert_contains "$dir/home/.local/state/my-opencode/openchamber-v2-install.state" 'effective_restart_mode=defer'
assert_contains "$dir/output.log" 'Delivery prepared:'
assert_not_contains "$dir/trace.log" 'systemctl --user restart openchamber.service'
assert_contains "$dir/home/.local/state/my-opencode/openchamber-v2-install.state" 'service_restart_pending=1'

