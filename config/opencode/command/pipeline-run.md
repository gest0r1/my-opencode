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

`stage-cli` owns frozen manifest/rules/planning evidence, DAG, executor contracts, machine-owned runtime scope extensions, owner-acceptance state and transitions. `git-worktree-cli` owns identity/effective-scope/non-force publication. `gate-runner-cli` owns only stages explicitly frozen as `local_gate`. `github-actions-gate-cli` owns authoritative GitHub Actions CI/DEV validation, exact-candidate run selection, required-job status, artifact digest and Environment evidence. `deployment-target-cli` owns GitHub→OpenCode-host reachability/authentication probes. Model output never overrides deterministic FAIL/BLOCKED or owner decisions. OpenStage is the only orchestrator; never delegate orchestration to BatchExecutor or another child.

## Preflight

1. `stage-cli validate <run-id> --json`, then `stage-cli run-preflight <run-id> --json`, then `stage-cli next <run-id> --json`; require approved/in-progress state, schema v2 for canonical RUN, and matching frozen manifest/evidence/project-policy hashes. Rules are live external policy: `validate` reads the current rules file for both `project` and `opencode_default`, updates rules version/SHA metadata when they changed between pipeline commands, and continues. A changed rules hash/version is not a blocker; missing, unreadable, malformed rules or an invalid `edit_policy` are blockers. Schema v1 is audit/read-only: `run-preflight` returns `LEGACY_V1_REPLAN_REQUIRED`, so the old run must be replanned into a newly approved v2 manifest.
2. Invoke `stage-cli preflight <manifest.json> --environment` before dispatch. Schema v2 rechecks planning evidence, source snapshot, work-items, conflict serialization, explicit executor coverage, GitHub gate/bootstrap contracts and package-manager contract for `local_gate` only.
3. `git-worktree-cli freshness <manifest>`: fetch `origin/main`. Relevant drift in allowed/freshness/global dependency/pipeline config is `STALE_PLAN` → BLOCK for `/pipeline-refresh` + new approval. Unrelated drift may be deterministically merged and recorded as effective run base. Merge conflicts are never agent-resolved scope expansion.
4. `git-worktree-cli adopt <manifest>`; then `verify <manifest>`.
5. If any pipeline selected `testing_strategy.mode=opencode_host|hybrid`, call `deployment-target-cli.ts check <run-id> --policy <frozen-policy-path>` immediately before the stateful deployment stage. It must still return `READY`; GitHub must still be able to execute the trusted probe against the OpenCode host with the frozen Environment/secret-name/trusted-ref contract. Loss of readiness is BLOCKED, never an agent-repairable shell workaround.
6. Owner ensures no other RUN is active. Runtime locks remain secondary safety for external mutable targets.

## Scheduler and frozen work

`stage-cli next <run-id> --json` is the ONLY runnable queue. Do not recompute planning dependencies during RUN.

For implementation stages, dispatch only work-item IDs frozen in the v2 manifest. Resolve the exact frozen path+SHA-256 and pass that work item plus its `decision_ids/research_ids/contract_ids`, context files and the current effective scope (`manifest.allowed_change_paths` + machine-owned runtime extensions) to the worker. Never invent an ad-hoc work item during RUN. A missing/changed work item is BLOCKED/replan.

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
- `git_publish`: Git verify, then `git-worktree-cli publish <manifest>`. **This executor owns staging, candidate commit creation, non-force push and remote-SHA verification. Never ask the owner to run `git add`, `git commit` or `git push` during RUN.** `stage-cli complete` requires PASS `candidate.json` with `candidate_sha == remote_sha`.
- `github_ci`: `validate` then `run` for the frozen workflow/event/branch and exact published SHA; all `required_jobs[]` plus terminal job must be `completed/success`, and required artifacts need GitHub `sha256:` digests. FAIL/BLOCKED always writes canonical identity/phase evidence. For terminal FAIL, `diagnose` writes compact job metadata plus redacted multiline per-job `.log` files; use `log ... --job|--job-id` for one exact-run job. Deterministic diagnostics own CI log access; ask the owner only on explicit auth/permission blockers. `stage-cli complete` independently verifies SHA/artifact ID/digest evidence.
- `github_dev`: call deterministic `validate` then `run`. For `testing_strategy.mode=opencode_host|hybrid`, this stateful gate is the GitHub-initiated installation on the machine where OpenCode runs; it consumes the exact source-CI artifact ID and digest, uses the frozen protected Environment/trusted ref/concurrency group, and returns installed-SHA evidence. For `opencode_host`, fresh+upgrade validation jobs run in this stage. For `hybrid`, the GitHub validation stage must have passed first. Both modes consume the exact artifact ID **and `artifact_digest`** from the PASS `source_ci_stage`, pass run ID/artifact ID/digest to the workflow, and require returned DEV evidence with the same tuple, matching `target_id` for OpenCode-host CD, and `installed_sha == candidate_sha`. `disposable` dispatches an existing secret-free workflow on the candidate ref. `stateful` dispatches an existing workflow from frozen `trusted_ref`, verifies the GitHub Environment/branch policy, and requires the frozen non-cancelling `concurrency_group`. A stateful workflow listed only in `future_github_gates` is source authored in this run but is not runnable now; after merge a later PLAN may activate it. For deployable pipelines, fresh-install and upgrade/repeat-install required jobs must both pass before delivery.
- Source documentation is changed by DocWriter only when represented by a frozen `agent` work item/scope and must complete before `git_publish`. Deterministic docs checks, if any, are explicit `local_gate` or `github_ci` stages. Post-publish finalization may update pipeline/PR metadata only; any repository source change after publication requires a new candidate SHA and rerun of affected GitHub/runtime gates.

- `owner_acceptance`: manual owner test gate used only when the frozen local strategy says `post_deploy_test=user|automated_then_user`. Generic `stage-cli complete` is forbidden. Stop RUN after successful local CD and report what was deployed, candidate SHA/artifact digest and what the owner should verify. Only after an explicit owner response for that current stage call `stage-cli owner-accept <run-id> <stage> --pipeline <id> --result pass|fail [--message <text>]`. A PASS resumes scheduling; FAIL marks the stage failed and does not consume a technical-fix cycle until the failure is classified.

### Testing strategy execution

The owner-selected manifest strategy is binding:

- `github`: complete GitHub CI/disposable deployment validation only. Do not deploy to the OpenCode host.
- `opencode_host`: after authoritative CI/build artifact exists, re-probe the target and dispatch trusted stateful GitHub CD to the OpenCode host. Fresh+upgrade/repeat validation belongs to that stateful gate. Then run automated local smoke, owner acceptance, or both according to `post_deploy_test`.
- `hybrid`: first complete all frozen GitHub-side automated validation, then re-probe and deploy the exact same artifact ID/digest to the OpenCode host through trusted stateful GitHub CD, then stop for owner acceptance (optionally after automated local smoke).

Never silently downgrade from local/hybrid to GitHub-only if the target becomes unavailable. BLOCK and report the readiness failure.

### Missing or incompatible project workflow

A frozen GitHub gate marked `bootstrap_required` means RUN must implement the mapped CI/bootstrap work item in the TARGET PROJECT before candidate publication. After that source change:

1. Git scope verify;
2. `github-actions-gate-cli validate <run-id> <pipeline-id> <github-stage>`;
3. if validation is not PASS, repair only inside the same frozen work item/scope using the normal technical-fix counter;
4. publish the candidate branch;
5. for first-time workflows use the frozen `push` trigger and wait for that exact candidate SHA.

If CI is missing/incompatible, implement its frozen bootstrap/adaptation work item and validate it before publish. If stateful DEV is missing, implement its frozen `future_github_gates` work item as source only and run `github-actions-gate-cli validate-future <run-id> <pipeline-id> <gate-name>` before publication; do **not** add a current-run `github_dev` stage for it. When the project policy's OpenCode-host probe workflow is also being introduced, include it in the same frozen future-CD work item and review it as non-mutating readiness automation, but do not execute it from the candidate. The current candidate must instead complete frozen fresh+upgrade validation in unprivileged CI. After owner merge makes those workflows trusted, a later PLAN can execute the GitHub→OpenCode-host probe and promote the trusted DEV workflow to active `github_dev`.

Never replace a missing, incompatible or failed authoritative GitHub workflow with local npm/pnpm/pytest/build commands. If the frozen bootstrap/adaptation scope cannot produce a valid workflow, BLOCK/replan.

Respect the repository package-manager contract for `local_gate`. Missing local tooling is environment BLOCKED; it does not authorize changing package managers.

## technical_fix loops — initial budget 3

A technical-fix cycle is one source-changing repair attempt that reaches its next authoritative review/gate result. **Scope discovery/authorization happens before the cycle counter is consumed.** If the frozen DAG contains a stage with executor=`review`, that stage runs a fresh CodeReviewer; the stage name is manifest-defined (typically the post-implementation review stage), not hard-coded. A cycle that has already started is allowed to reach that CodeReviewer/review result even when its counter becomes `N/N`.

For a failed qualitative/machine gate classified `technical_fix`:

1. diagnose from canonical evidence; for GitHub failures use `github-actions-gate-cli diagnose` before asking the owner for anything;
2. identify the concrete repository paths the repair is expected to touch. Use read-only analysis/review if needed; do not mutate source yet;
3. call `stage-cli scope-check <run-id> <stage> <path>... --pipeline <id> --json`:
   - paths already in manifest/effective scope PASS;
   - concrete test/fixture/mock/snapshot paths under an already-approved `apps/<name>` or `packages/<name>` component are added automatically as machine-owned `test` runtime scope extensions;
   - an additional ordinary source/config path returns `TECHNICAL_SCOPE_REVIEW_REQUIRED` without consuming a fix cycle;
   - protected/sensitive/trust-boundary paths return `OWNER_OR_REPLAN_REQUIRED`.
4. On `TECHNICAL_SCOPE_REVIEW_REQUIRED`, run a **fresh** ArchitectureAnalyzer in runtime-scope-clarification mode, then a fresh SeniorTechnicalPlanReviewer. The reviewer writes a machine-readable `.tmp/pipelines/<run-id>/runtime-scope-review-<n>.json`. If it proves `owner_decision_required=false`, no requirements/acceptance/external-contract/security-boundary/destructive change, call:
   `stage-cli scope-extend <run-id> <stage> <path>... --class technical --evidence <review.json> --pipeline <id>`.
   This extends only machine-owned effective scope; **never edit the frozen manifest or its hash**.
5. Only after scope preflight PASS call `stage-cli fix-cycle <run-id> <stage> --pipeline <id>`. `fix-cycle` rejects calls without the matching scope preflight and increments the counter only now.
6. if a `git_publish` stage had already completed before the failed stage, `fix-cycle` deterministically reopens the chain from the preceding `git_verify` through publish/CI/DEV; do not call `resume` on the old failed gate or manually preserve its completed downstream state;
7. apply one repair using the same frozen work-item identity and effective scope;
8. query `stage-cli next`; for a post-publish fix the next stage must be the reopened `git_verify`, followed by normal `git_publish` and affected GitHub gates;
9. for a pre-publish fix, rerun the failed gate and every downstream gate invalidated by the change.

If `git-worktree-cli verify` discovers an additional path **after** a cycle has already started, do not create another cycle and do not edit manifest/state manually. Run `scope-check` for that concrete offending path; auto-authorize a valid test path or complete the bounded technical-scope review, then rerun verify inside the **same** cycle. A real owner/replan requirement stops the RUN.

The initial automatic budget is **3 technical_fix cycles per stage/work-item**. A cycle is consumed only after scope preflight succeeds. The owner may increase the budget or request/approve a runtime replan at any point while the stage is active. Budget exhaustion is checked only when a review/gate result requires starting the **next** source-changing repair. Never interrupt an already-started `N/N` cycle before its frozen review/gates finish. If CodeReviewer (executor=`review`) or another authoritative gate then returns a new `technical_fix` and no budget remains, stop before the next `fix-cycle` and return a budget checkpoint; do not require a full PLAN merely because the counter was exhausted.

At the checkpoint the owner has three distinct choices:

1. **Continue current approach:** an explicit owner grant such as "ещё 3 цикла" maps to:
   `stage-cli fix-budget-add <run-id> <stage> --pipeline <id> --cycles 3`.
   The command records an audited owner grant immediately; it does not wait for exhaustion. Then continue the same RUN/work-item.
2. **Runtime replan this block:** this may be requested before or after budget exhaustion, but RUN starts it **only on explicit owner intent** (for example "runtime replan", "повторное архитектурное ревью", or equivalent). At an exhaustion checkpoint, RUN may offer runtime replan as an option, but must not dispatch ArchitectureAnalyzer merely because the budget ended. After explicit owner intent, run fresh ArchitectureAnalyzer in runtime-replan mode and fresh SeniorTechnicalPlanReviewer. This is local to the current pipeline/stage/work-item and does not rewrite the frozen manifest or restart the whole PLAN. The reviewer writes a versioned `.tmp/pipelines/<run-id>/runtime-replan-<pipeline>-<stage>-<n>.json`.
   - If owner clarification is needed, record it through `stage-cli runtime-replan-propose ... --evidence <review.json>`; return the questions to the owner and stop. Owner answers may trigger another fresh architecture/review revision.
   - When the local replan is `ready_for_owner_approval`, record the proposal through the same command and **stop for explicit owner approval even under `--unattended`**.
   - Only an explicit owner approval plus cycle grant maps to `stage-cli runtime-replan-approve <run-id> <stage> --pipeline <id> --cycles <N>`. Approval records the exact reviewed evidence and increases the fix budget; it never starts a repair by itself. Run fresh `scope-check` and then `fix-cycle`.
3. **Full replan:** use the existing reason-coded replan/supersede path only when the local review finds changed requirements, acceptance criteria, external contracts, security/trust boundaries, destructive behavior or another real PLAN-level decision.

A pending runtime replan cannot be bypassed with `fix-budget-add`. Direct cycle grants and approved runtime-replan grants are separate audited budget events. If no runtime replan is pending and the owner says only `+N`/additional fix cycles, map that directly to `fix-budget-add`; do not add architecture review implicitly. Security, secret, destructive and unresolved owner-decision findings never enter a technical-fix loop.

Do not make CI green by excluding/suppressing a failing tracked test merely because fixing it needs a runtime scope extension. Test removal/exclusion requires evidence that the test no longer represents approved requirements, not convenience.

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

## Owner shell actions

Use the deterministic CLI that owns the operation. Owner shell intervention is allowed only on explicit `OWNER_ACTION_REQUIRED`, auth or permission blockers; model/tool-format inconvenience is not an owner task.

## Owner approval and unattended

`--unattended` skips interaction only inside the already-approved frozen scope. It does not approve decisions, changed scope/base/manifest/evidence, exceptions or merge. It also never auto-approves a runtime replan: `awaiting_owner_clarification` and `awaiting_owner_approval` are mandatory owner checkpoints.

Reuse child sessions only for CoderAgent/TestEngineer/BuildAgent technical-fix cycles with exact:

```text
{run_id,pipeline_id,stage,role,work_item_id}
```

Planning/reviews are always fresh. Invalid reuse starts a fresh child, never another worktree session.

## GitHub handoff mode

`github_handoff_prepare` / `github_handoff_status` verify immutable source/worktree and generated validation. Approved technical fixes use at most **3 cycles**. `github_handoff_publish` publishes only a validated outcome. No implicit Git setup, force push or ref change.

## Stops

BLOCK on stale main/base, wrong worktree, changed planning evidence/source snapshot/project policy/work item, failed GitHub→OpenCode-host CD readiness recheck, unresolved owner decision, changed manifest, invalid/unreadable rules, protected/sensitive runtime-scope request, runtime-scope review that changes requirements/acceptance/external contracts/security boundaries/destructive behavior, GitHub gate without a valid frozen contract, missing workflow without its frozen bootstrap/adaptation work item, GitHub Environment/trusted-ref/concurrency mismatch, required GitHub job skipped/failed/missing, missing or mismatched artifact ID/digest, GitHub run/evidence from the wrong SHA/workflow/job/artifact, local-gate package-manager/environment failure, secret/security/destructive condition, conflict that requires a DAG change, runtime failure needing design change, or an exhausted technical-fix budget awaiting an owner choice.

If queue is empty, report the actual terminal state; never bypass prerequisites or rewrite frozen evidence. Include run/pipeline status, branch, source/candidate SHA, work-item IDs, machine evidence, runtime result, technical-fix cycle counts and blocker dossier. Never delete historical runs.
