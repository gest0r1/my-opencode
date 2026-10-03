#!/usr/bin/env bash
# Install repository-managed OpenCode agents into the upstream global agents directory.
# Existing legacy agent roots are migrated, then moved out of active lookup paths so OpenCode sees only the canonical agents tree.
# OpenCode 2.x derives an agent ID from the path relative to agents/. Therefore
# managed agents MUST be installed flat: agents/CoderAgent.md, not
# agents/code/CoderAgent.md (which would register as code/CoderAgent).
set -Eeuo pipefail

if (( $# < 2 )); then
  echo "Usage: install-opencode-agents.sh SOURCE_ROOT TARGET_ROOT [LEGACY_ROOT ...]" >&2
  exit 2
fi

SOURCE_ROOT=$1
TARGET_ROOT=$2
shift 2
LEGACY_ROOTS=("$@")
LEGACY_BACKUP_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode/legacy-agent-roots/$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_LEGACY="${OPENCODE_ARCHIVE_LEGACY:-1}"

[[ -d "$SOURCE_ROOT" ]] || { echo "Agent source directory not found: $SOURCE_ROOT" >&2; exit 1; }
mkdir -p "$TARGET_ROOT"

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

validate_component() {
  local value=$1
  [[ -n "$value" && "$value" != "." && "$value" != ".." && "$value" != */* && "$value" != *\\* ]] || {
    echo "Invalid agent name '$value'" >&2
    return 1
  }
}

destination_for() {
  local name=$1
  # Do not preserve source categories here. OpenCode 2.0.21 recursively scans
  # agents/**/*.md and includes subdirectories in the registered agent ID.
  printf '%s/%s.md\n' "$TARGET_ROOT" "$name"
}

declare -A managed_names=()

install_managed() {
  local file relative name destination
  file=$1
  relative=${file#"$SOURCE_ROOT/"}
  name=$(frontmatter_name "$file")
  [[ -n "$name" ]] || { echo "Managed agent has no frontmatter name: $relative" >&2; exit 1; }
  validate_component "$name"

  if [[ -n "${managed_names[$name]+x}" ]]; then
    echo "Duplicate managed agent name '$name': ${managed_names[$name]} and $relative" >&2
    exit 1
  fi
  managed_names[$name]=$relative

  destination=$(destination_for "$name")
  cp -p "$file" "$destination"
}

migrate_legacy() {
  local root=$1 file relative name destination basename
  [[ -d "$root" ]] || return 0

  while IFS= read -r -d '' file; do
    relative=${file#"$root/"}
    name=$(frontmatter_name "$file")
    if [[ -z "$name" ]]; then
      basename=${relative##*/}
      name=${basename%.md}
    fi
    if ! validate_component "$name" 2>/dev/null; then
      echo "Skipping legacy agent with unsafe name: $file" >&2
      continue
    fi

    destination=$(destination_for "$name")
    if [[ -e "$destination" ]]; then
      echo "Legacy agent already has a standard-path counterpart, keeping existing file: $destination"
      continue
    fi
    cp -p "$file" "$destination"
    echo "Migrated legacy agent: $file -> $destination"
  done < <(find "$root" -type f -name '*.md' -print0 | sort -z)
}

for legacy_root in "${LEGACY_ROOTS[@]}"; do
  migrate_legacy "$legacy_root"
done

while IFS= read -r -d '' file; do
  install_managed "$file"
done < <(find "$SOURCE_ROOT" -type f -name '*.md' -print0 | sort -z)

archive_legacy_root() {
  local root=$1 relative safe_name destination
  [[ -d "$root" ]] || return 0

  relative=${root#"$HOME/"}
  safe_name=${relative//\//__}
  safe_name=${safe_name//./_}
  mkdir -p "$LEGACY_BACKUP_ROOT"
  destination="$LEGACY_BACKUP_ROOT/$safe_name"
  [[ ! -e "$destination" ]] || destination="${destination}-${BASHPID}"

  mv "$root" "$destination"
  echo "Removed legacy agent lookup root: $root"
  echo "Legacy agent backup: $destination"
}

# Managed files are installed successfully at this point. Remove the old lookup
# roots from OpenCode discovery while keeping a rollback copy outside config.
if [[ "$ARCHIVE_LEGACY" == "1" ]]; then
  for legacy_root in "${LEGACY_ROOTS[@]}"; do
    archive_legacy_root "$legacy_root"
  done
elif [[ "$ARCHIVE_LEGACY" != "0" ]]; then
  echo "OPENCODE_ARCHIVE_LEGACY must be 0 or 1" >&2
  exit 2
fi

echo "Installed ${#managed_names[@]} managed agents into $TARGET_ROOT"
