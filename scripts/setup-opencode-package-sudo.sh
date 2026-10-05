#!/usr/bin/env bash
# Root-only bootstrap for on-demand package installation by the runtime user.
set -Eeuo pipefail
umask 077
RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
[[ "$RUNTIME_USER" == opencode ]] || {
  echo "Invalid runtime user '$RUNTIME_USER': required name is exactly opencode" >&2; exit 2;
}
[[ "$EUID" == 0 ]] || { echo 'Run sudo bootstrap as root from SSH' >&2; exit 2; }
[[ "$RUNTIME_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$RUNTIME_USER" != root ]] || exit 2
id "$RUNTIME_USER" >/dev/null
[[ "$(id -u "$RUNTIME_USER")" != 0 ]] || { echo "Runtime user must not have UID 0" >&2; exit 2; }
if ! command -v sudo >/dev/null || ! command -v visudo >/dev/null; then
  /usr/bin/apt-get update
  /usr/bin/apt-get install -y sudo
fi
for cmd in usermod getent install mktemp visudo; do command -v "$cmd" >/dev/null; done
getent group sudo >/dev/null || { echo 'Group sudo is missing' >&2; exit 1; }
usermod -aG sudo "$RUNTIME_USER"
# Optional prefix supports isolated packaging tests; production always uses /.
PREFIX="${OPENCODE_SUDO_PREFIX:-}"
[[ -z "$PREFIX" || "$PREFIX" == /* ]] || exit 2
HELPER="$PREFIX/usr/local/sbin/opencode-install-packages"
POLICY="$PREFIX/etc/sudoers.d/opencode-packages-$RUNTIME_USER"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
cat > "$TMP/helper" <<'HELPER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Use sudo -n /usr/local/sbin/opencode-install-packages' >&2; exit 2; }
case "${1:-}" in
  --check) [[ "$#" == 1 ]] || exit 2; echo 'Package installation sudo: READY'; exit 0;;
  update) [[ "$#" == 1 ]] || exit 2; exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get update;;
  install) shift; [[ "$#" -gt 0 ]] || exit 2;;
  *) echo 'Usage: opencode-install-packages --check|update|install package...' >&2; exit 2;;
esac
for package in "$@"; do
  # Package names only: no apt options, local deb files, hooks or shell snippets.
  [[ "$package" =~ ^[a-z0-9][a-z0-9+.-]*(:[a-z0-9-]+)?$ ]] || {
    echo "Invalid package name: $package" >&2; exit 2;
  }
done
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y -- "$@"
HELPER
printf '%s ALL=(root) NOPASSWD: %s\n' "$RUNTIME_USER" "$HELPER" > "$TMP/policy"
visudo -cf "$TMP/policy" >/dev/null
install -d -o root -g root -m 755 "$(dirname "$HELPER")" "$(dirname "$POLICY")"
install -o root -g root -m 755 "$TMP/helper" "$HELPER"
install -o root -g root -m 440 "$TMP/policy" "$POLICY"
visudo -cf "$POLICY" >/dev/null
echo "Package installation sudo configured for $RUNTIME_USER; start a new login shell."
