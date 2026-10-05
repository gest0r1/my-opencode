#!/usr/bin/env bash
# One-shot migration of the OpenCode/OpenChamber runtime from root to user opencode.
# Source data is copied, not deleted. Re-run is safe: existing target files are not overwritten.
# The currently running root services are deliberately left untouched so the invoking terminal survives.
set -Eeuo pipefail
umask 077

RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
[[ "$RUNTIME_USER" == opencode ]] || {
  echo "Invalid runtime user '$RUNTIME_USER': required name is exactly opencode" >&2; exit 2;
}
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
  echo "Run this migration with sudo/root. It will not stop the current OpenCode/OpenChamber services." >&2
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

# Provision only the narrow privileged helpers needed by the runtime user.
SUDO_SETUP="$(dirname "${BASH_SOURCE[0]}")/setup-opencode-package-sudo.sh"
if [[ -f "$SUDO_SETUP" ]]; then
  OPENCODE_RUNTIME_USER="$RUNTIME_USER" bash "$SUDO_SETUP"
else
  command -v gh >/dev/null || { echo 'GitHub CLI is required to fetch sudo bootstrap' >&2; exit 1; }
  CONFIG_SHA="$(gh api "repos/${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}/commits/${OPENCODE_CONFIG_REF:-main}" --jq .sha)"
  [[ "$CONFIG_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1
  SUDO_SETUP_TMP="$(mktemp)"
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}/contents/scripts/setup-opencode-package-sudo.sh?ref=$CONFIG_SHA" > "$SUDO_SETUP_TMP"
  OPENCODE_RUNTIME_USER="$RUNTIME_USER" bash "$SUDO_SETUP_TMP"
  rm -f -- "$SUDO_SETUP_TMP"
fi

# Start/validate the new user manager without touching the currently running root runtime.
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
# destructive: the installer can temporarily inherit the invoking sudo user's token.
if command -v gh >/dev/null 2>&1; then
  if runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" gh auth status --hostname github.com >/dev/null 2>&1; then
    runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" gh auth setup-git >/dev/null 2>&1 || true
    echo "GitHub CLI auth: available for $RUNTIME_USER"
  else
    echo "GitHub CLI auth was not reusable for $RUNTIME_USER; the installer may use the invoking user's gh token for this run." >&2
  fi
fi

cat <<EOF

Migration completed. Source data under $SOURCE_HOME was NOT deleted.
The existing root OpenCode/OpenChamber services were NOT stopped or disabled, so this terminal stays connected.

Next: run the installer from this same shell or from any sudo-capable user. The installer switches to '$RUNTIME_USER' itself and performs the legacy-service cutover only at final activation.

Projects are now expected under:
  ${OPENCODE_TARGET_PROJECTS:-$RUNTIME_HOME/projects}
EOF
