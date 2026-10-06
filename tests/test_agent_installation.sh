#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

SRC="$ROOT/source"
TARGET="$ROOT/home/.config/opencode/agents"

export HOME="$ROOT/home"
export XDG_STATE_HOME="$HOME/.local/state"

mkdir -p \
  "$SRC/core" \
  "$SRC/content" \
  "$SRC/subagents/code"

cat > "$SRC/core/primary-agent.md" <<'EOF'
---
name: PrimaryAgent
mode: primary
---
managed primary v1
EOF

cat > "$SRC/content/copywriter.md" <<'EOF'
---
name: "CopyWriter"
mode: primary
---
managed copywriter
EOF

cat > "$SRC/subagents/code/coder-agent.md" <<'EOF'
---
name: CoderAgent
mode: subagent
---
managed coder
EOF

mkdir -p "$TARGET/code" "$TARGET/custom"
printf '%s\n' '---' 'name: CoderAgent' 'model: user-edited-old-model' '---' > "$TARGET/code/CoderAgent.md"
printf '%s\n' '---' 'name: CoderAgent' '---' > "$TARGET/custom/renamed.md"
printf '%s\n' '---' 'name: Independent' '---' > "$TARGET/custom/Independent.md"

bash scripts/install-opencode-agents.sh \
  "$SRC" \
  "$TARGET"

# OpenCode 2.x includes subdirectories below agents/ in the registered ID.
# Therefore every installed managed agent must be flat and addressable by
# its frontmatter name exactly.
test -f "$TARGET/PrimaryAgent.md"
test -f "$TARGET/CopyWriter.md"
test -f "$TARGET/CoderAgent.md"
test ! -e "$TARGET/primary-agent.md"
test ! -d "$TARGET/subagents"
test ! -d "$TARGET/code"
test ! -f "$TARGET/custom/renamed.md"
test -f "$TARGET/custom/Independent.md"
test ! -d "$TARGET/planning"
test ! -d "$TARGET/utils"

grep -Fq 'managed coder' "$TARGET/CoderAgent.md"

# Re-running is idempotent and managed source remains authoritative.
sed -i 's/managed primary v1/managed primary v2/' "$SRC/core/primary-agent.md"
bash scripts/install-opencode-agents.sh \
  "$SRC" \
  "$TARGET"
grep -Fq 'managed primary v2' "$TARGET/PrimaryAgent.md"

printf 'PASS: flat canonical agent IDs, managed copy replacement, repeat install\n'


