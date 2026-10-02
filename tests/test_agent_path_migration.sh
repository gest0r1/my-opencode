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

mkdir -p   "$SRC/core"   "$SRC/content"   "$SRC/subagents/code"   "$RUNTIME_LEGACY/subagents/planning"   "$RUNTIME_LEGACY/subagents/code"   "$RUNTIME_LEGACY/subagents/utils"   "$CONFIG_LEGACY"

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

bash scripts/install-opencode-agents.sh   "$SRC"   "$TARGET"   "$RUNTIME_LEGACY"   "$CONFIG_LEGACY"

test -f "$TARGET/PrimaryAgent.md"
test -f "$TARGET/CopyWriter.md"
test -f "$TARGET/code/CoderAgent.md"
test -f "$TARGET/planning/Reviewer.md"
test -f "$TARGET/utils/helper.md"
test -f "$TARGET/LegacyFlat.md"
test ! -e "$TARGET/primary-agent.md"
test ! -d "$TARGET/subagents"

grep -Fq 'managed coder' "$TARGET/code/CoderAgent.md"
! grep -Fq 'legacy coder must be replaced' "$TARGET/code/CoderAgent.md"

# Legacy lookup roots are removed after migration. Rollback copies live outside
# OpenCode discovery under state, so they cannot create duplicate agents.
test ! -e "$RUNTIME_LEGACY"
test ! -e "$CONFIG_LEGACY"
test -f "$XDG_STATE_HOME/my-opencode/legacy-agent-roots/"*/_opencode__agent/subagents/planning/reviewer.md
test -f "$XDG_STATE_HOME/my-opencode/legacy-agent-roots/"*/_config__opencode__agent/LegacyFlat.md

# Re-running is idempotent and managed source remains authoritative.
sed -i 's/managed primary v1/managed primary v2/' "$SRC/core/primary-agent.md"
bash scripts/install-opencode-agents.sh   "$SRC"   "$TARGET"   "$RUNTIME_LEGACY"   "$CONFIG_LEGACY"
grep -Fq 'managed primary v2' "$TARGET/PrimaryAgent.md"

printf 'PASS: canonical agent migration, legacy lookup retirement, rollback backup, repeat install\n'
