---
description: Execute an approved design-freeze manifest inside the owner's selected worktree
tags:
  - pipeline
  - execution
  - unattended
  - github-handoff
---

# Pipeline Run — one owner-selected worktree

Execute only a frozen, owner-approved manifest in the CURRENT worktree-session. Never create/switch/rebase/merge/delete a worktree or branch; never create another user-facing OpenChamber session or dispatch PLAN elsewhere. Owner permits one RUN at a time across all worktrees.

```text
/pipeline-run <run-id> [--unattended] [--no-session-reuse]
/pipeline-run <run-id> github <handoff-id> [--unattended] [--no-session-reuse]
```

Unknown modes and arguments BLOCK. Github handoff mode preserves exact immutable-source validation and does not create implicit worktree setup.

## Authority

`stage-cli` owns rules, manifest freeze, DAG and state. `git-worktree-cli` owns identity/scope/non-force publication. `gate-runner-cli` owns machine commands and evidence. Model output never overrides deterministic FAIL/BLOCKED or owner decisions. Не делегируй orchestration в BatchExecutor; OpenStage dispatches child agents in its selected session.

## Preflight — normal mode

1. `stage-cli validate <run-id> --json` then `stage-cli next <run-id> --json`: require approved or in-progress state and matching frozen manifest/rules hashes; terminal states must be reported, not retried blindly. Inspect the referenced frozen manifest and invoke `stage-cli preflight <manifest.json> --environment` BEFORE dispatch. If it fails, BLOCK and preserve old run/manifest.
2. Run `git-worktree-cli.ts freshness <manifest>` before adopt. It fetches `origin/main`. If upstream changes intersect `allowed_change_paths`, `freshness_sensitive_paths` or global dependency/pipeline configuration, it returns `STALE_PLAN` and RUN stops for `/pipeline-refresh` + new approval. If changes are unrelated, it deterministically merges that exact `origin/main` into the selected branch, writes `git-runtime.json`/`run_base_sha`, and keeps the frozen manifest unchanged. Merge conflict is `STALE_PLAN`, never an agent-resolved scope expansion.
3. `git-worktree-cli.ts adopt <manifest>` requires the approved owner-created worktree and effective run base in HEAD.
4. `git-worktree-cli.ts verify <manifest>` checks candidate changes relative to the effective run base against frozen scope. `freshness` is a RUN-start gate while the selected worktree is clean; normal implementation changes do not trigger an implicit mid-RUN merge.
5. Owner ensures no other RUN is active. Keep shared runtime locks as secondary safety only.

## Scheduler

`stage-cli next <run-id> --json` is the ONLY runnable queue. Independent approved work items within one RUN can execute concurrently per frozen DAG. Before each stage verify Git scope, `stage-cli start`, then run `pipeline-github-sync.mjs sync <run-id>`; execute, record evidence, `stage-cli complete|block|fail`, sync GitHub again, then query next. Resume follows the same sync rule. Delivery is idempotent; transient failure leaves the outbox pending, but pending MUST be zero before publish/PR handoff. Do not recompute planning dependencies during RUN.

## Dispatch and machine gates

- Implementation / technical_fix: CoderAgent receives exact frozen item/context/allowed_change_paths. After changes require Git verify. Agents do not publish or transition stage state.
- Machine build/test/lint/typecheck/runtime stages: call `gate-runner-cli.ts <run-id> <pipeline-id> <stage-id>` with the EXACT current machine stage ID as gate. It must resolve `gate_profiles[profile][stage-id]`. Do not substitute an informal `pytest` gate key when stage is `test-rule-actions`. Use only PASS evidence from this CLI; TestEngineer/BuildAgent may diagnose but not substitute a reported manual test pass.
- Machine commands are a single executable and argv, with `shell:false`, executed from the project root. No `cd`, `&&`, pipes or shell composition. Python + pytest must be available before RUN; no stage-time ad-hoc venv or dependency bootstrap unless explicitly approved in scope and project installation strategy.
- Review: fresh CodeReviewer with technical_fix/replan/security_stop/scope_stop/secret_stop/optional classification. Evidence remains inside run-scoped `.tmp`.
- Docs: DocWriter only modifies approved docs scope.
- Publish: Git verify then git-worktree publish, scoped commit and non-force branch push with candidate.json; never merge main.
- Runtime install/smoke: use frozen machine stage gate commands with exact `{candidate_sha}` and runtime locks, install from GitHub candidate and verify installed runtime, never substitute uncommitted source execution.

After technical_fix on published candidate reverify scope, rerun affected gates, publish new exact SHA, reinstall from GitHub and retest. Scope/architecture changes require replan.

## GitHub Issue / PR handoff

For a successful `github_issues` run, require `pipeline-github-sync.mjs sync <run-id>` with `pending=0`. Create or update one PR for the current branch without merging it; include `Closes #N` for completed mapped Issues. Capture the PR number and run:

```text
node /root/.config/opencode/skills/task-management/scripts/pipeline-github-sync.mjs link-pr <run-id> <pr-number>
```

The Issue comment and state record the exact PR. The owner still merges main; GitHub close keywords close the completed Issues and preserve Issue -> run -> PR -> merge history.

## Owner approval and unattended

`--unattended` skips questions ONLY inside a previously owner-approved frozen plan. It never grants approval for a decision, modified manifest/base/scope/security exception or merge. An omitted decision such as D1 is BLOCKED pending a new owner answer; a review agent cannot self-approve. Only an explicit separate owner response to `/pipeline-plan` permits init and approve.

Reuse child task sessions only for CoderAgent/TestEngineer/BuildAgent technical fixes with exact `{run_id,pipeline_id,stage,role,work_item_id}`. Planning/reviews always fresh; invalid reuse creates fresh child, never another user worktree session.

## GitHub handoff mode

`github_handoff_prepare(run_id,handoff_id)` and `github_handoff_status` verify immutable ref/source SHA and worktree; run only generated validation and approved fix scope (max two loops). `github_handoff_publish` publishes only validated outcome. No implicit Git setup, force push or ref change.

## Stops

BLOCK on stale main/base, wrong worktree, scope violation, unresolved owner decision, manifest/rules mismatch, missing/non-executable gate, Python environment failure, secret/security/destructive condition or runtime failure needing design change. If queue empty, report actual terminal state; do not bypass prerequisites or rewrite frozen evidence. Include run/pipeline status, branch, source/candidate SHA, machine evidence, runtime result, fix loops and blocker dossier. Owner merges manually, then refreshes next worktree/PLAN. Never delete historical runs.
