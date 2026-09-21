# Manual worktree pipeline: several PLANs, exactly one RUN

The **owner** creates/selects worktrees and sessions in OpenChamber, approves design-freeze, merges completed branches into main and updates the next branch. The pipeline never creates/switches/rebases/merges/removes owner worktrees or sessions. RUNs are serialized by the owner; other worktrees may prepare PLANs while A runs.

## Routine UI commands

1. Owner: create worktree A from current main and open a **new session within A**, selecting OpenStageOrchestrator. Do the same independently for B/C if needed; do not create sessions through an agent in main.
2. In A session: `/pipeline-plan <task A>`; review the decision packet and approve. Then `/pipeline-run <run-id-A> --unattended`.
3. While A runs, use B's own session for `/pipeline-plan <task B>`; do not start RUN B. Its PLAN is valid relative to the main commit captured in B's manifest at planning time.
4. When A reaches PASS and exact candidate has been tested from GitHub, owner reviews and merges A into main. Never merge automatically.
5. Before RUN B, snapshot B's **entire** `.tmp/pipelines` outside B, update B from the new main, verify the snapshot, create a *new* run ID and revalidate/reapprove B's PLAN. Do not overwrite its old manifest or state. Then start RUN B.

## Exact owner shell sequence after merge A

Execute the following with real paths on the development host; `B` is the existing worktree directory and `MAIN` is the primary checkout directory. All permanent snapshot files go under the repository's **shared Git directory**, not under worktree B. No network operation touches runtime services.

```bash
set -Eeuo pipefail
B='/absolute/path/to/worktree-B'       # set to actual existing B worktree
MAIN='/absolute/path/to/main-checkout'  # set to actual main checkout
RUN_B='run-id-B'                        # the historical B plan to protect

test -d "$B/.tmp/pipelines/$RUN_B"
test -f "$B/.tmp/pipelines/$RUN_B/manifest.json"
test -z "$(git -C "$B" status --porcelain --untracked-files=all)" || { echo 'BLOCKED: save tracked changes first'; exit 1; }
git -C "$B" check-ignore -q .tmp/pipelines/__probe__ || { echo 'BLOCKED: add .tmp/ to project gitignore safely'; exit 1; }
test -z "$(git -C "$B" ls-files -- .tmp/pipelines)" || { echo 'BLOCKED: pipeline artifacts are tracked'; exit 1; }
test "$(git -C "$B" rev-parse --is-linked-worktree)" = true
test "$(git -C "$MAIN" branch --show-current)" = main

umask 077
COMMON="$(git -C "$B" rev-parse --path-format=absolute --git-common-dir)"
BACKUP_DIR="$COMMON/pipeline-backups"
mkdir -p -- "$BACKUP_DIR"
BACKUP="$(mktemp "$BACKUP_DIR/before-B-refresh.XXXXXXXX.tar.gz")"
tar -C "$B" -czf "$BACKUP" .tmp/pipelines
sha256sum "$BACKUP" > "$BACKUP.sha256"
sha256sum -c "$BACKUP.sha256"
tar -tzf "$BACKUP" > /dev/null
printf 'Snapshot: %s\n' "$BACKUP"
```

**Do not run the Git commands below unless snapshot checks passed and A has already been merged into main.** The owner executes these commands, not the pipeline agent:

```bash
# Owner: sync primary main with merged A (requires clean main).
test -z "$(git -C "$MAIN" status --porcelain --untracked-files=all)" || { echo 'BLOCKED: main is dirty'; exit 1; }
git -C "$MAIN" fetch origin main
git -C "$MAIN" merge --ff-only origin/main

# Only for an unpublished, owner-only B branch. If B was already published/shared,
# use `git -C "$B" merge main` instead of rebase, avoiding history rewrites.
git -C "$B" rebase main

# Compare every planning file to the immutable snapshot before creating a new run.
VERIFY_DIR="$(mktemp -d /tmp/pipeline-verify.XXXXXXXX)"
tar -xzf "$BACKUP" -C "$VERIFY_DIR"
diff -qr -- "$VERIFY_DIR/.tmp/pipelines" "$B/.tmp/pipelines"
rm -rf -- "$VERIFY_DIR"  # own /tmp test copy only; backup remains untouched
sha256sum -c "$BACKUP.sha256"

# Old manifest remains historical, but must now fail the main/base gate.
git -C "$B" rev-parse HEAD
git -C "$MAIN" rev-parse HEAD
printf 'Old run preserved: %s\nSnapshot: %s\n' "$B/.tmp/pipelines/$RUN_B" "$BACKUP"
```

If rebase reports conflicts, stop and resolve explicitly, without `git clean -fdx`, `reset --hard`, `worktree remove`, or deleting `.tmp` to force success. Inspect/restore from snapshot only by owner decision. If `diff -qr` fails, **do not run B**; investigate and restore the preserved files. The backup lives in the shared Git directory and survives deletion of B's worktree, but still needs ordinary server backups for disaster recovery.

## Refresh PLAN B without losing work

In B's existing session, instruct OpenStageOrchestrator:

```text
/pipeline-plan Revalidate the historical PLAN in .tmp/pipelines/<old-run-id>/ against current main after merge A. Reuse the full historical research and decisions as evidence, inspect changes to source/contracts/dependencies, create a NEW run ID and NEW manifest in a separate .tmp/pipelines/<new-run-id>/ folder, and show a focused delta and owner decision packet. Do not edit the historical run, state, manifest or evidence. Do not run implementation.
```

Review and approve the **new** manifest; run `/pipeline-run <new-run-id> --unattended` only after the Git preflight passes. `git_setup.base_sha` must equal the freshly updated local main SHA, and the selected branch must contain that SHA. The old run remains available for audit, not for execution. Never copy `state.json`, locks, candidate or gate evidence to the new run; deterministic CLI recreates them after approval.

When B is completed and merged, repeat the same steps for C. A tested candidate SHA before merge does not automatically validate the integrated main SHA; validate the final production artifact separately.

## Safety boundary

- `.tmp/pipelines/` is worktree-local and ignored only if the **project's** `.gitignore` (or equivalent effective ignore) says so. Git does not back up ignored files. A normal rebase usually leaves them in place, but a checkout, clean or worktree removal can erase/overwrite them; snapshot is mandatory.
- Keep backup outside the worktree under the shared Git directory and confirm content with `diff -qr`; do not overwrite an old manifest to adjust base SHA.
- Manual one-RUN policy avoids a new scheduler. Existing external-runtime locks remain a secondary guard; avoid overlapping installs on shared runtime.
- Agent modifies distribution code only in GitHub; owner decides when to install updates and when to merge.
