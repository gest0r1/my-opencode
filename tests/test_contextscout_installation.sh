#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for attempt in 1 2; do
  bash scripts/install-opencode-agents.sh "config/opencode/agent" "$tmp/agents"
  test -f "$tmp/agents/ContextScout.md"
  grep -Fq '".tmp/pipelines/**/planning/**": allow' "$tmp/agents/ContextScout.md"
  ! grep -Fq '".tmp/pipelines/**/planning/context-packet.md": allow' "$tmp/agents/ContextScout.md"
  grep -Fq '".tmp/pipelines/**/planning/probes/**": deny' "$tmp/agents/ContextScout.md"
  grep -Fq '"**/*.env*": deny' "$tmp/agents/ContextScout.md"
done
printf '%s\n' 'PASS: repeated managed agent install preserves ContextScout planning subtree'
