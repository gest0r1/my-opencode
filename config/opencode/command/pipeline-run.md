---
description: Execute an approved design-freeze manifest inside the owner's selected worktree
tags:
  - pipeline
  - execution
  - unattended
  - github-handoff
---

Before creating or starting any PLAN/RUN, call `pipeline_runtime_preflight`. Require PASS from live tools, skills, exact subagent IDs and delegation permissions. `PIPELINE_CAPABILITY_UNAVAILABLE` stops execution with its concrete missing capability. Never implement inline or widen write permissions to bypass unavailable delegation.


# Pipeline Run — one owner-selected worktree

Execute only a frozen, owner-approved manifest in the CURRENT worktree-session. Never create/switch/rebase/merge/delete a worktree or branch; never create another user-facing OpenChamber session or dispatch PLAN elsewhere. Owner permits one RUN at a time across all worktrees.

```text
/pipeline-run <run-id> [--unattended] [--fix-cycles <5..20>] [--no-session-reuse]
/pipeline-run <run-id> github <handoff-id> [--unattended] [--fix-cycles <5..20>] [--no-session-reuse]
```

Options:
- `--unattended` — continue through already-approved bounded work without routine owner prompts; it never approves owner/security/destructive decisions.
- `--fix-cycles N` — explicit owner grant raising the per-stage automatic repair ceiling for this RUN to `N` (5..20). It is a ceiling override, not `+N`, and never lowers an already-higher stage budget.
- `--no-session-reuse` — force fresh implementation/test/build child sessions instead of eligible technical-fix session reuse.

Unknown modes/arguments BLOCK.

## Authority

`stage-cli` owns frozen manifest/rules/planning evidence, DAG, executor contracts, machine-owned runtime scope extensions, owner-acceptance state and transitions. `git-worktree-cli` owns identity/effective-scope/non-force publication. `gate-runner-cli` owns only stages explicitly frozen as `local_gate`. `github-actions-gate-cli` owns final exact-candidate GitHub CI evidence and the special GitHub-driven `github_dev` path, including required-job status and Environment evidence. `deployment-target-cli` owns GitHub→OpenCode-host reachability/authentication probes. Model output never overrides deterministic FAIL/BLOCKED or owner decisions. OpenStage is the only orchestrator; never delegate orchestration to BatchExecutor or another child.

## Preflight

1. `stage-cli validate <run-id> --json`, then `stage-cli run-preflight <run-id> --json`; require approved/in-progress state, schema v2 for canonical RUN, and matching frozen manifest/evidence/project-policy hashes. If the owner supplied `--fix-cycles N`, call `stage-cli fix-budget-set <run-id> --cycles N --json` now, before scheduling. Then call `stage-cli next <run-id> --json`. Rules are live external policy: `validate` reads the current rules file for both `project` and `opencode_default`, updates rules version/SHA metadata when they changed between pipeline commands, and continues. A changed rules hash/version is not a blocker; missing, unreadable, malformed rules or an invalid `edit_policy` are blockers. Schema v1 is audit/read-only: `run-preflight` returns `LEGACY_V1_REPLAN_REQUIRED`, so the old run must be replanned into a newly approved v2 manifest.
2. Invoke `stage-cli preflight <manifest.json> --environment` before dispatch. Preflight rechecks frozen planning evidence, work-items, conflict serialization, explicit executor coverage, GitHub gate/bootstrap contracts and package-manager contract for `local_gate` only.
   For GitHub Issue sourced runs, immediately after preflight invoke `github-issue-cli.ts check {run-id}`; a changed semantic requirements digest BLOCKS RUN and requires refresh/replan.
3. `git-worktree-cli freshness <manifest>`: fetch `origin/main`. If main moved after the last approved/effective base, BLOCK for owner `/pipeline-refresh`; that command now classifies drift as `NO_IMPACT`, `BOUNDED_IMPACT` or `STRUCTURAL_IMPACT`. A previously completed `NO_IMPACT` refresh is represented by machine-owned `git-runtime.json`, so freshness starts from its adopted `run_base_sha` rather than invalidating the unchanged manifest again. Merge conflicts are never agent-resolved scope expansion.
4. `git-worktree-cli adopt <manifest>`; then `verify <manifest>`.
5. Only when a pipeline selected `testing_strategy.mode=opencode_host`, call `deployment-target-cli.ts check <run-id> --policy <frozen-policy-path>` immediately before the stateful GitHub-driven deployment stage. It must still return `READY`; loss of readiness is BLOCKED, never an agent-repairable shell workaround. `hybrid` local CD does not use this probe.
6. Owner ensures no other RUN is active. Runtime locks remain secondary safety for external mutable targets.

## Scheduler and frozen work

`stage-cli next <run-id> --json` is the ONLY runnable queue. Do not recompute planning dependencies during RUN. A frozen dependency is satisfied when its upstream pipeline has completed through `ready_after_stage`; only pipelines without that milestone retain the legacy requirement `status=completed`. Therefore a late CI/CD/infrastructure blocker after source-ready does not freeze downstream source work. If runnable work remains, RUN stays active even when another pipeline is blocked/failed; report terminal BLOCKED/FAILED only when no active/runnable work remains.

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

## Compact dispatch and reuse

When calling `stage-cli fix-cycle`, include `--evidence <fresh-review-artifact>` for the repair that follows that review. The CLI freezes its hash and the scope preflight paths. The runtime uses this verified delta; absent evidence safely starts a fresh worker.

For each frozen agent/review work item, call `stage-cli dispatch <run-id> --pipeline <id> --stage <stage> --work-item <id> --role <registered-role> --json` after stage start. Pass its paths and the markers `<pipeline_work_item id="ID"/>` and `<pipeline_dispatch run="RUN" pipeline="PIPELINE" stage="STAGE"/>` to `subagent`. The runtime hook validates fresh machine state, automatically prepares baseline/repair identity and injects the dispatch packet. `pipeline_runtime_prepare` is optional compatibility tooling, not an LLM-dependent prerequisite. Never invent `sessionID`.

The worker reads authoritative paths itself. OpenStage reads compact state, blockers and evidence paths. `--no-session-reuse` disables resume in runtime; reviewer/planning sessions remain fresh. Export metrics with `reuse-report.mjs`; see `project/reuse-analysis.md` in the distribution README. Missing/unavailable child sessions fall back fresh before execution; worker failures retain normal repair semantics.

## Dispatch and machine gates

Dispatch strictly by the frozen `executors[stage_id]`; never infer executor from a stage name.

- `agent`: implementation / `technical_fix` work goes to the scoped worker for the exact frozen work item. Worker agents never publish or transition state.
- `review`: fresh CodeReviewer with `technical_fix|replan|security_stop|scope_stop|secret_stop|destructive_stop|optional`.
- `local_gate`: call `gate-runner-cli.ts <run-id> <pipeline-id> <stage-id>`. Use it for deterministic test/lint/typecheck/build/docs and install/runtime/smoke gates. Only its PASS evidence can satisfy the stage; `stage-cli complete` verifies the canonical evidence file. For the cost-aware deployable path, local fail-fast gates are frozen after `git_verify` and before `git_publish`; post-CI local CD gates consume the published `{candidate_sha}`.
- `git_verify`: after `stage-cli start`, use only `git-worktree-cli verify <manifest>`. It writes canonical `git-verify.json`; `stage-cli complete` rejects missing or pre-stage/stale verify evidence.
- `git_publish`: Git verify, then `git-worktree-cli publish <manifest>`. **This executor owns staging, candidate commit creation, non-force push and remote-SHA verification. Never ask the owner to run `git add`, `git commit` or `git push` during RUN.** `stage-cli complete` requires PASS `candidate.json` with `candidate_sha == remote_sha`.
- `github_ci`: `validate` then `run` for the frozen workflow/event/branch and exact published SHA; all `required_jobs[]` plus terminal job must be `completed/success`. Canonical v2 gates are artifactless: workflow run/attempt + exact `candidate_sha` + required-job evidence is the provenance contract, and `actions/upload-artifact`/`download-artifact` is incompatible with an artifactless gate. FAIL/BLOCKED always writes canonical identity/phase evidence. For terminal FAIL, `diagnose` writes compact job metadata plus redacted multiline per-job `.log` files; use `log ... --job|--job-id` for one exact-run job. Deterministic diagnostics own CI log access; ask the owner only on explicit auth/permission blockers.
- `github_dev`: retained for the special `testing_strategy.mode=opencode_host` path only. Call deterministic `validate` then `run`; the stateful trusted workflow receives the exact `candidate_sha`, exact successful source-CI `workflow_run_id`, `pipeline_run_id` and optional `target_id`, then installs/checks out that SHA and validates the target. `disposable` legacy gates remain supported when already frozen, but ordinary `hybrid` CD does **not** use `github_dev`; it uses `local_gate` after final GitHub CI.
- Source documentation is changed by DocWriter only when represented by a frozen `agent` work item/scope and must complete before `git_publish`. Deterministic docs checks, if any, are explicit `local_gate` or `github_ci` stages. Post-publish finalization may update pipeline/PR metadata only; any repository source change after publication requires a new candidate SHA and rerun of affected GitHub/runtime gates.

- `owner_acceptance`: manual owner test gate used only when the frozen testing strategy says `post_deploy_test=user|automated_then_user`. Generic `stage-cli complete` is forbidden. Stop RUN after successful local CD and report the exact deployed candidate SHA/source-CI run and what the owner should verify. Only after an explicit owner response for that current stage call `stage-cli owner-accept <run-id> <stage> --pipeline <id> --result pass|fail [--message <text>]`. A PASS resumes scheduling. FAIL records a resumable owner changes-requested checkpoint; it MUST NOT make the RUN terminal before the feedback is classified.

Owner feedback that changes or clarifies local requirements/acceptance/UI/behavior may use an append-only `owner_amendment` inside the same RUN only when an existing frozen work item still owns the change. The amendment may extend bounded source paths and may change local requirements/AC, but it may not create a new work item. A new file/component/refactor does not itself mean a new work item; a new independently scoped responsibility/deliverable does. If a new work item is required, use full replan. Keep the original manifest immutable; the effective RUN contract is frozen manifest + approved owner amendments. After fresh bounded impact analysis, apply it with `stage-cli owner-amend-apply <run-id> <owner-stage> --pipeline <id> --evidence <owner-amendment.json>`. Reopen only the affected implementation-to-acceptance chain and invalidate stale candidate/CI/deploy evidence.

### Testing strategy execution

The owner-selected manifest strategy is binding:

- `github`: run the frozen local fail-fast gates, publish the exact candidate, then complete the final artifactless GitHub CI. Do not deploy to the OpenCode host.
- `opencode_host`: run local fail-fast, publish, complete final GitHub CI, re-probe the target, then dispatch the existing trusted stateful `github_dev` workflow for remote CD. Owner acceptance is optional according to `post_deploy_test`.
- `hybrid`: run local fail-fast, publish, complete final GitHub CI, then execute the frozen post-CI `local_gate` install/update/smoke against the exact `candidate_sha`. No GitHub→host probe or stateful GitHub CD is involved. Owner acceptance is optional according to `post_deploy_test`.

Never silently replace the final GitHub CI with local-only delivery validation. For `opencode_host`, loss of target readiness BLOCKS. For `hybrid`, a local deployment/runtime failure is handled as the normal deterministic local gate failure.

### Missing or incompatible project workflow

A frozen GitHub gate marked `bootstrap_required` means RUN must implement the mapped CI/bootstrap work item in the TARGET PROJECT before candidate publication. After that source change:

1. Git scope verify;
2. `github-actions-gate-cli validate <run-id> <pipeline-id> <github-stage>`;
3. if validation is not PASS, repair only inside the same frozen work item/scope using the normal technical-fix counter;
4. continue the frozen DAG through every local fail-fast gate between `git_verify` and `git_publish`;
5. only after those local gates PASS, publish the candidate branch;
6. for first-time workflows use the frozen `push` trigger and wait for that exact candidate SHA.

If CI is missing/incompatible, implement its frozen bootstrap/adaptation work item and validate it before publish. If stateful DEV is missing for an explicitly selected `opencode_host` strategy, implement its frozen `future_github_gates` work item as source only and run `github-actions-gate-cli validate-future <run-id> <pipeline-id> <gate-name>` before publication; do **not** add a current-run `github_dev` stage for it. After owner merge makes that workflow trusted, a later PLAN can activate the remote-CD path. Ordinary `hybrid` does not need this bootstrap because its CD stage is local.

Never replace a missing, incompatible or failed **final** GitHub CI workflow with local-only validation. Local npm/pnpm/pytest/build gates are expected before publication, but final independent exact-SHA CI must still pass. If the frozen bootstrap/adaptation scope cannot produce a valid final CI workflow, BLOCK/replan.

Respect the repository package-manager contract for `local_gate`. Missing local tooling is environment BLOCKED; it does not authorize changing package managers.

## Automatic repair loops — initial budget 5

A repair cycle is one source-changing attempt that reaches its next authoritative review/gate result. The shared budget applies to both `technical_fix` and bounded `security_fix`. **Scope discovery/authorization happens before the cycle counter is consumed.** If the frozen DAG contains executor=`review`, that stage runs a fresh CodeReviewer. A cycle already started may finish through that review/gate even when its counter becomes `N/N`.

For `technical_fix`:

1. diagnose from canonical evidence; for GitHub failures use `github-actions-gate-cli diagnose` before asking the owner for anything;
2. identify exact repository paths before source mutation;
3. call `stage-cli scope-check <run-id> <stage> <path>... --pipeline <id> --json`;
4. when it returns `TECHNICAL_SCOPE_REVIEW_REQUIRED`, run fresh ArchitectureAnalyzer + SeniorTechnicalPlanReviewer and use `stage-cli scope-extend ... --class technical --evidence <review.json>` only when that evidence proves a decision-free bounded clarification;
5. Only after scope preflight PASS call `stage-cli fix-cycle <run-id> <stage> --pipeline <id>`.

For a CodeReviewer finding classified `security_fix`, do **not** stop merely because severity is Critical/High. Autonomous security repair is allowed only when the frozen contract already determines the safe remediation. CodeReviewer must write machine-readable evidence proving all of:

- `bounded_remediation=true`;
- `owner_decision_required=false`;
- requirements/AC/external contracts/security boundary unchanged;
- `privilege_expansion=false`;
- `secret_exposure=false`;
- `destructive_change=false`;
- exact paths and at least one frozen AC/contract/security rule in `policy_basis`.

Then run, in order:

```text
stage-cli security-fix-check <run-id> <stage> --pipeline <id> --evidence <security-review.json>
stage-cli scope-check <run-id> <stage> <path>... --pipeline <id> --json
stage-cli fix-cycle <run-id> <stage> --pipeline <id> --repair-class security_fix
```

`security-fix-check` is deterministic and fail-closed. It rejects the automatic path when an owner decision, privilege expansion, secret exposure, destructive remediation or PLAN/security-boundary change is present. A security authorization cannot be consumed by a normal `technical_fix` cycle and its exact paths must match the scope preflight.

If `git-worktree-cli verify` discovers an additional path after a cycle already started, resolve it through the same scope-check/review flow inside the **same** cycle and continue that cycle. A real protected/sensitive/owner/replan requirement stops the RUN.

For a source-changing fix after `git_publish`, `fix-cycle` reopens the chain from the preceding `git_verify` through local fail-fast, publish, final CI and affected CD/runtime stages. Evidence for the previous candidate becomes stale.

The default automatic budget is **5 cycles per stage/work-item**. On RUN start the owner may pre-authorize a higher ceiling with `--fix-cycles N` (maximum 20); OpenStage maps it to:

```text
stage-cli fix-budget-set <run-id> --cycles N
```

This operation is audited in stage state as `source=run_override`, applies across the RUN, and only raises limits. During RUN the owner can still grant `+N` to one active stage with:

```text
stage-cli fix-budget-add <run-id> <stage> --pipeline <id> --cycles N
```

Budget exhaustion is checked only when a review/gate result requires the **next** source-changing repair. Never interrupt an already-started `N/N` cycle before its frozen review/gates finish.

At a budget checkpoint the owner has three choices:

1. **Continue current approach:** explicit `+N` → `fix-budget-add`.
2. **Runtime replan this block:** only on explicit owner intent; fresh ArchitectureAnalyzer + SeniorTechnicalPlanReviewer, `stage-cli runtime-replan-propose`, mandatory owner clarification/approval, then `stage-cli runtime-replan-approve --cycles N`.
3. **Full replan:** when owner feedback needs a new independently scoped work item, changes the business intent, an external contract, security/trust boundary, destructive/migration semantics, or otherwise requires a structural PLAN-level decision. A bounded owner clarification may change local requirements or acceptance criteria through `owner_amendment` only while the same frozen work item continues to own it.

A pending runtime replan cannot be bypassed with `fix-budget-add`. `--unattended` never supplies runtime-replan approval.

### Security stop taxonomy

Use owner stops only where owner judgement/action is actually required:

- `security_fix` — bounded fail-closed/least-privilege correction determined by frozen policy; automatic and budgeted.
- `security_stop` — owner must decide security policy, trust, role/access semantics, or remediation cannot satisfy the bounded security-fix contract.
- `secret_stop` — actual secret/credential exposure or rotation/revocation is required.
- `destructive_stop` — remediation is irreversible/destructive (for example production-data deletion, global session invalidation, key rotation with destructive effects).
- `scope_stop` — repair needs protected/sensitive/non-authorizable scope.
- `replan` — a new independently scoped work item, business-intent change, external contract, security/trust boundary, destructive/migration semantics or another structural PLAN decision is required. Local owner-approved requirements/AC clarification inside an existing frozen work item is `owner_amendment`, not `replan`.

For `security_stop | secret_stop | destructive_stop | scope_stop | replan`, use `stage-cli block` and report a resumable BLOCKED owner checkpoint. Do **not** mark the RUN terminal `failed` merely because a security finding exists. These stops consume no fix cycle.

When an owner security decision is genuinely required, do not ask the owner to design the security mechanism. Present: (1) what resource/action is being protected in plain language, (2) what the frozen policy cannot decide, (3) the safest fail-closed default, (4) concrete owner choices and consequences, and (5) a recommendation. Ask only for the policy/business choice; implementation details remain the pipeline's responsibility.

Do not make CI green by excluding/suppressing a failing tracked test merely because fixing it needs a runtime scope extension. Test removal/exclusion requires evidence that the test no longer represents approved requirements, not convenience.

After any source-changing fix to an already published candidate: Git verify, rerun the frozen local fail-fast gates, publish a NEW candidate SHA, then rerun every affected final `github_ci`, CD/runtime and acceptance gate. Evidence from the previous candidate is stale by construction and `stage-cli complete` must reject it.

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

Issue audit comments are append-only **per distinct pipeline lifecycle event**. A transition such as `planned -> approved` and a later `approved -> in_progress` are different outbox events and are posted as separate comments. Sync idempotency only prevents reposting the same event marker; it does not PATCH or coalesce earlier comments. If the same Issue is mapped to multiple pipelines, each pipeline can emit its own comments for the same run.

After every frozen stage is completed and `git-worktree-cli publish` produced PASS `candidate.json`, create/update the one delivery PR only through:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-pr-cli.ts create <run-id>
```

The deterministic PR boundary verifies frozen repository, completed Issue mapping, non-default candidate branch, `candidate_sha == remote_sha`, and that every deployable pipeline's frozen `deployment_validation.stage` has PASS evidence for that **same final cumulative candidate SHA**; it writes close keywords for completed Issues and requires PR-link outbox `pending=0`. Never use free-form `gh pr create`, `gh api` or merge commands. Owner merges manually.

## Owner shell actions

Use the deterministic CLI that owns the operation. Owner shell intervention is allowed only on explicit `OWNER_ACTION_REQUIRED`, auth or permission blockers; model/tool-format inconvenience is not an owner task.

## Owner approval and unattended

`--unattended` skips interaction only inside the already-approved frozen scope. It does not approve decisions, changed scope/base/manifest/evidence, exceptions or merge. It also never auto-approves a runtime replan: `awaiting_owner_clarification` and `awaiting_owner_approval` are mandatory owner checkpoints.

Reuse child sessions only for CoderAgent/TestEngineer/BuildAgent automatic repair cycles (`technical_fix` or bounded `security_fix`) with exact:

```text
{run_id,pipeline_id,stage,role,work_item_id}
```

Planning/reviews are always fresh. Invalid reuse starts a fresh child, never another worktree session.

## GitHub handoff mode

`github_handoff_prepare` / `github_handoff_status` verify immutable source/worktree and generated validation. Approved automatic repair loops use the RUN/stage budget (default **5 cycles**, optionally raised by explicit owner `--fix-cycles N`). `github_handoff_publish` publishes only a validated outcome. No implicit Git setup, force push or ref change.

## Stops

BLOCK on stale main/base, wrong worktree, changed planning evidence/project policy/work item, failed GitHub→OpenCode-host CD readiness recheck, unresolved owner decision, changed manifest, invalid/unreadable rules, protected/sensitive runtime-scope request, owner amendment that requires a new work item, runtime-scope review that changes business intent/external contracts/security boundaries/destructive behavior outside an approved bounded owner amendment, GitHub gate without a valid frozen contract, missing workflow without its frozen bootstrap/adaptation work item, GitHub Environment/trusted-ref/concurrency mismatch, required GitHub job skipped/failed/missing, missing or mismatched artifact ID/digest, GitHub run/evidence from the wrong SHA/workflow/job/artifact, local-gate package-manager/environment failure, a true `security_stop`/`secret_stop`/`destructive_stop`/protected `scope_stop`, conflict that requires a DAG change, runtime failure needing design change, or an exhausted automatic-repair budget awaiting an owner choice.

If queue is empty, report the actual terminal state; never bypass prerequisites or rewrite frozen evidence. A late external GitHub/CD blocker after an upstream source-ready milestone is not a reason to stop while `stage-cli next` still exposes downstream/independent work. Include run/pipeline status, branch, source/candidate SHA, work-item IDs, machine evidence, runtime result, technical-fix cycle counts and blocker dossier. Never delete historical runs.
