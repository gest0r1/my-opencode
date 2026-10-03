#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
export EXPECTED_OPENCHAMBER_VERSION='2.1.0'
export OPENCHAMBER_RUNTIME_ROOT="$HOME/.local/share/openchamber-v2"
export BUN_INSTALL="$HOME/.bun"
export LEGACY_BUN_INSTALL="$HOME/.bun"
mkdir -p "$HOME"

# shellcheck disable=SC1091
source "$ROOT/scripts/openchamber-runtime-store.sh"
oc_runtime_init

make_release() {
  local name=$1
  local dir="$OPENCHAMBER_RELEASES/$name"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/openchamber" <<'EOF'
#!/usr/bin/env bash
printf 'OpenChamber 2.1.0\n'
EOF
  chmod 755 "$dir/bin/openchamber"
  printf '%s\n' "$dir"
}

r1="$(make_release release-one)"
r2="$(make_release release-two)"

oc_activate_release "$r1"
test "$(readlink -f "$OPENCHAMBER_CURRENT")" = "$r1"
test "$("$OPENCHAMBER_MANAGED_BIN" --version)" = 'OpenChamber 2.1.0'
oc_commit_activation

oc_activate_release "$r2"
test "$(readlink -f "$OPENCHAMBER_CURRENT")" = "$r2"
oc_rollback_activation
test "$(readlink -f "$OPENCHAMBER_CURRENT")" = "$r1"
test "$("$OPENCHAMBER_MANAGED_BIN" --version)" = 'OpenChamber 2.1.0'

echo 'PASS: immutable OpenChamber current activation and rollback'
