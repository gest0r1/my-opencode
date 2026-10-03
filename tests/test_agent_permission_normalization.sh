#!/usr/bin/env bash
set -Eeuo pipefail

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/agents" "$tmp/source"

cat > "$tmp/opencode.json" <<'JSON'
{
  "agents": {
    "CoderAgent": {
      "permissions": [
        {"action":"subagent","resource":"TestEngineer","effect":"allow"},
        {"action":"subagent","resource":"*","effect":"deny"}
      ]
    },
    "PrimaryManager": {
      "permissions": [
        {"action":"subagent","resource":"contextscout","effect":"allow"},
        {"action":"subagent","resource":"build","effect":"allow"},
        {"action":"subagent","resource":"*","effect":"deny"}
      ]
    },
    "build": {
      "permissions": [
        {"action":"subagent","resource":"*","effect":"deny"}
      ]
    }
  }
}
JSON

cat > "$tmp/agents/CoderAgent.md" <<'EOF'
---
name: CoderAgent
mode: subagent
permission:
  task:
    contextscout: "allow"
    ContextScout: allow
    build: "allow"
    "*": "deny"
  edit:
    "safe/**": "allow"
    "*": "deny"
  bash:
    "echo ok": allow
    "*": deny
---
Coder
EOF
cp "$tmp/agents/CoderAgent.md" "$tmp/source/coder.md"

cat > "$tmp/agents/ContextScout.md" <<'EOF'
---
name: ContextScout
mode: subagent
---
Scout
EOF
cp "$tmp/agents/ContextScout.md" "$tmp/source/context.md"

cat > "$tmp/agents/PrimaryManager.md" <<'EOF'
---
name: PrimaryManager
mode: primary
---
Manager with config-only permissions
EOF
cp "$tmp/agents/PrimaryManager.md" "$tmp/source/manager.md"

cat > "$tmp/agents/build.md" <<'EOF'
---
name: build
mode: primary
---
Build
EOF
cp "$tmp/agents/build.md" "$tmp/source/build.md"

cat > "$tmp/agents/UserCustom.md" <<'EOF'
---
name: UserCustom
mode: subagent
permission:
  task:
    contextscout: "allow"
    "*": "deny"
---
User-owned agent: must not be rewritten by managed normalization.
EOF

node scripts/normalize-opencode-agent-permissions.mjs \
  "$tmp/opencode.json" "$tmp/agents" "$tmp/source"

node - "$tmp/opencode.json" <<'NODE'
const fs = require('fs')
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (c.agents.CoderAgent.mode !== 'subagent') throw new Error('CoderAgent mode not synchronized')
if ('permissions' in c.agents.CoderAgent) throw new Error('duplicate CoderAgent permissions retained')
if (c.agents.build.mode !== 'primary') throw new Error('build mode not synchronized')
if (!Array.isArray(c.agents.build.permissions)) throw new Error('build config-only permissions were removed')
const rules = c.agents.PrimaryManager.permissions.filter((r) => r.action === 'subagent')
if (rules[0]?.resource !== '*' || rules[0]?.effect !== 'deny') throw new Error('config catch-all was not moved before specific rules')
if (!rules.some((r) => r.resource === 'ContextScout' && r.effect === 'allow')) throw new Error('config alias not canonicalized')
if (rules.some((r) => r.resource === 'contextscout')) throw new Error('legacy config alias retained')
if (rules.some((r) => r.resource === 'build' && r.effect === 'allow')) throw new Error('primary subagent allow retained')
NODE

grep -Fq 'ContextScout: allow' "$tmp/agents/CoderAgent.md"
! grep -Fq 'contextscout:' "$tmp/agents/CoderAgent.md"
! grep -Fq 'build: "allow"' "$tmp/agents/CoderAgent.md"
count=$(grep -Fc 'ContextScout: allow' "$tmp/agents/CoderAgent.md")
test "$count" -eq 1

mapfile -t wildcard_lines < <(grep -n '"\*": deny' "$tmp/agents/CoderAgent.md" | cut -d: -f1)
test "${#wildcard_lines[@]}" -eq 3

task_allow=$(grep -nF 'ContextScout: allow' "$tmp/agents/CoderAgent.md" | cut -d: -f1)
test "${wildcard_lines[0]}" -lt "$task_allow"
edit_allow=$(grep -nF '"safe/**": allow' "$tmp/agents/CoderAgent.md" | cut -d: -f1)
test "${wildcard_lines[1]}" -lt "$edit_allow"
bash_allow=$(grep -nF '"echo ok": allow' "$tmp/agents/CoderAgent.md" | cut -d: -f1)
test "${wildcard_lines[2]}" -lt "$bash_allow"

grep -Fq 'contextscout: "allow"' "$tmp/agents/UserCustom.md"

printf 'PASS: quoted/unquoted effects, all action catch-alls, managed ownership, aliases and primary targets normalized\n'
