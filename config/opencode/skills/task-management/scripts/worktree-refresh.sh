#!/usr/bin/env bash
# Refresh the worktree of the CURRENT OpenCode session after owner merged A to origin/main.
# Explicit owner invocation only. Never starts RUN or edits historical pipeline state.
set -Eeuo pipefail

case "${1:---apply}" in
  --apply|--check) MODE="${1:---apply}" ;;
  *) echo 'Usage: worktree-refresh.sh [--check|--apply]' >&2; exit 2 ;;
esac
(( $# <= 1 )) || { echo 'Unexpected arguments' >&2; exit 2; }
for tool in git tar sha256sum mktemp flock awk find; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
fail() { echo "BLOCKED: $*" >&2; exit 1; }

# Determine the selected session checkout. Never infer B from an absolute project path.
B="$(git rev-parse --show-toplevel 2>/dev/null)" || fail 'Start the command INSIDE the worktree B session'
BRANCH="$(git -C "$B" branch --show-current)"
[[ -n "$BRANCH" && "$BRANCH" != main && "$BRANCH" != master ]] || fail 'B must have its own non-default branch'
GIT_DIR="$(git -C "$B" rev-parse --path-format=absolute --git-dir)"
COMMON="$(git -C "$B" rev-parse --path-format=absolute --git-common-dir)"
[[ "$GIT_DIR" != "$COMMON" ]] || fail 'Primary checkout is not an owner-created linked worktree'

# Git porcelain associates each worktree record with its branch. Exactly one main is required.
MAIN="$(git -C "$B" worktree list --porcelain | awk '
  /^worktree / { path=substr($0, 10) }
  /^branch refs\/heads\/main$/ { result=path; count++ }
  END { if (count == 1) print result; else exit 1 }
')" || fail 'Exactly one checked-out main worktree is required'
[[ "$MAIN" != "$B" ]] || fail 'Refusing to refresh main as B'
[[ "$(git -C "$MAIN" rev-parse --path-format=absolute --git-common-dir)" == "$COMMON" ]] || fail 'main belongs to another repository'
[[ "$(git -C "$MAIN" branch --show-current)" == main ]] || fail 'main worktree is not on main'
[[ -z "$(git -C "$B" status --porcelain --untracked-files=all)" ]] || fail 'B is dirty: commit/save ALL tracked and untracked work first'
[[ -z "$(git -C "$MAIN" status --porcelain --untracked-files=all)" ]] || fail 'main is dirty: resolve before refresh'
[[ -d "$B/.tmp/pipelines" && ! -L "$B/.tmp" && ! -L "$B/.tmp/pipelines" ]] || fail 'Expected a real .tmp/pipelines directory in B'
[[ -n "$(find "$B/.tmp/pipelines" -type f -name manifest.json -print -quit)" ]] || fail 'No PLAN manifest found: nothing to preserve'
[[ -z "$(find "$B/.tmp/pipelines" -type l -print -quit)" ]] || fail 'PLAN contains symlinks: resolve them before taking a complete snapshot'
git -C "$B" check-ignore -q .tmp/pipelines/__probe__ || fail '.tmp/pipelines is not ignored by this PROJECT; fix its ignore configuration safely'
[[ -z "$(git -C "$B" ls-files -- .tmp/pipelines)" ]] || fail '.tmp/pipelines is tracked by Git; preserve/untrack it safely before refresh'
for dir in "$GIT_DIR" "$COMMON"; do
  [[ ! -e "$dir/MERGE_HEAD" && ! -d "$dir/rebase-apply" && ! -d "$dir/rebase-merge" ]] || fail 'Git merge/rebase already in progress'
done

OLD_MAIN="$(git -C "$MAIN" rev-parse HEAD)"
OLD_B="$(git -C "$B" rev-parse HEAD)"
printf 'WORKTREE: %s\nBRANCH: %s\nMAIN: %s\nOLD MAIN: %s\nOLD B: %s\n' "$B" "$BRANCH" "$MAIN" "$OLD_MAIN" "$OLD_B"
if [[ "$MODE" == --check ]]; then
  echo 'CHECK PASS: read-only; no snapshot, fetch, merge, rebase, approval or RUN performed'
  exit 0
fi

# A shared-Git backup is outside ALL linked worktrees and survives B rebase/removal.
BACKUP_DIR="$COMMON/pipeline-backups"
mkdir -p -- "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.refresh.lock"
flock -n 9 || fail 'Another pipeline refresh is in progress'
BACKUP=''
trap 'rc=$?; echo "REFRESH FAILED (exit $rc). Snapshot: ${BACKUP:-not yet created}. No RUN started." >&2' ERR
umask 077
SNAPSHOT_DIR="$(mktemp -d "$BACKUP_DIR/before-B-refresh.XXXXXXXX")"
BACKUP="$SNAPSHOT_DIR/pipelines.tar"
# Normalized deterministic archive makes post-merge verification independent of tar extraction.
TAR_ARGS=(--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner)
tar "${TAR_ARGS[@]}" -C "$B" -cf "$BACKUP" .tmp/pipelines
sha256sum "$BACKUP" > "$BACKUP.sha256"
sha256sum -c "$BACKUP.sha256"
tar -tf "$BACKUP" >/dev/null
SNAPSHOT_SHA="$(sha256sum "$BACKUP" | awk '{print $1}')"
printf 'SNAPSHOT VERIFIED: %s\n' "$BACKUP"

# Owner already merged A on GitHub. Update main fast-forward only, then merge it into B.
# Merge (rather than force/rebase) also works for published B and never rewrites B history.
git -C "$MAIN" fetch origin main
git -C "$MAIN" merge --ff-only FETCH_HEAD
NEW_MAIN="$(git -C "$MAIN" rev-parse HEAD)"
git -C "$B" merge --no-edit "$NEW_MAIN"
git -C "$B" merge-base --is-ancestor "$NEW_MAIN" HEAD || fail 'B does not contain refreshed main'

# Reconstruct the same byte stream without extracting the snapshot or modifying PLAN.
CURRENT_SHA="$(tar "${TAR_ARGS[@]}" -C "$B" -cf - .tmp/pipelines | sha256sum | awk '{print $1}')"
[[ "$CURRENT_SHA" == "$SNAPSHOT_SHA" ]] || fail "PLAN/EVIDENCE CHANGED: snapshot preserved at $BACKUP; do NOT start RUN"
sha256sum -c "$BACKUP.sha256"
printf 'REFRESH PASS\nBRANCH: %s\nNEW_BASE_SHA: %s\nB_HEAD: %s\nHISTORICAL_PLAN: unchanged\nSNAPSHOT: %s\nNEXT: create NEW run-id/manifest, compare PLAN with new main, obtain owner approval; do not RUN the old manifest\n' \
  "$BRANCH" "$NEW_MAIN" "$(git -C "$B" rev-parse HEAD)" "$BACKUP"
