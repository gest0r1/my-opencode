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

for cmd in id getent cut useradd cp mkdir chown chmod loginctl systemctl runuser date python3 realpath flock git; do
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

python3 "${OPENCODE_SUDO_PREFIX:-}/usr/local/lib/my-opencode/runtime-processes.py" --uid "$RUNTIME_UID" --require-stopped

# Start/validate the new user manager without touching the currently running root runtime.
loginctl enable-linger "$RUNTIME_USER"
systemctl start "user@${RUNTIME_UID}.service"
RUNTIME_ENV=(env -i HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER"
  PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
  XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNTIME_UID/bus")
runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" bash -c 'cd "$HOME"; exec systemctl "$@"' bash --user show-environment >/dev/null
# Bootstrap under the runtime user, from a root-owned helper and clean cwd.
BOOTSTRAP="${OPENCODE_SUDO_PREFIX:-}/usr/local/lib/my-opencode/bootstrap-runtime-tools.sh"
runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" bash -c 'cd "$HOME"; source "$1"; ensure_runtime_node' bash "$BOOTSTRAP"

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
import hashlib, json, os, pathlib, re, shutil, sqlite3, sys
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
        if a.endswith(('-wal', '-shm')): return
        with open(a, 'rb') as stream:
            is_database = stream.read(16) == b'SQLite format 3\x00'
        if is_database:
            with sqlite3.connect(a) as source_db, sqlite3.connect(b) as target_db:
                source_db.backup(target_db)
                if target_db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError('SQLite copy integrity failure')
            shutil.copystat(a, b)
        else:
            shutil.copy2(a, b)
        rel = os.path.relpath(b, new)
        editable = (rel in ('.gitconfig', '.config/opencode.env', '.config/opencode-web.env', '.config/openchamber-live.env')
                    or rel.startswith('.config/opencode/') and rel.endswith(('.json', '.jsonc', '.md', '.sh', '.ts', '.mjs'))
                    or rel.startswith('.local/state/my-opencode/') and rel.endswith('.state')
                    or rel.startswith('.local/bin/')
                    or rel == '.claude.json'
)
        if editable:
            try: text = pathlib.Path(b).read_text()
            except (UnicodeError, OSError): return
            for before, after in ((old_projects, new_projects), (old, new)):
                text = re.sub(re.escape(before) + r'(?=/|[\s\x22\x27]|$)', lambda _: after, text)
            pathlib.Path(b).write_text(text)
copy(src, dst)
PY
}

COPY_INVENTORY="$(mktemp)"
trap 'rm -f -- "$COPY_INVENTORY"' EXIT
python3 - "$RUNTIME_HOME" > "$COPY_INVENTORY" <<'PYINVENTORY'
import json, pathlib, sys
home = pathlib.Path(sys.argv[1])
roots = ['.local/share/opencode', '.config/openchamber', '.local/share/openchamber', '.local/share/opencode-claude']
print(json.dumps([str(p.relative_to(home)) for r in roots for p in (home/r).rglob('*') if p.is_file()]))
PYINVENTORY

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
  .local/share/opencode-claude \
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
# Root-owned plan is consumed by the privileged helper only after root writers stop.
PLAN_DIR="${OPENCODE_SUDO_PREFIX:-}/var/lib/my-opencode"
mkdir -p "$PLAN_DIR"
chmod 700 "$PLAN_DIR"
python3 - "$SOURCE_HOME" "$RUNTIME_HOME" "$SOURCE_PROJECTS" "$TARGET_PROJECTS" "$COPY_INVENTORY" "$PLAN_DIR/root-migration.json" <<'PYPLAN'
import hashlib, json, pathlib, sys
source, home, old_projects, new_projects, inventory, plan = sys.argv[1:]
plan = pathlib.Path(plan)
if plan.exists():
    previous = json.loads(plan.read_text())
    if previous['source_home'] != source or previous['home'] != home:
        raise RuntimeError('Pending migration uses different homes')
    files = previous['copied_files']
else:
    files = {}
existing = set(json.loads(pathlib.Path(inventory).read_text()))
for root in ['.local/share/opencode', '.config/openchamber', '.local/share/openchamber', '.local/share/opencode-claude']:
    for p in (pathlib.Path(home)/root).rglob('*'):
        rel = str(p.relative_to(home))
        if p.is_file() and not p.is_symlink() and rel not in existing and not p.name.endswith(('-wal', '-shm')):
            if any(x in ('node_modules', 'releases', 'cache') for x in p.parts): continue
            files.setdefault(rel, hashlib.sha256(p.read_bytes()).hexdigest())
data = dict(source_home=source, home=home, source_projects=old_projects, target_projects=new_projects, copied_files=files)
tmp = plan.with_suffix('.tmp')
tmp.write_text(json.dumps(data, indent=2))
tmp.chmod(0o600)
tmp.replace(plan)
PYPLAN
python3 - "$SOURCE_HOME" "$RUNTIME_HOME" "$SOURCE_PROJECTS" "$TARGET_PROJECTS" <<'PYGIT'
import pathlib, sys
old, new, old_projects, new_projects = sys.argv[1:]
root = pathlib.Path(new_projects)
for git in root.rglob('.git') if root.exists() else []:
    refs = [git] if git.is_file() else list((git/'worktrees').glob('*/gitdir')) + list((git/'worktrees').glob('*/commondir'))
    for ref in refs:
        if ref.is_symlink(): raise RuntimeError('Git metadata symlink refused')
        value = ref.read_text().strip()
        label = 'gitdir: ' if value.startswith('gitdir: ') else ''
        path = value[len(label):]
        for before, after in ((old_projects, new_projects), (old, new)):
            if path == before or path.startswith(before + '/'):
                target = after + path[len(before):]
                if not pathlib.Path(target).exists(): raise RuntimeError('Missing relocated Git target: ' + target)
                ref.write_text(label + target + '\n')
                break
PYGIT
# Repair worktree administration without reset, clean, prune or recreation.
if [[ -d "$TARGET_PROJECTS" ]]; then
  while IFS= read -r -d '' dotgit; do
    project="$(dirname "$dotgit")"
    runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" git -C "$project" worktree repair
    runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" git -C "$project" worktree list --porcelain >/dev/null
    runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" git -C "$project" status --porcelain >/dev/null
  done < <(find "$TARGET_PROJECTS" -name .git -print0 -prune)
fi
: > "$STATE_DIR/root-state-sync.pending"
chown "$RUNTIME_USER:$RUNTIME_GROUP" "$STATE_DIR/root-state-sync.pending"
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
    runuser -u "$RUNTIME_USER" -- "${RUNTIME_ENV[@]}" gh auth setup-git >/dev/null
    echo "GitHub CLI auth: available for $RUNTIME_USER"
  else
    echo "GitHub CLI auth was not reusable for $RUNTIME_USER; the installer may use the invoking user's gh token for this run." >&2
  fi
fi

cat <<EOF

Migration preparation completed; final state sync/validation is pending external cutover. Source data under $SOURCE_HOME was NOT deleted.
The existing root OpenCode/OpenChamber services were NOT stopped or disabled, so this terminal stays connected.

Next: run the installer from this same shell or from any sudo-capable user. The installer switches to '$RUNTIME_USER' itself and performs the legacy-service cutover only at final activation.

Projects are now expected under:
  ${OPENCODE_TARGET_PROJECTS:-$RUNTIME_HOME/projects}
EOF
