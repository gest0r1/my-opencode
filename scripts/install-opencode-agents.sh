#!/usr/bin/env bash
# Install repository-managed OpenCode agents into the upstream global agents directory.
# OpenCode 2.x derives an agent ID from the path relative to agents/. Therefore
# managed agents MUST be installed flat: agents/CoderAgent.md, not
# agents/code/CoderAgent.md (which would register as code/CoderAgent).
set -Eeuo pipefail

if (( $# != 2 )); then
  echo "Usage: install-opencode-agents.sh SOURCE_ROOT TARGET_ROOT" >&2
  exit 2
fi

SOURCE_ROOT=$1
TARGET_ROOT=$2
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NORMALIZER="$SCRIPT_DIR/normalize-opencode-agent-permissions.mjs"
TARGET_CONFIG="$(dirname "$TARGET_ROOT")/opencode.json"

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

# A colour chosen in OpenChamber lives in the agent file this install replaces.
COLORS_FILE="$(mktemp)"
trap 'rm -f -- "$COLORS_FILE"' EXIT
node "$SCRIPT_DIR/preserve-agent-colors.mjs" collect "$SOURCE_ROOT" "$TARGET_ROOT" "$COLORS_FILE"

# Remove every previous distribution copy, including edited nested files.
node "$SCRIPT_DIR/retire-opencode-agent-copies.mjs" "$SOURCE_ROOT" "$TARGET_ROOT"

while IFS= read -r -d '' file; do
  install_managed "$file"
done < <(find "$SOURCE_ROOT" -type f -name '*.md' -print0 | sort -z)

# During the full config staging path, normalize legacy delegation aliases and
# make Markdown the single permission source for agents that declare their own
# permission: block. Restrict mutation to repository-managed agents: preserved
# user agents may participate in the catalog but must not be rewritten.
if [[ -f "$TARGET_CONFIG" ]]; then
  [[ -f "$NORMALIZER" ]] || {
    echo "Agent permission normalizer missing: $NORMALIZER" >&2
    exit 1
  }
  command -v node >/dev/null 2>&1 || {
    echo "Node.js is required for agent permission normalization." >&2
    exit 1
  }
  node "$NORMALIZER" "$TARGET_CONFIG" "$TARGET_ROOT" "$SOURCE_ROOT"
fi

node "$SCRIPT_DIR/preserve-agent-colors.mjs" apply "$TARGET_ROOT" "$COLORS_FILE"

echo "Installed ${#managed_names[@]} managed agents into $TARGET_ROOT"


