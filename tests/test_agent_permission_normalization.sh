#!/usr/bin/env bash
set -Eeuo pipefail

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/agents"

cat > "$tmp/opencode.json" <<'JSON'
{
  "agents": {
    "CoderAgent": {
      "permissions": [
        {"action":"subagent","resource":"TestEngineer","effect":"allow"},
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
    "*": deny
    contextscout: allow
    ContextScout: allow
    build: allow
---
Coder
EOF

cat > "$tmp/agents/ContextScout.md" <<'EOF'
---
name: ContextScout
mode: subagent
---
Scout
EOF

cat > "$tmp/agents/build.md" <<'EOF'
---
name: build
mode: primary
---
Build
EOF

node scripts/normalize-opencode-agent-permissions.mjs "$tmp/opencode.json" "$tmp/agents"

node - "$tmp/opencode.json" <<'NODE'
const fs = require('fs')
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (c.agents.CoderAgent.mode !== 'subagent') throw new Error('CoderAgent mode not synchronized')
if ('permissions' in c.agents.CoderAgent) throw new Error('duplicate CoderAgent permissions retained')
if (c.agents.build.mode !== 'primary') throw new Error('build mode not synchronized')
if (!Array.isArray(c.agents.build.permissions)) throw new Error('build config-only permissions were removed')
NODE

grep -Fq 'ContextScout: allow' "$tmp/agents/CoderAgent.md"
! grep -Fq 'contextscout: allow' "$tmp/agents/CoderAgent.md"
! grep -Fq 'build: allow' "$tmp/agents/CoderAgent.md"
count=$(grep -Fc 'ContextScout: allow' "$tmp/agents/CoderAgent.md")
test "$count" -eq 1

printf 'PASS: agent modes, aliases, primary targets and permission ownership normalized\n'
