#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
export EXPECTED_OPENCHAMBER_VERSION='2.1.0'
# Deliberately use a non-default root so the managed launcher cannot silently
# hard-code ~/.local/share/openchamber-v2.
export OPENCHAMBER_RUNTIME_ROOT="$HOME/custom/openchamber-runtime"
export BUN_INSTALL="$HOME/.bun"
export LEGACY_BUN_INSTALL="$HOME/.bun"
export SYSTEMCTL_LOG="$TMP/systemctl.log"
mkdir -p "$HOME" "$TMP/bin"

cat > "$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
if [[ "$*" == '--user is-active --quiet openchamber.service' ]]; then
  exit 0
fi
exit 0
EOF
chmod 755 "$TMP/bin/systemctl"
export PATH="$TMP/bin:$PATH"

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

# Atomic current publication and runtime-only rollback.
oc_activate_release "$r1"
test "$(readlink -f "$OPENCHAMBER_CURRENT")" = "$r1"
test "$("$OPENCHAMBER_MANAGED_BIN" --version)" = 'OpenChamber 2.1.0'
grep -Fq "$OPENCHAMBER_CURRENT_BIN" "$OPENCHAMBER_MANAGED_BIN"
oc_commit_activation

oc_activate_release "$r2"
test "$(readlink -f "$OPENCHAMBER_CURRENT")" = "$r2"
oc_rollback_activation
test "$(readlink -f "$OPENCHAMBER_CURRENT")" = "$r1"
test "$("$OPENCHAMBER_MANAGED_BIN" --version)" = 'OpenChamber 2.1.0'

# Binary activation never writes service units/env or controls systemd.
test ! -s "$SYSTEMCTL_LOG"
# Retention contract: keep current + immediate previous only.
r3="$(make_release release-three)"
oc_commit_activation
oc_activate_release "$r2"
oc_commit_activation
oc_activate_release "$r3"
oc_prune_releases
test -d "$r3"
test -d "$r2"
test ! -d "$r1"
oc_rollback_activation
test "$(readlink -f "$OPENCHAMBER_CURRENT")" = "$r2"

echo 'PASS: immutable OpenChamber runtime, binary rollback and bounded retention'
