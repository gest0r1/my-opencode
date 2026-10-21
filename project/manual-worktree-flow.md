# Worktree pipeline: several PLANs, one RUN, one-command refresh

The owner creates/selects worktrees and sessions in OpenChamber, approves each design-freeze, merges completed branches to GitHub main, and explicitly refreshes the next branch. The pipeline never automatically creates/switches/removes worktrees, merges completed features to main, or dispatches PLAN into another user session. The owner allows only ONE RUN at a time; other worktrees can prepare independent PLANs.

## Everyday workflow

1. Owner creates worktree A from current main in OpenChamber and opens a session **inside A** with OpenStageOrchestrator. Repeat for B/C if desired.
2. In A: `/pipeline-plan <task A>` → owner approval → `/pipeline-run <run-id-A> --unattended`.
3. During RUN A, in B: `/pipeline-plan <task B>`. No RUN B yet.
4. After A passes verified GitHub-release/runtime gates, owner reviews and merges A → `origin/main` manually in GitHub.
5. In the already-open B worktree session, owner invokes exactly **one command**:

```text
/pipeline-replan
```

Optional nonmutating preflight: `/pipeline-replan --check`.

6. Only after `REFRESH PASS`, in the SAME B session:

```text
/pipeline-plan Revalidate the historical PLAN in .tmp/pipelines/<old-run-id>/ against the refreshed main. Reuse all preserved research and owner decisions. Create a NEW run ID, NEW manifest and focused delta/decision packet; never edit the old run/manifest/state/evidence. Do not implement.
```

Owner reviews and explicitly approves the new manifest, then runs `/pipeline-run <new-run-id> --unattended`. Repeat for C after owner merges B into main. Never run B with the old approved manifest: its `base_sha` is stale. The final integrated main SHA needs its own release verification.

## What /pipeline-replan does (installed distribution, no custom OpenChamber patch)

The command invokes only the installed deterministic `~/.config/opencode/skills/task-management/scripts/worktree-refresh.sh` in the CURRENT session. It has no path or branch arguments: it derives B and the checked-out main from the shared Git repository and rejects main/primary or detached sessions. The script:

- Blocks if B or main is dirty, a Git operation is in progress, no historical PLAN exists, `.tmp/pipelines` is not ignored by this project's Git configuration or is tracked, or planning evidence contains symlinks. It never calls `reset --hard`, `clean`, `stash`, `worktree remove`, `switch` or force-push.
- Stores a verified archive of the **ENTIRE** `.tmp/pipelines/` (all run IDs, frozen manifests, decisions, research, hidden files, state/evidence) outside B at `<shared-git-dir>/pipeline-backups/before-B-refresh.*/pipelines.tar`. The checksum is stored alongside it. Git does not otherwise protect ignored `.tmp` files.
- Fetches only `origin/main`, fast-forwards the owner's clean local main checkout, then merges that exact main commit into B using `git merge --no-edit` (does not rewrite published B history).
- Re-hashes the complete planning archive as it exists after the Git merge and compares the byte-identical, normalized tar stream to the original. Prints `REFRESH PASS`, main SHA, B HEAD, and backup path only when all checks pass.
- Does **not** create a new manifest/run, change approved state, dispatch model prompts, start RUN or merge B into main. These require a subsequent PLAN/reapproval and owner action.

If Git reports a conflict, the script stops and preserves the snapshot; owner resolves the conflict explicitly and verifies historical evidence before another attempt. Do not wipe the worktree, delete `.tmp`, automatically restore or let an agent run manual Git fallbacks. If evidence comparison fails, do not start RUN; the original archive is retained for recovery. Backups in `.git` still require ordinary off-host backups for disaster recovery.

The command is available after the owner installs this `my-opencode` configuration from the exact approved GitHub commit. The existing `install.sh` copies `config/opencode/**` (including commands and scripts) into `~/.config/opencode/`. Its use does not require any change to the OpenChamber upstream application.
