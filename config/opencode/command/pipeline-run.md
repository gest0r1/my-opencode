---
description: Execute approved design-freeze manifest inside owner's selected worktree
 tags: pipeline, execution, unattended, github-handoff
---

# Pipeline Run — one owner-selected worktree

Execute only frozen, owner-approved manifest in the **current worktree-session**. Never create/switch/rebase/merge/delete a worktree or branch, never create another user-facing OpenChamber session, never dispatch PLAN into a different session. The owner is responsible for one RUN at a time across all worktrees and for the eventual merge into main.

Usage:

```text
/pipeline-run <run-id> [--unattended] [--no-session-reuse]
/pipeline-run <run-id> github <handoff-id> [--unattended] [--no-session-reuse]
```

Unknown modes/arguments block. GitHub handoff mode retains its existing immutable-source validation contract; do not route it through implicit worktree setup.

## Authority

- `stage-cli` owns frozen rules, manifest hash, DAG readiness and state transitions.
- `git-worktree-cli` owns read-only worktree identity/main freshness/scope and non-force candidate publication.
- `gate-runner-cli` executes frozen machine gates and records evidence.
- LLM agents cannot override deterministic FAIL/BLOCKED or make owner decisions.

## Preflight (normal mode)

1. `stage-cli validate <run-id> --json` and `stage-cli next <run-id> --json`: require approved/in_progress or terminal state, matching manifest/rules hashes. Never update the old approved manifest to work around a base change.
2. `git-worktree-cli.ts adopt <manifest>`: require current checkout to be an owner-created linked worktree, exact approved branch, clean tracked checkout, main HEAD equal to frozen `git_setup.base_sha`, branch containing that base, and no tracked `.tmp/pipelines`. This is read-only. **Do not execute `capability`, `setup`, `git switch`, `git checkout`, `git worktree add`, `rebase` or `merge`.**
3. `git-worktree-cli.ts verify <manifest>`: compare all committed changes since base, staged, unstaged and untracked files to allowed_change_paths; protected secrets and out-of-scope files block. Verify again at the start of each stage and immediately before publish.
4. If main has advanced since planning, return `STALE_PLAN`/BLOCKED. The owner first snapshots all planning artifacts outside the worktree, updates the branch, checks research survives and generates a new run ID/manifest/approval. See `project/manual-worktree-flow.md`. No automatic migration of frozen `state.json`.
5. Owner policy: another RUN must not be active. No custom cross-worktree scheduler is introduced. Existing shared-runtime locks remain as a defence against accidental concurrent runtime mutations.

## Execution scheduler

Use `stage-cli next` as the only source of runnable stages. Within the **single RUN**, independent approved stages/work items may run concurrently as allowed by the DAG. Before each stage call `git-worktree-cli.ts verify <manifest>`; on failure block before dispatch. Then `stage-cli start`, execute, record deterministic or qualitative evidence, `stage-cli complete|block|fail`, and query `next` until terminal state. Do not recompute source-file conflicts during RUN; they were frozen in PLAN.

## Stage dispatch

- `implementation` / `technical_fix`: delegate exact approved scope and context to CoderAgent. After each source mutation require `git-worktree-cli verify`. CoderAgent cannot perform Git publication or state transitions.
- `build`, `tests`, `lint`, `typecheck`: only `gate-runner-cli.ts <run-id> <pipeline-id> <gate>` can report machine PASS. TestEngineer/BuildAgent may interpret evidence but cannot replace it.
- `review`: fresh CodeReviewer; classify technical_fix/replan/security_stop/scope_stop/secret_stop/optional. Reviewer writes only approved evidence.
- `docs`: DocWriter changes only approved paths.
- `publish_candidate`: `git-worktree-cli verify <manifest>` then `git-worktree-cli publish <manifest>`; scoped commit and non-force push of currently selected branch, verify remote SHA and store candidate.json. The pipeline does **not** merge into main.
- `runtime_install`, `release_validation`, `smoke`: only frozen gate-runner commands, exact `{candidate_sha}` from candidate.json and existing runtime_locks; no test from uncommitted source in place of GitHub candidate installation.

After technical_fix of a published candidate: revalidate scope, rerun affected fast gates, publish a new exact SHA, reinstall from GitHub and retest. No silent plan/scope changes.

## Approval and reuse

`--unattended` eliminates repeat approvals inside frozen scope only; it never approves expanded scope, a new base SHA, security exceptions or merge. Replan on architecture/scope decisions. Reuse child task sessions only for exact `{run_id,pipeline_id,stage,role,work_item_id}` and CoderAgent/TestEngineer/BuildAgent technical fixes. Planning/review sessions are always fresh; invalid reuse falls back to fresh, never a separate user worktree-session. Registry and metrics remain `.tmp/pipelines/{run-id}/`.

## Handoff mode

For `github <handoff-id>`, require `github_handoff_prepare` and `github_handoff_status` with exact source SHA, worktree and validated scope, then execute only generated validation manifest stages. No implicit setup, branch switching, free-form git, force-push or handoff-ref change. Publish only validated allowed-scope result through `github_handoff_publish`.

## Stop conditions

Block on stale main/base SHA, wrong worktree, changed file out of scope, missing owner approval, deterministic gate failure, secret/security/destructive condition or runtime failure requiring architectural change. If `stage-cli next` has no runnable stages, use actual terminal state; do not bypass prerequisites.

At terminal, return run and pipeline states, branch, candidate/source SHA, machine evidence, runtime results, fix loops, blockers and reuse decisions. Remind owner to merge manually only after reviewing result, then refresh the next worktree's base and PLAN. Never delete `.tmp/pipelines` or its historical runs.
