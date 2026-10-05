#!/usr/bin/env bash
# Root-only bootstrap for the narrow package-install helper used by opencode.
set -Eeuo pipefail
umask 077

RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
[[ "$RUNTIME_USER" == opencode ]] || {
  echo "Invalid runtime user '$RUNTIME_USER': required name is exactly opencode" >&2
  exit 2
}
[[ "$EUID" == 0 ]] || { echo 'Run sudo bootstrap as root' >&2; exit 2; }
id "$RUNTIME_USER" >/dev/null 2>&1 || { echo "Runtime user '$RUNTIME_USER' does not exist" >&2; exit 2; }
[[ "$(id -u "$RUNTIME_USER")" != 0 ]] || { echo "Runtime user must not have UID 0" >&2; exit 2; }

if ! command -v sudo >/dev/null 2>&1 || ! command -v visudo >/dev/null 2>&1; then
  /usr/bin/apt-get update
  /usr/bin/apt-get install -y sudo
fi
for cmd in install mktemp visudo; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done

# Optional prefix supports isolated packaging tests; production always uses /.
PREFIX="${OPENCODE_SUDO_PREFIX:-}"
[[ -z "$PREFIX" || "$PREFIX" == /* ]] || exit 2
PACKAGE_HELPER="$PREFIX/usr/local/sbin/opencode-install-packages"
POLICY="$PREFIX/etc/sudoers.d/opencode-packages-$RUNTIME_USER"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

cat > "$TMP/package-helper" <<'HELPER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Use sudo -n /usr/local/sbin/opencode-install-packages' >&2; exit 2; }
case "${1:-}" in
  --check)
    [[ "$#" == 1 ]] || exit 2
    echo 'Package installation sudo: READY'
    exit 0
    ;;
  update)
    [[ "$#" == 1 ]] || exit 2
    exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get update
    ;;
  install)
    shift
    [[ "$#" -gt 0 ]] || exit 2
    ;;
  *)
    echo 'Usage: opencode-install-packages --check|update|install package...' >&2
    exit 2
    ;;
esac
for package in "$@"; do
  [[ "$package" =~ ^[a-z0-9][a-z0-9+.-]*(:[a-z0-9-]+)?$ ]] || {
    echo "Invalid package name: $package" >&2
    exit 2
  }
done
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y -- "$@"
HELPER

printf '%s ALL=(root) NOPASSWD: %s\n' "$RUNTIME_USER" "$PACKAGE_HELPER" > "$TMP/policy"
visudo -cf "$TMP/policy" >/dev/null
install -d -o root -g root -m 755 "$(dirname "$PACKAGE_HELPER")" "$(dirname "$POLICY")"
install -o root -g root -m 755 "$TMP/package-helper" "$PACKAGE_HELPER"
install -o root -g root -m 440 "$TMP/policy" "$POLICY"
visudo -cf "$POLICY" >/dev/null
echo "Narrow package-install sudo configured for $RUNTIME_USER."
