# Manual worktree pipeline: several PLANs, exactly one RUN

The owner creates/selects worktrees and sessions in OpenChamber, approves the plan, merges completed work into main and updates the next branch. The pipeline never creates, switches, rebases, merges or removes owner worktrees or user-facing sessions. The owner starts only one RUN at a time; B and C may PLAN while A runs.

## OpenChamber sequence

1. Owner creates worktree A from current main, opens a new session **inside A** and selects OpenStageOrchestrator. Repeat for B/C if desired; never dispatch creation from a session in main.
2. In A: `/pipeline-plan <task A>`; review/approve; then `/pipeline-run <run-id-A> --unattended`.
3. While A runs, use B's own session for `/pipeline-plan <task B>` but do not start RUN B.
4. After A's candidate SHA is published to GitHub and tested from the installed artifact, owner reviews and merges A into main. Neither the agent nor pipeline merges automatically.
5. Snapshot B's entire `.tmp/pipelines` **outside worktree B** before bringing in the new main. Verify preservation, create a new run ID/manifest based on the updated main and seek renewed approval. Then run B.

## Owner commands: safely refresh B after A has been merged

Run the blocks below in the **same bash session** so that `B`, `MAIN`, `RUN_B` and `BACKUP` survive. Replace placeholders with actual absolute paths and run IDs. A must already be merged into remote `main`. Never perform these owner Git commands through the pipeline agent.

### 1. Preconditions and a private archive outside B

```bash
set -Eeuo pipefail
B='/absolute/path/to/worktree-B'       # existing worktree, not main
MAIN='/absolute/path/to/main-checkout'  # primary checkout
RUN_B='run-id-B'                        # historical PLAN to preserve

test -d "$B/.tmp/pipelines/$RUN_B"
test -f "$B/.tmp/pipelines/$RUN_B/manifest.json"
test -z "$(git -C "$B" status --porcelain --untracked-files=all)" || { echo 'BLOCKED: save non-ignored B changes first'; exit 1; }
git -C "$B" check-ignore -q .tmp/pipelines/__probe__ || { echo 'BLOCKED: project must ignore .tmp/pipelines'; exit 1; }
test -z "$(git -C "$B" ls-files -- .tmp/pipelines)" || { echo 'BLOCKED: planning artifacts are tracked'; exit 1; }
B_GIT_DIR="$(git -C "$B" rev-parse --path-format=absolute --git-dir)"
COMMON="$(git -C "$B" rev-parse --path-format=absolute --git-common-dir)"
test "$B_GIT_DIR" != "$COMMON" || { echo 'BLOCKED: B is not a linked worktree'; exit 1; }
test "$(git -C "$MAIN" branch --show-current)" = main || { echo 'BLOCKED: primary checkout must be main'; exit 1; }

umask 077
BACKUP_DIR="$COMMON/pipeline-backups"
mkdir -p -- "$BACKUP_DIR"
BACKUP="$(mktemp "$BACKUP_DIR/before-B-refresh.XXXXXXXX.tar.gz")"
tar -C "$B" -czf "$BACKUP" .tmp/pipelines
sha256sum "$BACKUP" > "$BACKUP.sha256"
sha256sum -c "$BACKUP.sha256"
tar -tzf "$BACKUP" > /dev/null
printf 'PLAN snapshot: %s\n' "$BACKUP"
```

The snapshot contains every manifest, decision, research artifact, pipeline state and evidence in B. `.tmp/` is ignored by Git only if **this project's** ignore rules cover it; ignored files are NOT committed or backed up by `git push`.

### 2. Update main and integrate it into B, only after archive checks pass

```bash
test -z "$(git -C "$MAIN" status --porcelain --untracked-files=all)" || { echo 'BLOCKED: primary main is dirty'; exit 1; }
git -C "$MAIN" fetch origin main
git -C "$MAIN" merge --ff-only origin/main

# Use this ONLY for a local unpublished owner-only B branch:
git -C "$B" rebase main
# If B is already shared/published, use `git -C "$B" merge main` INSTEAD
# (not in addition to rebase). Avoid rewriting a shared branch's history.
```

If Git reports conflicts, stop; resolve deliberately and finish `rebase --continue` (or complete the chosen merge). Never use `git clean -fdx`, `git reset --hard`, deleting `.tmp`, or `worktree remove` to force progress. Do not launch RUN B until Git integration and all checks succeed.

### 3. Verify the complete preserved PLAN byte-for-byte

```bash
VERIFY_DIR="$(mktemp -d /tmp/pipeline-verify.XXXXXXXX)"
tar -xzf "$BACKUP" -C "$VERIFY_DIR"
if ! diff -qr -- "$VERIFY_DIR/.tmp/pipelines" "$B/.tmp/pipelines"; then
  echo 'BLOCKED: planning data differs from saved snapshot; do not launch RUN B' >&2
  exit 1
fi
rm -rf -- "$VERIFY_DIR"  # only the temporary copy created above
sha256sum -c "$BACKUP.sha256"
test -f "$B/.tmp/pipelines/$RUN_B/manifest.json"
printf 'Old PLAN preserved at %s\nBackup: %s\n' "$B/.tmp/pipelines/$RUN_B" "$BACKUP"
git -C "$B" rev-parse HEAD
git -C "$MAIN" rev-parse HEAD
```

Keep the archive in the shared Git directory; it survives removal of B's worktree, but it is not a replacement for normal host backups. Investigate a failed `diff -qr` instead of silently overwriting the original data.

## Revalidate B in its existing OpenChamber session

```text
/pipeline-plan Revalidate the historical PLAN in .tmp/pipelines/<old-run-id>/ against the actual current main after merge A. Reuse its research and decisions as evidence; inspect differences in source, contracts, dependencies and test strategy. Create a NEW unique run ID and a NEW manifest under .tmp/pipelines/<new-run-id>/. Do not modify the historical run, manifest, state, decisions, research or evidence. Show only the affected-plan delta plus the owner decision packet. Do not implement or start RUN.
```

Owner approves the NEW manifest, then issues `/pipeline-run <new-run-id> --unattended`. The new `git_setup.base_sha` must equal updated local main and be an ancestor of current B. Never edit old approved manifest hashes or copy its `state.json`, locks, candidate or gate evidence into the new run. The old run is history, not an executable plan after main changes. Repeat the same process for C after B is merged.

## Boundaries

- Several PLANs, one RUN; no new cross-worktree scheduler. Existing shared runtime locks remain as a secondary safeguard.
- Build/test/review/scope gates, candidate SHA publication, installation from GitHub and runtime validation remain mandatory.
- A candidate tested before merging A is not proof that an integrated later main SHA passes; validate that final artifact separately.
- All distribution changes are made on a GitHub branch; installation and merges remain owner actions.
