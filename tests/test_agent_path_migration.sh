#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

SRC="$ROOT/source"
TARGET="$ROOT/home/.config/opencode/agents"
RUNTIME_LEGACY="$ROOT/home/.opencode/agent"
CONFIG_LEGACY="$ROOT/home/.config/opencode/agent"

export HOME="$ROOT/home"
export XDG_STATE_HOME="$HOME/.local/state"

mkdir -p \
  "$SRC/core" \
  "$SRC/content" \
  "$SRC/subagents/code" \
  "$RUNTIME_LEGACY/subagents/planning" \
  "$RUNTIME_LEGACY/subagents/code" \
  "$RUNTIME_LEGACY/subagents/utils" \
  "$CONFIG_LEGACY"

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

cat > "$RUNTIME_LEGACY/subagents/planning/reviewer.md" <<'EOF'
---
name: Reviewer
mode: subagent
---
legacy reviewer
EOF

cat > "$RUNTIME_LEGACY/subagents/code/coder-agent.md" <<'EOF'
---
name: CoderAgent
mode: subagent
---
legacy coder must be replaced
EOF

cat > "$RUNTIME_LEGACY/subagents/utils/helper.md" <<'EOF'
legacy helper without frontmatter name
EOF

cat > "$CONFIG_LEGACY/LegacyFlat.md" <<'EOF'
---
name: LegacyFlat
---
legacy singular config agent
EOF

mkdir -p "$TARGET/code" "$TARGET/custom"
printf '%s\n' '---' 'name: CoderAgent' 'model: user-edited-old-model' '---' > "$TARGET/code/CoderAgent.md"
printf '%s\n' '---' 'name: CoderAgent' '---' > "$TARGET/custom/renamed.md"
printf '%s\n' '---' 'name: Independent' '---' > "$TARGET/custom/Independent.md"

bash scripts/install-opencode-agents.sh \
  "$SRC" \
  "$TARGET" \
  "$RUNTIME_LEGACY" \
  "$CONFIG_LEGACY"

# OpenCode 2.x includes subdirectories below agents/ in the registered ID.
# Therefore every installed managed/legacy agent must be flat and addressable by
# its frontmatter name exactly.
test -f "$TARGET/PrimaryAgent.md"
test -f "$TARGET/CopyWriter.md"
test -f "$TARGET/CoderAgent.md"
test -f "$TARGET/Reviewer.md"
test -f "$TARGET/helper.md"
test -f "$TARGET/LegacyFlat.md"
test ! -e "$TARGET/primary-agent.md"
test ! -d "$TARGET/subagents"
test ! -d "$TARGET/code"
test ! -f "$TARGET/custom/renamed.md"
test -f "$TARGET/custom/Independent.md"
test ! -d "$TARGET/planning"
test ! -d "$TARGET/utils"

grep -Fq 'managed coder' "$TARGET/CoderAgent.md"
! grep -Fq 'legacy coder must be replaced' "$TARGET/CoderAgent.md"

# Legacy lookup roots are removed after migration. Rollback copies live outside
# OpenCode discovery under state, so they cannot create duplicate agents.
test ! -e "$RUNTIME_LEGACY"
test ! -e "$CONFIG_LEGACY"
test -f "$XDG_STATE_HOME/my-opencode/legacy-agent-roots/"*/_opencode__agent/subagents/planning/reviewer.md
test -f "$XDG_STATE_HOME/my-opencode/legacy-agent-roots/"*/_config__opencode__agent/LegacyFlat.md

# Re-running is idempotent and managed source remains authoritative.
sed -i 's/managed primary v1/managed primary v2/' "$SRC/core/primary-agent.md"
bash scripts/install-opencode-agents.sh \
  "$SRC" \
  "$TARGET" \
  "$RUNTIME_LEGACY" \
  "$CONFIG_LEGACY"
grep -Fq 'managed primary v2' "$TARGET/PrimaryAgent.md"

printf 'PASS: flat canonical agent IDs, legacy lookup retirement, rollback backup, repeat install\n'

