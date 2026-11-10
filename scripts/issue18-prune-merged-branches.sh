#!/usr/bin/env bash
# #18: delete only fully merged obsolete refs + owner-approved PR #62 squash.
# Requires checkout with GitHub contents:write. Fail on race, never force history.
set -Eeuo pipefail
[[ "${GITHUB_REPOSITORY:-}" == gest0r1/my-opencode ]] || { echo "Repository identity mismatch" >&2; exit 2; }
[[ "${ISSUE18_PRUNE_APPLY:-}" == yes || "${ISSUE18_PRUNE_APPLY:-}" == no ]] || { echo "Explicit dry-run/apply required" >&2; exit 2; }
command -v jq >/dev/null
command -v gh >/dev/null
git fetch --no-tags origin '+refs/heads/*:refs/remotes/origin/*'
git merge-base --is-ancestor 9e2b5a0e3d477cd6f18692263555806501c72544 refs/remotes/origin/main || {
  echo "PR #62 squash is not contained in main" >&2; exit 2;
}
open_prs="$(gh api "repos/$GITHUB_REPOSITORY/pulls?state=open&per_page=100")"
mapfile -t open_heads < <(printf '%s' "$open_prs" | jq -r '.[].head.ref')
is_open() {
  local candidate=$1
  for name in "${open_heads[@]}"; do [[ "$candidate" != "$name" ]] || return 0; done
  return 1
}
approved_squash() {
  local name=$1 sha=$2
  [[ "$name" == feature/issue-60-gate-lifecycle &&
     "$sha" == 25fbb4024cfc30ba5019d4413c45e35d7979a8f4 ]] || return 1
  local files=(
    .github/workflows/pipeline-contracts.yml
    config/opencode/command/pipeline-run.md
    config/opencode/skills/task-management/gate-testing.md
    config/opencode/skills/task-management/scripts/gate-lifecycle.mjs
    config/opencode/skills/task-management/scripts/gate-lifecycle.test.mjs
    config/opencode/skills/task-management/scripts/gate-runner-cli.test.mjs
    config/opencode/skills/task-management/scripts/gate-runner-cli.ts
    config/opencode/skills/task-management/scripts/gate-testing-policy.mjs
    config/opencode/skills/task-management/scripts/gate-testing-policy.test.mjs
  )
  for file in "${files[@]}"; do
    [[ "$(git rev-parse "${sha}:${file}")" == "$(git rev-parse "9e2b5a0e3d477cd6f18692263555806501c72544:${file}")" ]] || return 1
  done
}
count=0; deleted=0
while read -r name sha; do
  [[ -n "$name" ]] || continue
  case "$name" in
    main|security/issue18-history-cleanup-phase2|fix/legacy-v067-run-preflight-compat) continue ;;
  esac
  if is_open "$name"; then echo "KEEP_ACTIVE_PR ${name}"; continue; fi
  if git merge-base --is-ancestor "$sha" refs/remotes/origin/main || approved_squash "$name" "$sha"; then
    echo "SAFE_TO_DELETE ${name} at ${sha}"
    ((count+=1))
    if [[ "${ISSUE18_PRUNE_APPLY}" == yes ]]; then
      # Lease protects concurrent pushes. Do not alter any other refs.
      git push --force-with-lease="refs/heads/${name}:${sha}" origin ":refs/heads/${name}"
      ((deleted+=1))
    fi
  else
    echo "KEEP_UNIQUE ${name}"
  fi
done < <(git for-each-ref --format='%(refname:strip=3) %(objectname)' refs/remotes/origin | sort)
echo "ISSUE18_BRANCH_PRUNE mode=${ISSUE18_PRUNE_APPLY} candidates=${count} deleted=${deleted}"
