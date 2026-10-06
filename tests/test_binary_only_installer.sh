#!/usr/bin/env bash
# Dynamic contract for the small install.sh bootstrap.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP="$ROOT/install.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

CONFIG_SHA="1111111111111111111111111111111111111111"
APP_SHA="2222222222222222222222222222222222222222"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  grep -Fq -- "$2" "$1" || fail "expected '$2' in $1"
}

assert_not_contains() {
  if grep -Fq -- "$2" "$1"; then
    fail "did not expect '$2' in $1"
  fi
}

write_fake_tools() {
  local fakebin=$1
  mkdir -p "$fakebin"
  cat > "$fakebin/id" <<'EOF'
#!/bin/bash
case "$1" in -un) echo opencode;; -u) echo 1234;; *) /usr/bin/id "$@";; esac
EOF
  cat > "$fakebin/getent" <<'EOF'
#!/bin/bash
echo "opencode:x:1234:1234::$HOME:/bin/bash"
EOF
  printf '#!/bin/sh\nexit 0\n' > "$fakebin/sudo"
  chmod +x "$fakebin/id" "$fakebin/getent" "$fakebin/sudo"

  cat > "$fakebin/gh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'gh %s\n' "$*" >> "$TRACE"
if [[ "${1:-}" == auth && "${2:-}" == status ]]; then
  exit 0
fi
if [[ "${1:-}" == api ]]; then
  if [[ "$*" == *"contents/scripts/bootstrap-runtime-tools.sh?ref="* ]]; then
    printf 'ensure_runtime_node() { :; }\nensure_claude_cli() { :; }\nconfigure_server_browser() { :; }\n'
    exit 0
  fi
  if [[ "$*" == *"contents/scripts/install-opencode-generation.sh?ref="* ]]; then
    cat "$FAKE_GENERATION"
    exit 0
  fi
fi
echo "unexpected gh command: $*" >&2
exit 91
EOF

  cat > "$fakebin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'curl %s\n' "$*" >> "$TRACE"
if [[ "$*" == *"https://opencode.ai/v2/install"* ]]; then
  cat "$FAKE_OFFICIAL_INSTALLER"
  exit 0
fi
echo "unexpected curl: $*" >&2
exit 92
EOF

  cat > "$fakebin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$TRACE"
EOF
  chmod +x "$fakebin/systemctl"
  chmod +x "$fakebin/gh" "$fakebin/curl"
}

write_official_installer() {
  local file=$1
  cat > "$file" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'official-installer %s\n' "$*" >> "$TRACE"
mkdir -p "$HOME/.opencode/bin"
cat > "$HOME/.opencode/bin/opencode" <<'INNER'
#!/usr/bin/env bash
if [[ "$1" == serve ]]; then echo '--hostname --port'; else printf '%s\n' 'opencode 2.0.23'; fi
INNER
chmod +x "$HOME/.opencode/bin/opencode"
EOF
}

write_generation_stub() {
  local file=$1
  cat > "$file" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'generation skip_binary=%s\n' "${OPENCODE_SKIP_BINARY_INSTALL:-0}" >> "$TRACE"
EOF
}

prepare_home() {
  local home=$1 current_version=$2 state_sha=$3
  mkdir -p \
    "$home/.opencode/bin" \
    "$home/.config/opencode/agents" \
    "$home/.local/state/my-opencode"
  printf '%s\n' '{}' > "$home/.config/opencode/opencode.json"
  cat > "$home/.opencode/bin/opencode" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == serve ]]; then echo '--hostname --port'; else printf '%s\\n' 'opencode $current_version'; fi
EOF
  chmod +x "$home/.opencode/bin/opencode"
  cat > "$home/.local/state/my-opencode/openchamber-v2-install.state" <<EOF
config_sha=$state_sha
EOF
}

run_bootstrap() {
  local name=$1 current_version=$2 state_sha=$3 openchamber_ref=$4 skip_binary=$5
  local dir="$TMP_ROOT/$name"
  local home="$dir/home"
  local fakebin="$dir/fakebin"
  local trace="$dir/trace.log"
  local output="$dir/output.log"
  local official="$dir/official.sh"
  local generation="$dir/generation.sh"
  mkdir -p "$dir"
  : > "$trace"
  write_fake_tools "$fakebin"
  write_official_installer "$official"
  write_generation_stub "$generation"
  prepare_home "$home" "$current_version" "$state_sha"
  cat > "$home/.config/opencode/.managed-generation.mjs" <<EOF
import fs from 'node:fs';
const [action, receipt] = process.argv.slice(2);
if (action === 'remote') console.log('$CONFIG_SHA');
else if (action === 'check') process.exit(fs.readFileSync(receipt, 'utf8').trim() === '$CONFIG_SHA' ? 0 : 1);
EOF
  printf '%s\n' "$state_sha" > "$home/.local/state/my-opencode/config-generation.json"


  HOME="$home" \
  XDG_STATE_HOME="$home/.local/state" \
  PATH="$fakebin:$PATH" \
  TRACE="$trace" \
  FAKE_OFFICIAL_INSTALLER="$official" \
  FAKE_GENERATION="$generation" \
  OPENCODE_CONFIG_REPO='test/config' \
  OPENCODE_CONFIG_REF="$CONFIG_SHA" \
  OPENCHAMBER_REF="$openchamber_ref" \
  OPENCODE_SKIP_BINARY_INSTALL="$skip_binary" \
    bash "$BOOTSTRAP" > "$output" 2>&1 || {
      cat "$output" >&2
      fail "$name failed"
    }

  printf '%s\n' "$dir"
}

# Every invocation delegates a complete config generation. Identical binary
# stays installed; an older binary is updated by the generation transaction.
dir="$(run_bootstrap older-binary 2.0.20 "$CONFIG_SHA" "$APP_SHA" 0)"
assert_contains "$dir/trace.log" 'contents/scripts/install-opencode-generation.sh'
assert_contains "$dir/trace.log" 'generation skip_binary=0'
assert_not_contains "$dir/trace.log" 'curl '
dir="$(run_bootstrap config-only 2.0.23 "$CONFIG_SHA" "$APP_SHA" 1)"
assert_contains "$dir/trace.log" 'generation skip_binary=1'
dir="$(run_bootstrap identical 2.0.23 "$CONFIG_SHA" '' 0)"
assert_contains "$dir/trace.log" 'contents/scripts/install-opencode-generation.sh'
assert_contains "$dir/trace.log" 'generation skip_binary=1'
assert_not_contains "$dir/trace.log" 'curl '
echo 'PASS: every bootstrap refreshes config; unchanged binary is reused'

