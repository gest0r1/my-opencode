#!/usr/bin/env bash
# Install repository-managed OpenCode agents into the upstream global agents directory.
# Existing legacy agent roots are migrated without deleting them, so rollback remains possible.
set -Eeuo pipefail

if (( $# < 2 )); then
  echo "Usage: install-opencode-agents.sh SOURCE_ROOT TARGET_ROOT [LEGACY_ROOT ...]" >&2
  exit 2
fi

SOURCE_ROOT=$1
TARGET_ROOT=$2
shift 2
LEGACY_ROOTS=("$@")

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
  local kind=$1 value=$2
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
    echo "Invalid agent $kind '$value'" >&2
    return 1
  }
}

destination_for() {
  local relative=$1 name=$2
  if [[ "$relative" == subagents/*/* ]]; then
    local rest=${relative#subagents/}
    local category=${rest%%/*}
    validate_component category "$category"
    printf '%s/%s/%s.md\n' "$TARGET_ROOT" "$category" "$name"
  else
    printf '%s/%s.md\n' "$TARGET_ROOT" "$name"
  fi
}

declare -A managed_names=()

install_managed() {
  local file relative name destination
  file=$1
  relative=${file#"$SOURCE_ROOT/"}
  name=$(frontmatter_name "$file")
  [[ -n "$name" ]] || { echo "Managed agent has no frontmatter name: $relative" >&2; exit 1; }
  validate_component name "$name"

  if [[ -n "${managed_names[$name]+x}" ]]; then
    echo "Duplicate managed agent name '$name': ${managed_names[$name]} and $relative" >&2
    exit 1
  fi
  managed_names[$name]=$relative

  destination=$(destination_for "$relative" "$name")
  mkdir -p "$(dirname "$destination")"
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
    if ! validate_component name "$name" 2>/dev/null; then
      echo "Skipping legacy agent with unsafe name: $file" >&2
      continue
    fi

    destination=$(destination_for "$relative" "$name")
    mkdir -p "$(dirname "$destination")"
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

echo "Installed ${#managed_names[@]} managed agents into $TARGET_ROOT"
if (( ${#LEGACY_ROOTS[@]} > 0 )); then
  echo "Legacy agent directories were retained for rollback."
fi
