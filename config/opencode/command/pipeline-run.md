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

`stage-cli` owns frozen manifest/rules/planning evidence, DAG and state. `git-worktree-cli` owns identity/scope/non-force publication. `gate-runner-cli` owns machine commands/evidence. Model output never overrides deterministic FAIL/BLOCKED or owner decisions. OpenStage is the only orchestrator; never delegate orchestration to BatchExecutor or another child.

## Preflight

1. `stage-cli validate <run-id> --json`, `stage-cli next <run-id> --json`; require approved/in-progress state and matching frozen manifest/rules/evidence/project-policy hashes.
2. Invoke `stage-cli preflight <manifest.json> --environment` before dispatch. Schema v2 rechecks planning evidence, source snapshot, work-items, conflict serialization and package-manager contract.
3. `git-worktree-cli freshness <manifest>`: fetch `origin/main`. Relevant drift in allowed/freshness/global dependency/pipeline config is `STALE_PLAN` → BLOCK for `/pipeline-refresh` + new approval. Unrelated drift may be deterministically merged and recorded as effective run base. Merge conflicts are never agent-resolved scope expansion.
4. `git-worktree-cli adopt <manifest>`; then `verify <manifest>`.
5. Owner ensures no other RUN is active. Runtime locks remain secondary safety for external mutable targets.

## Scheduler and frozen work

`stage-cli next <run-id> --json` is the ONLY runnable queue. Do not recompute planning dependencies during RUN.

For implementation stages, dispatch only work-item IDs frozen in the v2 manifest. Resolve the exact frozen path+SHA-256 and pass that work item plus its `decision_ids/research_ids/contract_ids`, context files and `allowed_change_paths` to the worker. Never invent an ad-hoc work item during RUN. A missing/changed work item is BLOCKED/replan.

Before each stage:
1. Git scope verify;
2. `stage-cli start`;
3. GitHub sync;
4. execute;
5. record evidence;
6. `stage-cli complete|block|fail`;
7. sync again;
8. query `next`.

Pending GitHub outbox events must be zero before publish/PR handoff.

## Dispatch and machine gates

- Implementation / `technical_fix`: CoderAgent receives one exact frozen work item. After changes require Git verify. Worker agents never publish or transition state.
- Machine test/lint/typecheck/build/docs/runtime gates: call `gate-runner-cli.ts <run-id> <pipeline-id> <stage-id>` with the exact frozen stage ID. Only PASS evidence from this CLI completes the gate.
- Respect frozen package-manager contract. Never replace missing pnpm with npm/`npx --yes`; missing required tooling is environment BLOCKED.
- Review: fresh CodeReviewer with `technical_fix|replan|security_stop|scope_stop|secret_stop|destructive_stop|optional`.
- Docs: DocWriter only within frozen docs scope; project policy triggered docs gates must run.
- Publish: Git verify → deterministic publish → exact remote candidate SHA; never merge main.
- Runtime install/smoke: install the published GitHub candidate/artifact using frozen runtime gate commands and runtime lock where declared.

## technical_fix loops — maximum 3

For a failed qualitative/machine gate that is classified `technical_fix` and remains inside frozen scope:

1. diagnose from evidence;
2. apply one scoped fix using the same frozen work item identity;
3. Git verify;
4. rerun the failed gate;
5. rerun every downstream gate invalidated by the change.

Maximum **3 automatic technical_fix cycles per stage/work-item**. Record the cycle number in review/evidence. A fourth required fix is `blocked` and requires owner attention/replan. `replan`, security, secret, destructive or scope findings never consume/enter a technical-fix loop.

After a fix to an already published candidate: publish a NEW candidate SHA, reinstall that exact SHA and rerun affected runtime validation.

## Status semantics

- `ready`: functional/acceptance gates through frozen `ready_after_stage` passed.
- `release_ready`: release/build/runtime gates through `release_ready_after_stage` passed.
- `completed`: every frozen stage, including required documentation/finalization, is completed/skipped with evidence.

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

BLOCK on stale main/base, wrong worktree, changed planning evidence/source snapshot/project policy/work item, scope violation, unresolved owner decision, manifest/rules mismatch, missing/non-executable gate, package-manager/environment failure, secret/security/destructive condition, conflict that requires a DAG change, runtime failure needing design change, or a fourth technical-fix cycle.

If queue is empty, report the actual terminal state; never bypass prerequisites or rewrite frozen evidence. Include run/pipeline status, branch, source/candidate SHA, work-item IDs, machine evidence, runtime result, technical-fix cycle counts and blocker dossier. Never delete historical runs.
