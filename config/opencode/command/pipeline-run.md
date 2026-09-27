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

Unknown modes/arguments BLOCK.

## Authority

`stage-cli` owns frozen manifest/rules/planning evidence, DAG, executor contracts and state. `git-worktree-cli` owns identity/scope/non-force publication. `gate-runner-cli` owns only stages explicitly frozen as `local_gate`. `github-actions-gate-cli` owns authoritative GitHub Actions CI/DEV validation, exact-candidate run selection and evidence. Model output never overrides deterministic FAIL/BLOCKED or owner decisions. OpenStage is the only orchestrator; never delegate orchestration to BatchExecutor or another child.

## Preflight

1. `stage-cli validate <run-id> --json`, then `stage-cli run-preflight <run-id> --json`, then `stage-cli next <run-id> --json`; require approved/in-progress state, schema v2 for canonical RUN, and matching frozen manifest/rules/evidence/project-policy hashes. Schema v1 is audit/read-only: `run-preflight` returns `LEGACY_V1_REPLAN_REQUIRED`, so the old run must be replanned into a newly approved v2 manifest.
2. Invoke `stage-cli preflight <manifest.json> --environment` before dispatch. Schema v2 rechecks planning evidence, source snapshot, work-items, conflict serialization, explicit executor coverage, GitHub gate/bootstrap contracts and package-manager contract for `local_gate` only.
3. `git-worktree-cli freshness <manifest>`: fetch `origin/main`. Relevant drift in allowed/freshness/global dependency/pipeline config is `STALE_PLAN` → BLOCK for `/pipeline-refresh` + new approval. Unrelated drift may be deterministically merged and recorded as effective run base. Merge conflicts are never agent-resolved scope expansion.
4. `git-worktree-cli adopt <manifest>`; then `verify <manifest>`.
5. Owner ensures no other RUN is active. Runtime locks remain secondary safety for external mutable targets.

## Scheduler and frozen work

`stage-cli next <run-id> --json` is the ONLY runnable queue. Do not recompute planning dependencies during RUN.

For implementation stages, dispatch only work-item IDs frozen in the v2 manifest. Resolve the exact frozen path+SHA-256 and pass that work item plus its `decision_ids/research_ids/contract_ids`, context files and `allowed_change_paths` to the worker. Never invent an ad-hoc work item during RUN. A missing/changed work item is BLOCKED/replan.

Before each stage:
1. `stage-cli start`;
2. GitHub sync;
3. execute only the frozen executor; source-changing `agent` work is followed by Git scope verification, while a dedicated `git_verify` stage runs `git-worktree-cli verify` after its start so its evidence is fresh for that stage;
4. record deterministic evidence;
5. `stage-cli complete|block|fail`;
6. sync again;
7. query `next`.

Pending GitHub outbox events must be zero before publish/PR handoff.

## Dispatch and machine gates

Dispatch strictly by the frozen `executors[stage_id]`; never infer executor from a stage name.

- `agent`: implementation / `technical_fix` work goes to the scoped worker for the exact frozen work item. Worker agents never publish or transition state.
- `review`: fresh CodeReviewer with `technical_fix|replan|security_stop|scope_stop|secret_stop|destructive_stop|optional`.
- `local_gate`: call `gate-runner-cli.ts <run-id> <pipeline-id> <stage-id>`. Only its PASS evidence can satisfy the stage; `stage-cli complete` verifies the canonical evidence file.
- `git_verify`: after `stage-cli start`, use only `git-worktree-cli verify <manifest>`. It writes canonical `git-verify.json`; `stage-cli complete` rejects missing or pre-stage/stale verify evidence.
- `git_publish`: Git verify, then `git-worktree-cli publish <manifest>`. `stage-cli complete` requires PASS `candidate.json` with `candidate_sha == remote_sha`.
- `github_ci`: first run `github-actions-gate-cli.ts validate <run-id> <pipeline-id> <stage-id>`, then after candidate publication call `github-actions-gate-cli.ts run <run-id> <pipeline-id> <stage-id>`. It accepts only the frozen workflow/event/branch and the exact published SHA, successful terminal job and required artifact. `stage-cli complete` independently verifies that evidence.
- `github_dev`: call deterministic `validate` then `run`. Both modes consume the exact artifact from the PASS `source_ci_stage` and must return evidence with `installed_sha == candidate_sha`. `disposable` dispatches an existing secret-free workflow on the candidate ref; `stateful` dispatches an existing workflow from frozen `trusted_ref` (normally `main`) and protected environment. Neither mode may be bootstrapped and then consumed as a separate DEV workflow in the same candidate run; missing DEV automation is implemented as disposable runtime/E2E inside candidate `github_ci`.
- Source documentation is changed by DocWriter only when represented by a frozen `agent` work item/scope and must complete before `git_publish`. Deterministic docs checks, if any, are explicit `local_gate` or `github_ci` stages. Post-publish finalization may update pipeline/PR metadata only; any repository source change after publication requires a new candidate SHA and rerun of affected GitHub/runtime gates.

### Missing or incompatible project workflow

A frozen GitHub gate marked `bootstrap_required` means RUN must implement the mapped CI/bootstrap work item in the TARGET PROJECT before candidate publication. After that source change:

1. Git scope verify;
2. `github-actions-gate-cli validate <run-id> <pipeline-id> <github-stage>`;
3. if validation is not PASS, repair only inside the same frozen work item/scope using the normal technical-fix counter;
4. publish the candidate branch;
5. for first-time workflows use the frozen `push` trigger and wait for that exact candidate SHA.

Never replace a missing, incompatible or failed authoritative GitHub workflow with local npm/pnpm/pytest/build commands. If the frozen bootstrap/adaptation scope cannot produce a valid workflow, BLOCK/replan.

Respect the repository package-manager contract for `local_gate`. Missing local tooling is environment BLOCKED; it does not authorize changing package managers.

## technical_fix loops — maximum 3

For a failed qualitative/machine gate that is classified `technical_fix` and remains inside frozen scope:

1. diagnose from evidence;
2. BEFORE changing source, call `stage-cli fix-cycle <run-id> <stage> --pipeline <id>`; it must PASS and increments the frozen state counter;
3. if a `git_publish` stage had already completed before the failed stage, `fix-cycle` deterministically reopens the chain from the preceding `git_verify` through publish/CI/DEV; do not call `resume` on the old failed gate or manually preserve its completed downstream state;
4. apply one scoped fix using the same frozen work item identity;
5. query `stage-cli next`; for a post-publish fix the next stage must be the reopened `git_verify`, followed by normal `git_publish` and affected GitHub gates;
6. for a pre-publish fix, rerun the failed gate and every downstream gate invalidated by the change.

Maximum **3 automatic technical_fix cycles per stage/work-item**. Record the cycle number in review/evidence. A fourth required fix is `blocked` and requires owner attention/replan. `replan`, security, secret, destructive or scope findings never consume/enter a technical-fix loop.

After any source-changing fix to an already published candidate: Git verify, publish a NEW candidate SHA, then rerun every affected `github_ci`, artifact, `github_dev`/runtime and acceptance gate. Evidence from the previous candidate is stale by construction and `stage-cli complete` must reject it.

## Status semantics

- `ready`: functional/acceptance gates through frozen `ready_after_stage` passed.
- `release_ready`: release/build/runtime gates through `release_ready_after_stage` passed.
- `completed`: every frozen stage, including pre-publish source documentation and post-validation non-source handoff/finalization, is completed/skipped with evidence.

Do not use natural-language completion to skip these state transitions. A pipeline may continue from `ready` or `release_ready` into later frozen stages.

## GitHub Issue / PR handoff

Before successful handoff drain Issue status outbox:

```text
node /root/.config/opencode/skills/task-management/scripts/pipeline-github-sync.mjs sync <run-id>
```

After every frozen stage is completed and `git-worktree-cli publish` produced PASS `candidate.json`, create/update the one delivery PR only through:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-pr-cli.ts create <run-id>
```

The deterministic PR boundary verifies frozen repository, completed Issue mapping, non-default candidate branch and `candidate_sha == remote_sha`; it writes close keywords for completed Issues and requires PR-link outbox `pending=0`. Never use free-form `gh pr create`, `gh api` or merge commands. Owner merges manually.

## Owner approval and unattended

`--unattended` skips interaction only inside the already-approved frozen scope. It does not approve decisions, changed scope/base/manifest/evidence, exceptions or merge.

Reuse child sessions only for CoderAgent/TestEngineer/BuildAgent technical-fix cycles with exact:

```text
{run_id,pipeline_id,stage,role,work_item_id}
```

Planning/reviews are always fresh. Invalid reuse starts a fresh child, never another worktree session.

## GitHub handoff mode

`github_handoff_prepare` / `github_handoff_status` verify immutable source/worktree and generated validation. Approved technical fixes use at most **3 cycles**. `github_handoff_publish` publishes only a validated outcome. No implicit Git setup, force push or ref change.

## Stops

BLOCK on stale main/base, wrong worktree, changed planning evidence/source snapshot/project policy/work item, scope violation, unresolved owner decision, manifest/rules mismatch, GitHub gate without a valid frozen contract, missing workflow without its frozen bootstrap/adaptation work item, GitHub run/evidence from the wrong SHA/workflow/job/artifact, local-gate package-manager/environment failure, secret/security/destructive condition, conflict that requires a DAG change, runtime failure needing design change, or a fourth technical-fix cycle.

If queue is empty, report the actual terminal state; never bypass prerequisites or rewrite frozen evidence. Include run/pipeline status, branch, source/candidate SHA, work-item IDs, machine evidence, runtime result, technical-fix cycle counts and blocker dossier. Never delete historical runs.
