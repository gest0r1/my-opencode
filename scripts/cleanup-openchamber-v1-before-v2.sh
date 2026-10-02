#!/usr/bin/env bash
# One-time cleanup before reinstalling the OpenCode/OpenChamber 2.x migration.
# Removes legacy runtime/lookup locations without deleting credentials.
set -Eeuo pipefail

CANONICAL_AGENTS="$HOME/.config/opencode/agents"
LEGACY_AGENT_ROOTS=(
  "$HOME/.opencode/agent"
  "$HOME/.config/opencode/agent"
)
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="$STATE_ROOT/legacy-cleanup-$STAMP"
LEGACY_RUNTIME="$HOME/.local/share/openchamber"
LEGACY_PASSWORD_ENV="$HOME/.config/openchamber-live.env"
NATIVE_STARTUP_ENV="$HOME/.config/openchamber/startup.env"
AUTH_FILE="$HOME/.local/share/opencode/auth.json"
COMMON_ENV="$HOME/.config/opencode.env"
LEGACY_PLUGIN_ROOT="$HOME/.config/opencode/plugin"
PLUGIN_ROOT="$HOME/.config/opencode/plugins"
LEGACY_SKILL_ROOTS=(
  "$HOME/.opencode/skill"
  "$HOME/.opencode/skills"
)
CLEANUP_RUNTIME_MODE="${OPENCHAMBER_CLEANUP_RUNTIME_MODE:-auto}"

case "$CLEANUP_RUNTIME_MODE" in
  auto|now|defer) ;;
  *) echo 'OPENCHAMBER_CLEANUP_RUNTIME_MODE must be auto, now or defer' >&2; exit 2 ;;
esac

inside_openchamber_terminal() {
  [[ "${OPENCHAMBER_EMBEDDED_TERMINAL:-}" == 1 ]] && return 0

  local pid="$" parent='' args='' depth=0
  while [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$depth" -lt 12 ]]; do
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$parent" =~ ^[0-9]+$ && "$parent" -gt 1 ]] || break
    args="$(ps -o args= -p "$parent" 2>/dev/null || true)"
    case "$args" in
      *openchamber*serve*|*openchamber*/server/*|*packages/web/server/*|*packages/web/bin/cli.js*)
        return 0
        ;;
    esac
    pid="$parent"
    depth=$((depth + 1))
  done
  return 1
}

effective_runtime_mode="$CLEANUP_RUNTIME_MODE"
if [[ "$effective_runtime_mode" == auto ]]; then
  if inside_openchamber_terminal; then
    effective_runtime_mode=defer
    echo "Embedded OpenChamber terminal detected: active runtime cleanup will be deferred."
  else
    effective_runtime_mode=now
  fi
fi

mkdir -p "$BACKUP_ROOT" "$CANONICAL_AGENTS"

read_env_value() {
  local file=$1 key=$2 value=''
  [[ -f "$file" ]] || return 1
  value="$(
    set +u
    unset "$key"
    # shellcheck disable=SC1090
    source "$file" >/dev/null 2>&1 || true
    eval "printf '%s' \"\${$key:-}\""
  )"
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

preserve_ui_password_only() {
  local password=''
  if password="$(read_env_value "$NATIVE_STARTUP_ENV" OPENCHAMBER_UI_PASSWORD 2>/dev/null)"; then
    mkdir -p "$(dirname "$LEGACY_PASSWORD_ENV")"
    umask 077
    printf 'OPENCHAMBER_UI_PASSWORD=%q\n' "$password" > "$LEGACY_PASSWORD_ENV"
    chmod 600 "$LEGACY_PASSWORD_ENV"
    echo "Preserved OpenChamber UI password only."
  fi

}
 
archive_lookup_root() {
  local root=$1 label=$2 destination
  [[ -e "$root" ]] || return 0
  destination="$BACKUP_ROOT/$label"
  [[ ! -e "$destination" ]] || destination="$destination-${BASHPID}"
  mv "$root" "$destination"
  echo "Removed active legacy lookup root: $root"
  echo "Backup: $destination"
}

preserve_ui_password_only

frontmatter_name() {
  local file=$1
  awk '
    NR == 1 {
      sub(/\r$/, "", $0)
      if ($0 != "---") exit
      in_frontmatter = 1
      next
    }
    in_frontmatter {
      line = $0
      sub(/\r$/, "", line)
      if (line == "---") exit
      if (line ~ /^[[:space:]]*name[[:space:]]*:/) {
        sub(/^[[:space:]]*name[[:space:]]*:[[:space:]]*/, "", line)
        sub(/[[:space:]]+#.*$/, "", line)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
        if ((substr(line, 1, 1) == "\"" && substr(line, length(line), 1) == "\"") ||
            (substr(line, 1, 1) == "\047" && substr(line, length(line), 1) == "\047")) {
          line = substr(line, 2, length(line) - 2)
        }
        print line
        exit
      }
    }
  ' "$file"
}

valid_component() {
  local value=$1
  [[ -n "$value" && "$value" != "." && "$value" != ".." && "$value" != */* && "$value" != *\\* ]]
}

migrate_and_archive_agent_root() {
  local root=$1 file relative name base category destination relative_root backup_destination
  [[ -d "$root" ]] || return 0

  echo "Migrating legacy agents from: $root"
  while IFS= read -r -d '' file; do
    relative=${file#"$root/"}
    name="$(frontmatter_name "$file")"
    if [[ -z "$name" ]]; then
      base=${relative##*/}
      name=${base%.md}
    fi

    if ! valid_component "$name"; then
      echo "WARNING: cannot activate legacy agent with unsafe name: $file" >&2
      echo "It will remain available in the cleanup backup." >&2
      continue
    fi

    if [[ "$relative" == subagents/*/* ]]; then
      category=${relative#subagents/}
      category=${category%%/*}
      if ! valid_component "$category"; then
        echo "WARNING: unsafe legacy agent category: $file" >&2
        continue
      fi
      destination="$CANONICAL_AGENTS/$category/$name.md"
    else
      destination="$CANONICAL_AGENTS/$name.md"
    fi

    mkdir -p "$(dirname "$destination")"
    if [[ -e "$destination" ]]; then
      echo "Canonical agent already exists, keeping it: $destination"
    else
      cp -p "$file" "$destination"
      echo "Migrated: $file -> $destination"
    fi
  done < <(find "$root" -type f -name '*.md' -print0 | sort -z)

  relative_root=${root#"$HOME/"}
  relative_root=${relative_root//\//__}
  relative_root=${relative_root//./_}
  backup_destination="$BACKUP_ROOT/$relative_root"
  [[ ! -e "$backup_destination" ]] || backup_destination="$backup_destination-$$"
  mv "$root" "$backup_destination"
  echo "Removed active legacy agent root: $root"
  echo "Backup: $backup_destination"
}

remove_legacy_launcher() {
  local launcher=$1 target=''
  [[ -e "$launcher" || -L "$launcher" ]] || return 0

  if [[ -L "$launcher" ]]; then
    target="$(readlink -f "$launcher" 2>/dev/null || true)"
    if [[ "$target" == "$LEGACY_RUNTIME/"* ]]; then
      rm -f -- "$launcher"
      echo "Removed legacy launcher: $launcher"
      return 0
    fi
  elif grep -Fq '.local/share/openchamber' "$launcher" 2>/dev/null; then
    rm -f -- "$launcher"
    echo "Removed legacy launcher: $launcher"
    return 0
  fi

  echo "WARNING: not removing unmanaged launcher: $launcher" >&2
}

if [[ "$effective_runtime_mode" == now ]]; then
  echo "Stopping OpenChamber/OpenCode legacy services..."
  if [[ -f "$NATIVE_STARTUP_ENV" ]]; then
    rm -f -- "$NATIVE_STARTUP_ENV"
    echo "Removed stale native startup environment snapshot: $NATIVE_STARTUP_ENV"
  fi
  if command -v openchamber >/dev/null 2>&1; then
    openchamber startup disable >/dev/null 2>&1 || true
  fi
  systemctl --user disable --now openchamber.service >/dev/null 2>&1 || true
  systemctl --user disable --now opencode-web.service >/dev/null 2>&1 || true

  rm -f -- \
    "$HOME/.config/systemd/user/openchamber.service" \
    "$HOME/.config/systemd/user/opencode-web.service"
  rm -rf -- "$HOME/.config/systemd/user/openchamber.service.d"
  systemctl --user daemon-reload

  remove_legacy_launcher "/usr/local/bin/openchamber"
  remove_legacy_launcher "$HOME/.local/bin/openchamber"

  if [[ -d "$LEGACY_RUNTIME" ]]; then
    rm -rf -- "$LEGACY_RUNTIME"
    echo "Removed OpenChamber 1.x runtime: $LEGACY_RUNTIME"
  fi

  # Remove a failed/test 2.x global package only when no embedded OpenChamber
  # terminal depends on the currently loaded runtime.
  if command -v bun >/dev/null 2>&1; then
    bun remove -g @openchamber/web >/dev/null 2>&1 || true
  fi
else
  echo "Active OpenChamber service/runtime preserved to keep the current console alive."
  echo "Native startup.env is also retained until installer reconcile to survive an unexpected service restart."
  echo "Runtime cleanup can be completed later from SSH with:"
  echo "  OPENCHAMBER_CLEANUP_RUNTIME_MODE=now <same cleanup command>"
fi

for root in "${LEGACY_AGENT_ROOTS[@]}"; do
  migrate_and_archive_agent_root "$root"
done

# OpenCode 2 scans both plugins/ and legacy plugin/. The config installer will
# repopulate the canonical plugins/ directory from the distribution. Moving
# both roots out of active lookup prevents retired plugin files from surviving
# an overlay update and producing duplicate/broken loads.
archive_lookup_root "$PLUGIN_ROOT" "opencode-plugins"
archive_lookup_root "$LEGACY_PLUGIN_ROOT" "opencode-plugin-legacy"
mkdir -p "$PLUGIN_ROOT"

for root in "${LEGACY_SKILL_ROOTS[@]}"; do
  label="${root#"$HOME/"}"
  label="${label//\//__}"
  archive_lookup_root "$root" "$label"
done

# Force exact-SHA install logic to run again.
rm -f --   "$STATE_ROOT/openchamber-install.state"   "$STATE_ROOT/openchamber-v2-install.state"

# Retire the old reboot helper if it was deployed by the legacy distribution.
if [[ -e "$HOME/Opencode/scripts/opencode-web-reboot" ]]; then
  mv "$HOME/Opencode/scripts/opencode-web-reboot" "$BACKUP_ROOT/opencode-web-reboot"
  echo "Archived legacy opencode-web reboot helper."
fi

echo
echo "Cleanup complete."
echo "Preserved credentials/settings:"
echo "  $AUTH_FILE"
echo "  $COMMON_ENV"
echo "  $LEGACY_PASSWORD_ENV  (password-only migration bridge)"
echo "  $HOME/.opencode/bin/opencode"
echo "Removed/rebuilt on reinstall:"
echo "  $NATIVE_STARTUP_ENV"
echo "  $PLUGIN_ROOT"
echo "  $LEGACY_PLUGIN_ROOT"
echo "  ${LEGACY_SKILL_ROOTS[*]}"
echo
echo "Legacy backup (if anything was migrated): $BACKUP_ROOT"
