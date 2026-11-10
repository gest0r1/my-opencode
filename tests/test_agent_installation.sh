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
model: repo/default#low
variant: low
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
grep -Fq 'model: user-edited-old-model' "$TARGET/CoderAgent.md"
if grep -q '^variant:' "$TARGET/CoderAgent.md"; then echo 'FAIL: inherited an unselected variant' >&2; exit 1; fi

# Re-running is idempotent and managed source remains authoritative.
sed -i 's/managed primary v1/managed primary v2/' "$SRC/core/primary-agent.md"
bash scripts/install-opencode-agents.sh \
  "$SRC" \
  "$TARGET"
grep -Fq 'managed primary v2' "$TARGET/PrimaryAgent.md"

# A colour picked in OpenChamber (saved as color: in the installed file) survives
# reinstall; the body and every other field still come from the distribution.
sed -i 's/^name: CoderAgent$/name: CoderAgent\ncolor: "#12a4c8"/' "$TARGET/CoderAgent.md"
sed -i 's/managed coder/managed coder v2/' "$SRC/subagents/code/coder-agent.md"
bash scripts/install-opencode-agents.sh \
  "$SRC" \
  "$TARGET"
grep -Fq 'color: "#12a4c8"' "$TARGET/CoderAgent.md"
grep -Fq 'managed coder v2' "$TARGET/CoderAgent.md"
grep -Fq 'model: user-edited-old-model' "$TARGET/CoderAgent.md"
# Model and variant changes made by the user survive prompt/body upgrades.
sed -i 's|^model: user-edited-old-model$|model: claude-code/claude-sonnet-5#high\nvariant: high|' "$TARGET/CoderAgent.md"
sed -i 's/managed coder v2/managed coder v3/' "$SRC/subagents/code/coder-agent.md"
bash scripts/install-opencode-agents.sh "$SRC" "$TARGET"
grep -Fq 'model: claude-code/claude-sonnet-5#high' "$TARGET/CoderAgent.md"
grep -Fq 'variant: high' "$TARGET/CoderAgent.md"
grep -Fq 'managed coder v3' "$TARGET/CoderAgent.md"

# Explicit absence of model on an existing agent must not turn into a pin.
sed -i 's|^name: PrimaryAgent$|name: PrimaryAgent\nmodel: repo/new-default|' "$SRC/core/primary-agent.md"
bash scripts/install-opencode-agents.sh "$SRC" "$TARGET"
if grep -q '^model:' "$TARGET/PrimaryAgent.md"; then echo 'FAIL: user model inheritance overwritten' >&2; exit 1; fi
if grep -q '^color:' "$TARGET/PrimaryAgent.md"; then echo 'FAIL: colour leaked to another agent' >&2; exit 1; fi

printf 'PASS: flat canonical agent IDs, managed copy replacement, repeat install, kept agent colour and model/variant preferences\n'


