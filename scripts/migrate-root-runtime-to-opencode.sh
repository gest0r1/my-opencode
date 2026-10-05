#!/usr/bin/env bash
# One-shot migration of the OpenCode/OpenChamber runtime from root to user opencode.
# Source data is copied, not deleted. Re-run is safe: existing target files are not overwritten.
set -Eeuo pipefail
umask 077

RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
SOURCE_HOME="${OPENCODE_MIGRATION_SOURCE_HOME:-/root}"
MIGRATE_PROJECTS="${OPENCODE_MIGRATE_PROJECTS:-1}"
SOURCE_PROJECTS="${OPENCODE_SOURCE_PROJECTS:-$SOURCE_HOME/projects}"

[[ "$RUNTIME_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$RUNTIME_USER" != root ]] || {
  echo 'OPENCODE_RUNTIME_USER must name a non-root Linux user' >&2; exit 2;
}
[[ "$MIGRATE_PROJECTS" == 0 || "$MIGRATE_PROJECTS" == 1 ]] || {
  echo 'OPENCODE_MIGRATE_PROJECTS must be 0 or 1' >&2; exit 2;
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this migration as root from SSH/external console." >&2
  exit 2
fi
if [[ "${OPENCHAMBER_EMBEDDED_TERMINAL:-}" == 1 ]]; then
  echo "Do not migrate from the embedded OpenChamber terminal. Use SSH/external console." >&2
  exit 2
fi

for cmd in id getent cut useradd cp mkdir chown chmod loginctl systemctl runuser date python3 realpath flock; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
SOURCE_HOME="$(realpath -e -- "$SOURCE_HOME")"
[[ "$SOURCE_HOME" != / ]] || { echo 'Source home cannot be /' >&2; exit 2; }
exec 9>/run/lock/my-opencode-user-migration.lock
flock -n 9 || { echo 'Another runtime migration is active' >&2; exit 2; }

if ! id "$RUNTIME_USER" >/dev/null 2>&1; then
  echo "Creating runtime user: $RUNTIME_USER"
  useradd --create-home --shell /bin/bash "$RUNTIME_USER"
fi

RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6)"
RUNTIME_GROUP="$(id -gn "$RUNTIME_USER")"
RUNTIME_UID="$(id -u "$RUNTIME_USER")"
[[ "$RUNTIME_UID" -ne 0 && "$RUNTIME_HOME" == /* && "$RUNTIME_HOME" != / && "$RUNTIME_HOME" != "$SOURCE_HOME" ]] || {
  echo "Invalid runtime home for '$RUNTIME_USER': '$RUNTIME_HOME'" >&2
  exit 1
}
mkdir -p "$RUNTIME_HOME"
RUNTIME_HOME="$(realpath -e -- "$RUNTIME_HOME")"
[[ "$RUNTIME_HOME" != "$SOURCE_HOME" && "$RUNTIME_HOME" != "$SOURCE_HOME/"* && "$SOURCE_HOME" != "$RUNTIME_HOME/"* ]] || {
  echo 'Source and runtime homes must not overlap' >&2; exit 2;
}
TARGET_PROJECTS="${OPENCODE_TARGET_PROJECTS:-$RUNTIME_HOME/projects}"
TARGET_PROJECTS="$(realpath -m -- "$TARGET_PROJECTS")"
[[ "$MIGRATE_PROJECTS" == 0 || "$TARGET_PROJECTS" == "$RUNTIME_HOME/"* ]] || {
  echo 'Target projects must be inside the runtime home' >&2; exit 2;
}

# Start/validate the new user manager before stopping the old runtime.
loginctl enable-linger "$RUNTIME_USER"
systemctl start "user@${RUNTIME_UID}.service"
RUNTIME_ENV=(env -i HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER"
  PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
  XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNTIME_UID/bus")
runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" systemctl --user show-environment >/dev/null
# Verify interpreter availability in the new user's clean environment. Root's
# private Node installation cannot be used by the non-root runtime.
runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" node -e \
  'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  echo 'Install system-wide Node.js 22+ before migrating (root-private Node is not accessible).' >&2; exit 1;
}
STOPPED_USER_UNITS=()
STOPPED_SYSTEM_UNITS=()
ROOT_USER_ENV=(env XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus)
recover_services() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 )); then
    for unit in "${STOPPED_USER_UNITS[@]}"; do "${ROOT_USER_ENV[@]}" systemctl --user start "$unit" || true; done
    for unit in "${STOPPED_SYSTEM_UNITS[@]}"; do systemctl start "$unit" || true; done
    echo 'Migration failed; previously active root services were restarted. Source data is intact.' >&2
  fi
  exit "$rc"
}
trap recover_services EXIT

# Stop root-owned user services that could keep the old runtime on the same port.
if [[ -S /run/user/0/bus ]]; then
  for unit in openchamber.service opencode-web.service opencode-web-reboot.path; do
    if "${ROOT_USER_ENV[@]}" systemctl --user is-active --quiet "$unit"; then
      STOPPED_USER_UNITS+=("$unit")
      "${ROOT_USER_ENV[@]}" systemctl --user stop "$unit"
    fi
  done
fi
for unit in openchamber.service opencode-web.service; do
  owner="$(systemctl show "$unit" -p User --value 2>/dev/null || true)"
  if [[ "$owner" == root || -z "$owner" ]] && systemctl is-active --quiet "$unit"; then
    STOPPED_SYSTEM_UNITS+=("$unit")
    systemctl stop "$unit"
  fi
done

copy_item() {
  local rel="$1" src="$SOURCE_HOME/$1" dst="$RUNTIME_HOME/$1"
  [[ -e "$src" || -L "$src" ]] || return 0
  mkdir -p "$(dirname "$dst")"
  if [[ -d "$src" && ! -L "$src" ]]; then
    mkdir -p "$dst"
    migration_copy "$src" "$dst"
  else
    migration_copy "$src" "$dst"
  fi
  echo "Migrated: $src -> $dst"
}

# Relocate only newly copied files; existing target files always win. Never follow
# directory symlinks or change project source/history/database contents.
migration_copy() {
  python3 - "$1" "$2" "$SOURCE_HOME" "$RUNTIME_HOME" "$SOURCE_PROJECTS" "$TARGET_PROJECTS" <<'PY'
import os, pathlib, re, shutil, sys
src, dst, old, new, old_projects, new_projects = sys.argv[1:]
def relocate(value):
    for before, after in ((old_projects, new_projects), (old, new)):
        if value == before or value.startswith(before + '/'):
            return after + value[len(before):]
    return value
def copy(a, b):
    # Reject destination symlink ancestors instead of writing through them.
    p = pathlib.Path(b).parent
    while str(p) != '/':
        if p.is_symlink():
            raise RuntimeError('Destination symlink ancestor: ' + str(p))
        p = p.parent
    if os.path.islink(a):
        if not os.path.lexists(b): os.symlink(relocate(os.readlink(a)), b)
    elif os.path.isdir(a):
        if os.path.lexists(b) and not os.path.isdir(b): raise RuntimeError('Target is not a directory: ' + b)
        os.makedirs(b, exist_ok=True)
        for name in os.listdir(a): copy(os.path.join(a, name), os.path.join(b, name))
    elif not os.path.lexists(b):
        shutil.copy2(a, b)
        rel = os.path.relpath(b, new)
        editable = (rel in ('.gitconfig', '.config/opencode.env', '.config/opencode-web.env', '.config/openchamber-live.env')
                    or rel.startswith('.config/openchamber/')
                    or rel.startswith('.config/opencode/') and rel.endswith(('.json', '.jsonc', '.md', '.sh', '.ts', '.mjs'))
                    or rel.startswith('.local/state/my-opencode/')
                    or rel.startswith('.local/bin/')
                    or rel == '.claude.json'
                    or rel.startswith('.local/share/openchamber/') and rel.endswith('.json'))
        if editable:
            try: text = pathlib.Path(b).read_text()
            except (UnicodeError, OSError): return
            for before, after in ((old_projects, new_projects), (old, new)):
                text = re.sub(re.escape(before) + r'(?=/|[\s\x22\x27]|$)', lambda _: after, text)
            pathlib.Path(b).write_text(text)
copy(src, dst)
PY
}

# Runtime/config/auth state. Deliberately excludes caches and root-only system files.
for rel in \
  .opencode \
  .agents \
  .claude \
  .claude.json \
  .config/opencode \
  .config/opencode.env \
  .config/opencode-web.env \
  .config/openchamber \
  .config/openchamber-live.env \
  .config/gh \
  .local/share/opencode \
  .local/share/openchamber \
  .local/share/openchamber-v2 \
  .local/share/claude \
  .local/state/my-opencode \
  .local/bin \
  .bun \
  .gitconfig
 do
  copy_item "$rel"
done

if [[ "$MIGRATE_PROJECTS" == 1 && -d "$SOURCE_PROJECTS" ]]; then
  mkdir -p "$TARGET_PROJECTS"
  migration_copy "$SOURCE_PROJECTS" "$TARGET_PROJECTS"
  echo "Migrated projects: $SOURCE_PROJECTS -> $TARGET_PROJECTS"
elif [[ "$MIGRATE_PROJECTS" != 0 && "$MIGRATE_PROJECTS" != 1 ]]; then
  echo "OPENCODE_MIGRATE_PROJECTS must be 0 or 1" >&2
  exit 2
fi

# Everything under the runtime user's home must be owned by that user after the copy.
chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$RUNTIME_HOME"

for rel in .config/gh .claude .local/share/opencode; do
  [[ ! -d "$RUNTIME_HOME/$rel" ]] || chmod 700 "$RUNTIME_HOME/$rel"
done
for rel in .local/share/opencode/auth.json .config/gh/hosts.yml .config/opencode.env .config/opencode-web.env .config/openchamber-live.env .config/openchamber/startup.env; do
  [[ ! -f "$RUNTIME_HOME/$rel" || -L "$RUNTIME_HOME/$rel" ]] || chmod 600 "$RUNTIME_HOME/$rel"
done

STATE_DIR="$RUNTIME_HOME/.local/state/my-opencode"
mkdir -p "$STATE_DIR"
cat > "$STATE_DIR/root-user-migration.done" <<EOF
migrated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_home=$SOURCE_HOME
runtime_user=$RUNTIME_USER
runtime_home=$RUNTIME_HOME
source_projects=$SOURCE_PROJECTS
EOF
chown "$RUNTIME_USER:$RUNTIME_GROUP" "$STATE_DIR/root-user-migration.done"

# Validate persisted GitHub auth when it existed under root. A missing token is not
# destructive: the user can authenticate once in the new login shell.
if command -v gh >/dev/null 2>&1; then
  if runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" gh auth status --hostname github.com >/dev/null 2>&1; then
    runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" gh auth setup-git >/dev/null 2>&1 || true
    echo "GitHub CLI auth: available for $RUNTIME_USER"
  else
    echo "GitHub CLI auth was not reusable. Run: sudo -iu $RUNTIME_USER gh auth login" >&2
  fi
fi
for unit in "${STOPPED_USER_UNITS[@]}"; do "${ROOT_USER_ENV[@]}" systemctl --user disable "$unit"; done
for unit in "${STOPPED_SYSTEM_UNITS[@]}"; do systemctl disable "$unit"; done
trap - EXIT

cat <<EOF

Migration completed. Source data under $SOURCE_HOME was NOT deleted.
Next:
  sudo -iu $RUNTIME_USER
  export OPENCODE_RUNTIME_USER=$RUNTIME_USER
  export XDG_RUNTIME_DIR=/run/user/$RUNTIME_UID
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$RUNTIME_UID/bus
  export PATH=\"\$HOME/.local/bin:\$HOME/.opencode/bin:\$HOME/.bun/bin:\$PATH\"
  gh auth status
  # run the normal my-opencode/OpenChamber installer from this login shell

Projects are now expected under:
  ${OPENCODE_TARGET_PROJECTS:-$RUNTIME_HOME/projects}

Do not run the normal installer as root anymore.
EOF
