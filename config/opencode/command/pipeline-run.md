---
description: Execute an approved design-freeze manifest inside the owner's selected worktree
tags:
  - pipeline
  - execution
  - unattended
  - github-handoff
---

# Pipeline Run — one owner-selected worktree

Execute only a frozen, owner-approved manifest in the **current worktree-session**. Never create/switch/rebase/merge/delete a worktree or branch, never create a user-facing OpenChamber session or dispatch PLAN into another session. Owner runs exactly one RUN at a time across worktrees, then merges manually.

```text
/pipeline-run <run-id> [--unattended] [--no-session-reuse]
/pipeline-run <run-id> github <handoff-id> [--unattended] [--no-session-reuse]
```

Unknown modes/arguments block. The GitHub handoff mode preserves its immutable-source validation and does not use implicit worktree setup.

## Authority

`stage-cli` owns frozen rules/manifest/DAG/state; `git-worktree-cli` owns read-only checkout identity/main SHA/scope and non-force candidate publication; `gate-runner-cli` owns executable machine gates/evidence. LLM judgement cannot override deterministic FAIL/BLOCKED or owner decisions. Не делегируй orchestration в BatchExecutor; OpenStage directly dispatches child agents in its current session.

## Preflight — normal mode

1. `stage-cli validate <run-id> --json` and `stage-cli next <run-id> --json`: require approved or in-progress state, matching frozen manifest and rules hashes; terminal results are reported without rerunning stages.
2. `git-worktree-cli.ts adopt <manifest>`: require owner-created linked worktree, current branch equals approved branch, clean tracked checkout, local main equals frozen `git_setup.base_sha`, branch contains that main commit and `.tmp/pipelines` is not tracked. This is read-only. **Never call `capability`, `setup`, `git switch`, `git checkout`, `git worktree add`, `rebase` or `merge`.**
3. `git-worktree-cli.ts verify <manifest>` checks committed changes since base, staged, unstaged and untracked paths against `allowed_change_paths`. Protected secrets and outside-scope files block. Call again at each stage boundary and immediately before publication.
4. If main advanced: `STALE_PLAN`/BLOCKED. Owner snapshots all B planning artifacts outside B, updates the branch from main, verifies preservation, creates NEW run ID/manifest and gives explicit new approval. See `project/manual-worktree-flow.md`. Do not edit the old frozen manifest/state.
5. Owner ensures no other RUN is active. Do not build a cross-worktree scheduler. Existing shared-runtime locks remain a secondary safety gate.

## Scheduler loop

Use `stage-cli next <run-id> --json` as the sole source of runnable stages. Independent approved work items **within this one RUN** may execute concurrently according to the frozen DAG. Before every stage, call `git-worktree-cli verify <manifest>`; on failure block before dispatch. Then call `stage-cli start`, execute the stage, record evidence, `stage-cli complete|block|fail`, and query `next` until terminal. Do not recompute planning dependencies/conflicts during RUN.

## Dispatch

- Implementation/technical_fix: delegate exact approved work item/context/scope to CoderAgent. After each source change require `git-worktree-cli verify`; CoderAgent does not do state transitions or publish.
- Build/tests/lint/typecheck: `gate-runner-cli.ts <run-id> <pipeline-id> <gate>` is the only source of machine PASS. TestEngineer and BuildAgent may analyse evidence, not substitute an LLM PASS.
- Review: fresh CodeReviewer, classifying technical_fix/replan/security_stop/scope_stop/secret_stop/optional. Review evidence stays under run-scoped `.tmp/`.
- Docs: DocWriter modifies only approved docs scope.
- Publish candidate: `git-worktree-cli verify <manifest>` followed by `git-worktree-cli publish <manifest>`; scoped commit, non-force push of current branch, remote SHA check and `candidate.json`. Pipeline never merges to main.
- Runtime install/release validation/smoke: use frozen gate-runner commands and exact `{candidate_sha}` from candidate.json with existing runtime_locks. Never test uncommitted development files as a replacement for installation from GitHub.

After technical_fix of a published candidate, revalidate scope, rerun affected fast gates, publish a new exact SHA, reinstall from GitHub and retest. A blocker requiring scope/architecture change causes replan, never a silent mutation of manifest.

## Approval, unattended and child reuse

`--unattended` avoids redundant questions inside frozen scope only; it does not approve a new base SHA, expanded scope, security exceptions or merge. Reuse child task sessions only for CoderAgent/TestEngineer/BuildAgent technical fixes with exact `{run_id,pipeline_id,stage,role,work_item_id}`. Planning/review sessions remain fresh; invalid reuse falls back to a fresh child, never another user worktree-session. Registry/metrics remain under `.tmp/pipelines/{run-id}/`.

## GitHub handoff mode

`github_handoff_prepare(run_id, handoff_id)` and `github_handoff_status` must verify immutable ref/source SHA and worktree; execute only generated validation stages and their approved fix scope (max two loops). `github_handoff_publish` publishes only validated result. No implicit Git setup, force-push or handoff-ref change.

## Stops and result

Block on stale main/base SHA, wrong worktree, out-of-scope changes, owner decision, deterministic failure, secret/security/destructive condition or runtime failure requiring design change. If runnable queue is empty, report real terminal state; never bypass prerequisites. Return run/pipeline statuses, branch, source/candidate SHA, machine evidence, runtime results, fix loops and blockers. Owner merges manually, then refreshes the next worktree and PLAN. Never remove historical `.tmp/pipelines` runs.
