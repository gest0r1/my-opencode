#!/usr/bin/env bash
# Root-only bootstrap for narrow privileged operations used by the runtime user.
set -Eeuo pipefail
umask 077
RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
[[ "$RUNTIME_USER" == opencode ]] || {
  echo "Invalid runtime user '$RUNTIME_USER': required name is exactly opencode" >&2; exit 2;
}
[[ "$EUID" == 0 ]] || { echo 'Run sudo bootstrap as root' >&2; exit 2; }
[[ "$RUNTIME_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$RUNTIME_USER" != root ]] || exit 2
id "$RUNTIME_USER" >/dev/null
[[ "$(id -u "$RUNTIME_USER")" != 0 ]] || { echo "Runtime user must not have UID 0" >&2; exit 2; }
if ! command -v sudo >/dev/null || ! command -v visudo >/dev/null; then
  /usr/bin/apt-get update
  /usr/bin/apt-get install -y sudo
fi
for cmd in getent install mktemp visudo; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done

# Optional prefix supports isolated packaging tests; production always uses /.
PREFIX="${OPENCODE_SUDO_PREFIX:-}"
[[ -z "$PREFIX" || "$PREFIX" == /* ]] || exit 2
PACKAGE_HELPER="$PREFIX/usr/local/sbin/opencode-install-packages"
CUTOVER_HELPER="$PREFIX/usr/local/sbin/opencode-runtime-cutover"
POLICY="$PREFIX/etc/sudoers.d/opencode-packages-$RUNTIME_USER"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

# All privileged migration code is root-owned. Never execute scripts from a
# runtime-writable home through a passwordless sudo helper.
HELPER_DIR="$PREFIX/usr/local/lib/my-opencode"
install -d -o root -g root -m 755 "$HELPER_DIR"
for file in runtime-processes.py migrate-runtime-state.py finalize-runtime-migration.py bootstrap-runtime-tools.sh; do
  source_file="$(dirname "${BASH_SOURCE[0]}")/$file"
  if [[ ! -f "$source_file" ]]; then
    command -v gh >/dev/null || { echo "Missing helper $file and GitHub CLI" >&2; exit 1; }
    CONFIG_SHA="${CONFIG_SHA:-$(gh api "repos/${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}/commits/${OPENCODE_CONFIG_REF:-main}" --jq .sha)}"
    [[ "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 1
    source_file="$TMP/$file"
    gh api -H 'Accept: application/vnd.github.raw' "repos/${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}/contents/scripts/$file?ref=$CONFIG_SHA" > "$source_file"
  fi
  install -o root -g root -m 755 "$source_file" "$HELPER_DIR/$file"
done

cat > "$TMP/package-helper" <<'HELPER'
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

cat > "$TMP/cutover-helper" <<'HELPER'
#!/usr/bin/env bash
# Fixed-purpose privileged bridge for retiring/restoring the old root runtime.
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Use sudo -n /usr/local/sbin/opencode-runtime-cutover' >&2; exit 2; }
STATE=/run/my-opencode-runtime-cutover.state
ROOT_RUNTIME_DIR=/run/user/0

root_user_systemctl() {
  env XDG_RUNTIME_DIR="$ROOT_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="unix:path=$ROOT_RUNTIME_DIR/bus" systemctl --user "$@"
}

legacy_stop() {
  [[ ! -e "$STATE" ]] || { echo 'Legacy runtime cutover is already active' >&2; exit 2; }
  console="$(python3 /usr/local/lib/my-opencode/runtime-processes.py --ancestor "$PPID")"
  [[ "$console" == external ]] || { echo 'PENDING APPLY: use external SSH for cutover' >&2; return 1; }
  : > "$STATE"
  chmod 600 "$STATE"

  if [[ -S "$ROOT_RUNTIME_DIR/bus" ]]; then
    for unit in openchamber.service opencode-web.service opencode-web-reboot.path; do
      if root_user_systemctl is-active --quiet "$unit"; then
        printf 'user\t%s\n' "$unit" >> "$STATE"
        root_user_systemctl stop "$unit"
      fi
    done
  fi

  for unit in openchamber.service opencode-web.service; do
    if systemctl cat "$unit" >/dev/null 2>&1; then
      owner="$(systemctl show "$unit" -p User --value)"
    else
      continue
    fi
    if [[ "$owner" == root || -z "$owner" ]] && systemctl is-active --quiet "$unit"; then
      printf 'system\t%s\n' "$unit" >> "$STATE"
      systemctl stop "$unit"
    fi
  done
  # Retire a native background service that was not registered with systemd.
  root_inventory="$(python3 /usr/local/lib/my-opencode/runtime-processes.py --uid 0)"
  if [[ "$root_inventory" != '[]' && -x /root/.opencode/bin/opencode ]]; then
    if env -i HOME=/root PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin /root/.opencode/bin/opencode service --help | grep -q stop; then
      printf 'native\topencode\n' >> "$STATE"
      env -i HOME=/root PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin /root/.opencode/bin/opencode service stop
    fi
  fi
  python3 /usr/local/lib/my-opencode/runtime-processes.py --uid 0 --require-stopped
  python3 /usr/local/lib/my-opencode/finalize-runtime-migration.py
}

legacy_restore() {
  [[ -f "$STATE" ]] || exit 0
  while IFS=$'\t' read -r scope unit; do
    [[ -n "$scope" && -n "$unit" ]] || continue
    case "$scope" in
      user)
        [[ -S "$ROOT_RUNTIME_DIR/bus" ]] && root_user_systemctl start "$unit" || return 1
        ;;
      system)
        systemctl start "$unit" || return 1
        ;;
      native)
        env -i HOME=/root PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin /root/.opencode/bin/opencode service start || return 1
        ;;
    esac
  done < "$STATE"
  rm -f -- "$STATE"
}

legacy_commit() {
  # Stop state was already validated by the new runtime. Retire only the fixed
  # legacy unit names; no arbitrary systemctl arguments are accepted here.
  if [[ -S "$ROOT_RUNTIME_DIR/bus" ]]; then
    root_user_systemctl disable openchamber.service >/dev/null 2>&1 || true
    root_user_systemctl disable opencode-web.service >/dev/null 2>&1 || true
    root_user_systemctl disable opencode-web-reboot.path >/dev/null 2>&1 || true
  fi
  rm -f -- \
    /root/.config/systemd/user/default.target.wants/openchamber.service \
    /root/.config/systemd/user/default.target.wants/opencode-web.service \
    /root/.config/systemd/user/default.target.wants/opencode-web-reboot.path \
    /root/.config/systemd/user/paths.target.wants/opencode-web-reboot.path
  systemctl disable openchamber.service >/dev/null 2>&1 || true
  systemctl disable opencode-web.service >/dev/null 2>&1 || true
  rm -f -- "$STATE"
}

case "${1:-}" in
  --check)
    [[ "$#" == 1 ]] || exit 2
    echo 'Runtime cutover sudo: READY migration-v2'
    ;;
  legacy-stop)
    [[ "$#" == 1 ]] || exit 2
    legacy_stop
    ;;
  legacy-restore)
    [[ "$#" == 1 ]] || exit 2
    legacy_restore
    ;;
  legacy-commit)
    [[ "$#" == 1 ]] || exit 2
    legacy_commit
    ;;
  *)
    echo 'Usage: opencode-runtime-cutover --check|legacy-stop|legacy-restore|legacy-commit' >&2
    exit 2
    ;;
esac
HELPER

printf '%s ALL=(root) NOPASSWD: %s, %s\n' "$RUNTIME_USER" "$PACKAGE_HELPER" "$CUTOVER_HELPER" > "$TMP/policy"
visudo -cf "$TMP/policy" >/dev/null
install -d -o root -g root -m 755 "$(dirname "$PACKAGE_HELPER")" "$(dirname "$POLICY")"
install -o root -g root -m 755 "$TMP/package-helper" "$PACKAGE_HELPER"
install -o root -g root -m 755 "$TMP/cutover-helper" "$CUTOVER_HELPER"
install -o root -g root -m 440 "$TMP/policy" "$POLICY"
visudo -cf "$POLICY" >/dev/null
echo "Narrow sudo helpers configured for $RUNTIME_USER."
