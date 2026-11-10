#!/usr/bin/env bash
set -Eeuo pipefail
# Read-only gitleaks scan; run on a complete bare mirror. Reports stay private.
(( $# == 1 )) || { echo 'usage: security-history-audit.sh ABSOLUTE_REPORT_DIR' >&2; exit 2; }
report=$1
[[ "$report" = /* ]] || exit 2
[[ "$(git rev-parse --is-bare-repository 2>/dev/null)" == true ]] || { echo "Full bare mirror required" >&2; exit 2; }
[[ "$(git rev-parse --is-shallow-repository)" == false ]] || exit 2
command -v gitleaks >/dev/null || { echo 'Install gitleaks' >&2; exit 2; }
umask 077
mkdir -p "$report"
report="$(cd "$report" && pwd -P)"
gitdir="$(cd "$(git rev-parse --absolute-git-dir)" && pwd -P)"
[[ "$report" != "$gitdir" && "$report" != "$gitdir/"* ]] || { echo "Reports must be outside Git data" >&2; exit 2; }
git for-each-ref --format='%(refname) %(objectname)' > "$report/refs-before.txt"
git rev-list --all --count > "$report/commit-count.txt"
: > "$report/branches-merged.txt"
: > "$report/branches-unique.txt"
while read -r ref sha; do
  [[ "$ref" == refs/heads/* && "$ref" != refs/heads/main ]] || continue
  if git merge-base --is-ancestor "$sha" refs/heads/main; then
    echo "$ref" >> "$report/branches-merged.txt"
  else
    echo "$ref" >> "$report/branches-unique.txt"
  fi
done < "$report/refs-before.txt"
gitleaks git --no-banner --redact=100 --log-opts='--all' --report-format json --report-path "$report/findings.redacted.json" .
echo 'Scan completed. Inspect binary blobs, LFS, forks, PR refs and GitHub caches separately.'
