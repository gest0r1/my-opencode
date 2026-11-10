#!/usr/bin/env bash
set -Eeuo pipefail
bash -n scripts/security-history-audit.sh
bash -n scripts/security-history-rewrite.sh
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
git init -q "$tmp/repo"
if bash scripts/security-history-audit.sh "$tmp/reports" >/dev/null 2>&1; then
  echo 'FAIL: audit accepted non-mirror' >&2; exit 1
fi
if ISSUE18_APPROVE_LOCAL_REWRITE=yes bash scripts/security-history-rewrite.sh "$tmp/credentials" >/dev/null 2>&1; then
  echo 'FAIL: rewrite accepted non-mirror' >&2; exit 1
fi
echo 'PASS: history tools refuse non-mirror operations'
