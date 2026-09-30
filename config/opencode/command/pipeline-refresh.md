---
description: Owner-triggered refresh of the CURRENT worktree after A was merged to main; safely snapshot all PLAN artifacts
---

# /pipeline-refresh — current worktree only

The owner invokes this command in the **already open B worktree session**, only after A was merged to `origin/main` and no RUN is active. This explicit command authorizes ONLY the refresh operations described below. It does not approve or start a new RUN, reapprove a plan, create/delete/switch worktrees or sessions, or merge B into main.

Arguments (`$ARGUMENTS`): empty = apply refresh; exactly `--check` = read-only preflight. Any other argument: BLOCKED. Never infer a different worktree path from user text; the current session directory is the source of truth. Never run this command in a primary/main session.

1. Use the approved `git-worktree-cli.ts inspect` to show selected `directory`, `branch` and current local main. Require `linked_worktree=true` and non-default branch. If the session is not in the intended B checkout, BLOCKED; never `cd` to another checkout.
2. For `--check`, execute exactly:

```bash
bash /root/.config/opencode/skills/task-management/scripts/worktree-refresh.sh --check
```

3. For empty arguments, execute exactly this deterministic script (the owner's explicit invocation authorizes the Git changes inside it):

```bash
bash /root/.config/opencode/skills/task-management/scripts/worktree-refresh.sh
```

No other shell commands, pipes, script rewriting, `git clean`, `reset --hard`, `stash`, `worktree remove`, or manual fallback merge are authorized. Do not ask an agent to change the script at runtime.

The script enforces a clean B and main, a real owner-created linked worktree, ignored/untracked `.tmp/pipelines`, no symlinks in evidence, and an existing manifest. It snapshots **all** `.tmp/pipelines` under the shared Git directory, verifies the archive before mutations, fetches `origin/main`, updates local main with fast-forward only, merges that exact main SHA into B without rewriting B history, and verifies the evidence archive checksum against the unchanged worktree tree. Failures and conflicts are terminal BLOCKED; preserve snapshot and leave resolution to owner. No automatic recovery/cleanup.

After `REFRESH PASS`, report `NEW_BASE_SHA`, `B_HEAD`, historical manifest location and snapshot path, then instruct the owner to run `/pipeline-plan` **in this same B session** to revalidate the old run and create a NEW run ID/manifest. The old manifest/state/evidence remain historical and unchanged. Require a new owner approval before `/pipeline-run` of the NEW ID.

If the historical run uses schema v1, it is never resumed as an executable run after refresh. The new PLAN must be schema v2 and must re-inspect/freeze the target project's **current** execution contract. Deterministic test/build/typecheck/lint/install/runtime checks may be frozen as `local_gate`; for a deployable sink, place the fail-fast local set after `git_verify` and before `git_publish`, then require one lean artifactless final `github_ci` for the exact published candidate SHA. `fresh_job`/`upgrade_job` are legacy optional metadata, not mandatory GitHub jobs, and canonical final-CI provenance is workflow run/attempt + exact candidate SHA + required-job results rather than an artifact digest. Re-inspect any previously deferred `future_github_gates` that may now be trusted. Only a selected `opencode_host` strategy revalidates GitHub→OpenCode-host deployment-target readiness plus stateful Environment/trusted-ref/concurrency; `hybrid` instead freezes a post-CI `local_gate` install/update/smoke stage and does not require a deployment-target probe. Historical target/local/GitHub evidence is audit history only and is never promoted into the new run.

Do not dispatch PLAN, execute RUN or mutate old manifest in this command, even on success.
