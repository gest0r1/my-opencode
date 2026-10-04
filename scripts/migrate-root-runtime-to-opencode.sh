#!/usr/bin/env bash
# One-shot migration of the OpenCode/OpenChamber runtime from root to user opencode.
# Source data is copied, not deleted. Re-run is safe: existing target files are not overwritten.
set -Eeuo pipefail

RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
SOURCE_HOME="${OPENCODE_MIGRATION_SOURCE_HOME:-/root}"
MIGRATE_PROJECTS="${OPENCODE_MIGRATE_PROJECTS:-1}"
SOURCE_PROJECTS="${OPENCODE_SOURCE_PROJECTS:-$SOURCE_HOME/projects}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this migration as root from SSH/external console." >&2
  exit 2
fi
if [[ "${OPENCHAMBER_EMBEDDED_TERMINAL:-}" == 1 ]]; then
  echo "Do not migrate from the embedded OpenChamber terminal. Use SSH/external console." >&2
  exit 2
fi

for cmd in id getent cut useradd cp mkdir chown loginctl systemctl runuser date; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done

if ! id "$RUNTIME_USER" >/dev/null 2>&1; then
  echo "Creating runtime user: $RUNTIME_USER"
  useradd --create-home --shell /bin/bash "$RUNTIME_USER"
fi

RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6)"
RUNTIME_GROUP="$(id -gn "$RUNTIME_USER")"
RUNTIME_UID="$(id -u "$RUNTIME_USER")"
[[ -n "$RUNTIME_HOME" && "$RUNTIME_HOME" != /root ]] || {
  echo "Invalid runtime home for '$RUNTIME_USER': '$RUNTIME_HOME'" >&2
  exit 1
}
mkdir -p "$RUNTIME_HOME"

# Stop root-owned user services that could keep the old runtime on the same port.
if [[ -S /run/user/0/bus ]]; then
  ROOT_USER_ENV=(env XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus)
  for unit in openchamber.service opencode-web.service opencode-web-reboot.path; do
    "${ROOT_USER_ENV[@]}" systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
  done
else
  systemctl --user disable --now openchamber.service >/dev/null 2>&1 || true
fi

copy_item() {
  local rel="$1" src="$SOURCE_HOME/$1" dst="$RUNTIME_HOME/$1"
  [[ -e "$src" || -L "$src" ]] || return 0
  mkdir -p "$(dirname "$dst")"
  if [[ -d "$src" && ! -L "$src" ]]; then
    mkdir -p "$dst"
    cp -a --no-clobber "$src/." "$dst/"
  else
    cp -a --no-clobber "$src" "$dst"
  fi
  echo "Migrated: $src -> $dst"
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
  .local/bin/claude \
  .bun \
  .gitconfig
 do
  copy_item "$rel"
done

if [[ "$MIGRATE_PROJECTS" == 1 && -d "$SOURCE_PROJECTS" ]]; then
  TARGET_PROJECTS="${OPENCODE_TARGET_PROJECTS:-$RUNTIME_HOME/projects}"
  mkdir -p "$TARGET_PROJECTS"
  cp -a --no-clobber "$SOURCE_PROJECTS/." "$TARGET_PROJECTS/"
  echo "Migrated projects: $SOURCE_PROJECTS -> $TARGET_PROJECTS"
elif [[ "$MIGRATE_PROJECTS" != 0 && "$MIGRATE_PROJECTS" != 1 ]]; then
  echo "OPENCODE_MIGRATE_PROJECTS must be 0 or 1" >&2
  exit 2
fi

# Everything under the runtime user's home must be owned by that user after the copy.
chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$RUNTIME_HOME"

# Keep the user systemd manager alive without an interactive login.
loginctl enable-linger "$RUNTIME_USER"
systemctl start "user@${RUNTIME_UID}.service"

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
  if runuser -u "$RUNTIME_USER" -- env HOME="$RUNTIME_HOME" gh auth status --hostname github.com >/dev/null 2>&1; then
    runuser -u "$RUNTIME_USER" -- env HOME="$RUNTIME_HOME" gh auth setup-git >/dev/null 2>&1 || true
    echo "GitHub CLI auth: available for $RUNTIME_USER"
  else
    echo "GitHub CLI auth was not reusable. Run: sudo -iu $RUNTIME_USER gh auth login" >&2
  fi
fi

cat <<EOF

Migration completed. Source data under $SOURCE_HOME was NOT deleted.
Next:
  sudo -iu $RUNTIME_USER
  gh auth status
  # run the normal my-opencode/OpenChamber installer from this login shell

Projects are now expected under:
  ${OPENCODE_TARGET_PROJECTS:-$RUNTIME_HOME/projects}

Do not run the normal installer as root anymore.
EOF
