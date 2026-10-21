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
- `--unattended` — continue through already-approved bounded work without routine owner prompts (see "Owner approval and unattended"); it never approves owner/security/destructive decisions.
- `--fix-cycles N` — explicit owner grant raising the per-stage automatic repair ceiling for this RUN to `N` (5..20). It is a ceiling override, not `+N`, and never lowers an already-higher stage budget.
- `--no-session-reuse` — force fresh implementation/test/build child sessions instead of eligible continuation/automatic-repair session reuse.

Unknown modes/arguments BLOCK.

## Authority

`stage-cli` owns frozen manifest/rules/planning evidence, DAG, executor contracts, machine-owned runtime scope extensions, owner-acceptance state and negative transitions. `stage-complete-cli` is the mandatory boundary for every ordinary successful stage completion: it first verifies any bound Coder advisory evidence for the exact dispatch/work-item scope and then delegates to the existing `stage-cli complete` evidence checks. `git-worktree-cli` owns identity/effective-scope/non-force publication. `gate-runner-cli` owns frozen local gates and advisory checks. `github-actions-gate-cli` owns final exact-candidate GitHub CI evidence and the special GitHub-driven `github_dev` path, including required-job status and Environment evidence. `deployment-target-cli` owns GitHub→OpenCode-host reachability/authentication probes. Model output never overrides deterministic FAIL/BLOCKED or owner decisions. OpenStage is the only orchestrator; never delegate orchestration to BatchExecutor or another child.

## Preflight and owner clarifications

1. Determine actual active stages. If none are executing and checkout is clean, `pipeline-replan-cli.ts preflight <run-id>` followed by trusted `worktree-refresh.sh` synchronizes main with a verified snapshot of `.tmp/pipelines`. `/pipeline-run` authorizes this deterministic synchronization. Dirty checkout or merge conflict BLOCKS; never stash/reset/rebase or repair conflicts outside PLAN.
2. `pipeline-reconcile-cli.ts apply <run-id>` is the common Issue/main compatibility check. Unchanged source and main outside `planning_scope` use a cheap deterministic PASS. Hash mismatch is only a detector: inspect exact diff/live requirements against approved stories/AC/architecture/contracts plus accepted amendments. `REVIEW_REQUIRED` does not mean full replan. Persist fresh review in this run and call `apply --evidence <path>`; review binds `input_sha256`, `result: COMPATIBLE|PLAN_INVALID`, reason, and for compatibility explicit false values for `business_intent_changed`, `architecture_invalid`, `external_contract_changed`, `security_boundary_changed`, `destructive_change`, `owner_decision_required`, `implementation_change_required`.
3. If compatible clarification needs implementation changes, first amend effective work: before implementation use `/pipeline-plan --revise <same-run-id>`; after implementation use owner amendment with exact paths and optional hash-bound runtime work units. Then reconcile against the effective contract. Accepted reconciliation appends evidence and adopts source digest/base; no manifest rewrite or repeated owner approval.
4. `PLAN_INVALID` before implementation means revise the same folder and invalidate only affected gates. Changes in owner-approved behavior/scope/constraints require renewed approval; technical corrections retain it. After implementation actually started, incompatible replan uses a new folder with CLI inherited context, leaving old run intact.
5. `stage-cli validate <run-id> --json`, then `stage-cli run-preflight <run-id> --json`, `prepare-environment <manifest>` (exact user-local package manager from packageManager), `preflight <manifest> --environment`, `git-worktree-cli adopt` and `verify` must PASS before dispatch. For Issue runs `github-issue-cli check <run-id>` uses the accepted effective source digest. Schema v1 is audit/read-only: `LEGACY_V1_REPLAN_REQUIRED` requires a v2 PLAN. Rules are live external policy: a changed rules hash/version is not a blocker; missing/unreadable/malformed rules BLOCK. deployment target recheck is required only for `opencode_host`. Owner ensures only one RUN executes across worktrees. Apply an explicit `--fix-cycles N` override before scheduling.
6. Base probe, once per RUN before the first source-agent start (skip when implementation already started): for every pipeline whose profile has a non-runtime `local_gate` test/fail-fast gate, run `gate-runner-cli.ts <run-id> <pipeline-id> <gate> --advisory --base-probe` through GateRunner on the clean adopted checkout. It executes the complete frozen command set and writes `checks/<pipeline>-<gate>-base-probe.json`. A PASS plan probe (PLAN, `planning/probes/<pipeline>-<gate>.json`) for the same profile/gate at the current clean HEAD with equal `commands_sha256` satisfies this requirement without a rerun; a FAIL plan probe counts like a FAIL base probe. PASS → dispatch. FAIL means that gate is already red on the untouched base: because implementation has not started, revise this PLAN in place (`/pipeline-plan --revise <same-run-id>`) so a first baseline-repair work item (`"baseline_repair": true`) owns the failing suites (technical correction, approval retained), or stop at an owner checkpoint when the repair would change approved behavior/contracts. Never let an unrelated work item absorb a pre-existing red suite. BLOCKED is an environment blocker, not a red base. `stage-cli dispatch` enforces the probe per frozen profile (pipelines sharing a profile need a single probe): no probe on a clean base → `BASE_PROBE_REQUIRED`; a FAIL probe → `BASE_RED_REPAIR_REQUIRED` until the plan holds a `baseline_repair` work item on that profile; once the checkout has already moved past the base, a missing probe is recorded in the dispatch baseline instead of blocking.

Owner may provide clarification at any moment in the current session, including between stages and after acceptance FAIL. Stop source workers before applying it. Before implementation starts, revise this PLAN in place; after it starts, compatible feedback uses amendments. Starting RUN/preflight/review is not the implementation freeze boundary.

## Scheduler and frozen work

`stage-cli next <run-id> --json` is the ONLY runnable queue. Do not recompute planning dependencies during RUN. A frozen dependency is satisfied when its upstream pipeline has completed through `ready_after_stage`; only pipelines without that milestone retain the legacy requirement `status=completed`. Therefore a late CI/CD/infrastructure blocker after source-ready does not freeze downstream source work. The `test_preparation` lane (frozen `test_rework[]` items: update/split/rewrite/add/move_setup/remove of tests the run would break or overload) runs first because every source lane depends on it; dispatch it before anything else and never raise a test time limit instead of reworking the test. If runnable work remains, RUN stays active even when another pipeline is blocked/failed; report terminal BLOCKED/FAILED only when no active/runnable work remains.

For implementation stages, dispatch work-item IDs frozen in the v2 manifest or hash-bound runtime units in accepted owner amendments. Resolve the exact frozen path+SHA-256 and pass that work item plus its `decision_ids/research_ids/contract_ids`, context files and the current effective scope (`manifest.allowed_change_paths` + machine-owned runtime extensions) to the worker. Never dispatch an unapproved/unhashed ad-hoc work item. New PLAN work items freeze their agent stage and narrow `allowed_change_paths`; accepted runtime amendment units use their validated `target_stage` and `paths`. A missing/changed work item is BLOCKED/replan.

Before each stage:
1. `stage-cli start`;
2. GitHub sync;
3. execute only the frozen executor; source-changing `agent` work is followed by Git scope verification, while a dedicated `git_verify` stage runs `git-worktree-cli verify` after its start so its evidence is fresh for that stage;
4. record deterministic evidence;
5. on success call `stage-complete-cli.ts complete <run-id> <stage> --pipeline <id>` with any normal stage-cli completion options; on a negative result use the owning `stage-cli block|fail` path instead. Never call `stage-cli complete` directly from OpenStage;
6. sync again;
7. query `next`.

Pending GitHub outbox events must be zero before PR handoff (`github-pr-cli` enforces it). A failing outbox sync never blocks `git_publish` or the final CI wait: publish, then keep retrying the sync while CI runs.

## Compact dispatch and reuse

When calling `stage-cli fix-cycle`, include `--evidence <fresh-review-artifact>` for the repair that follows that review. The CLI freezes its hash and the scope preflight paths. The runtime uses this verified delta; negative result evidence is mandatory for a new charged cycle; missing/PASS/partial/transport evidence cannot charge it.

For each frozen agent work item, call `stage-cli dispatch <run-id> --pipeline <id> --stage <stage> --work-item <id> --role <registered-role> --json` after stage start. Pass its paths and the markers `<pipeline_work_item id="ID"/>` and `<pipeline_dispatch run="RUN" pipeline="PIPELINE" stage="STAGE"/>` to `subagent`. The runtime hook validates fresh machine state, binds the exact agent stage/work-item scope, captures the machine-owned per-dispatch advisory baseline and injects the dispatch packet. `pipeline_runtime_prepare` is optional compatibility tooling, not an LLM-dependent prerequisite. For executor=`review`, use the stage name as `--work-item`, role `CodeReviewer`, and the same markers. The CLI derives `review_work_items` from the frozen catalog; do not create a synthetic review task or bypass dispatch. Never invent `sessionID`.

## Wall-clock discipline

- **One proof per tree.** After a worker reports a bound PASS, call `stage-complete-cli` directly. Never rerun the bound check "to verify independently": the runner wrote that evidence, workers cannot edit it, and `stage-complete-cli` checks its identity and freshness. Rerun only when `stage-complete-cli` rejects it (`ADVISORY_*`): pass the `rerun via GateRunner` command from that error to GateRunner verbatim, and complete the stage once it returns PASS. Do the same when a worker returns without a bound PASS. Gate commands get their identity and install roots from the gate environment (`PIPELINE_RUN_ID`, `PIPELINE_ID`, `PIPELINE_GATE`, `PIPELINE_GATE_ATTEMPT`, `CANDIDATE_SHA` when a candidate exists, `PIPELINE_SCRATCH_DIR`; see `skills/task-management/gate-testing.md`): never ask the owner to export variables, create install directories or prepare a shell for a gate. `gate-runner-cli` reuses an existing PASS for the identical source tree, manifest, environment and commands (`reused_from` in the evidence), so a second work item on the same tree or the final gate after an unchanged advisory run costs seconds. Use `--no-reuse` only to investigate a suspected environment difference.
- **Parallel lanes.** `stage-cli next` returns every runnable stage of independent pipelines. Dispatch all of them in one message as several subagent calls (background or not); do not serialize independent lanes. An owner instruction against background runs never means serial execution. Within one stage, dispatch work items whose scopes do not overlap together.
- **New files and generators.** After a worker adds files, run `git-worktree-cli.ts stage-new <manifest>` (intent-to-add for untracked files inside effective scope) so project tooling that reads the git index sees them. Regenerate derived files only through frozen generators: `stage-cli generate <run-id> <generator-id>` (write, then check). Run both before the coordinator check and before `git_verify`; never ask the owner to run `git add` or a generator.
- **Coordinator check.** Workers run only their impacted tests; `coordinator_only` commands (type-check, lint, build, complete suites) never run inside a worker. Before a review on a combined tree (after a parallel wave, before the sink review, after a repair), run only the coordinator commands (`gate-runner-cli RUN PIPELINE GATE --advisory --coordinator`, through GateRunner: build, type-check, lint), and fix what it finds in the owning lane. Worker bound checks already ran the impacted tests; never run the complete advisory set before a review. The final authoritative gate runs the complete set and reuses every command that already passed on the same tree (`commands_reused`).
- **Long checks.** Never start a shell command in the background, in OpenStage or in a child: its completion wakes only the session that started it, and the parent waits forever. OpenStage runs short sequential commands itself in the foreground (CLI calls, a single advisory run expected to take about a minute or less, `stage-new`, `generate`). Only long advisory runs (base probe, coordinator check, a bound-check rerun) go to `GateRunner` as a background subagent with the exact command, and only when OpenStage has other runnable work to do meanwhile (parallel lanes, reviews, other checks that do not change the tree under a running coordinator check); with nothing else to do, run it in the foreground yourself. GateRunner runs the command in the foreground and returns `status`, `evidence` and failures. The authoritative gate runs in OpenStage's foreground with `timeout: 3600000`. GateRunner `INTERRUPTED` → dispatch it once more; a second one is a blocker to report.
- **Bounded diagnostics.** Every diagnostic subagent prompt (GateRunner, TestEngineer, OpenDevopsSpecialist, a reviewer investigating a failure) states an explicit limit: at most N shell calls and M minutes (default 5 calls, 15 minutes; stricter for a single narrow question). The subagent stops at the limit and returns what it has, marked partial; OpenStage decides the next step from that instead of waiting or redispatching the same open-ended task.
- **Worker leftovers and stray files.** When `git-worktree-cli verify` fails on an untracked path outside scope that a worker created, run `git-worktree-cli.ts quarantine-strays <manifest> --apply` (moves only untracked, out-of-scope files created after the first dispatch into the run's quarantine) and verify again. An untracked file that predates the RUN and blocks verify or a gate goes the same way with `quarantine-strays <manifest> --apply --include-pre-run --paths <path>...` (exact untracked files only; tracked, protected, sensitive and `.tmp/pipelines`/`.git` paths are refused; the move is reversible and never a delete). Never ask the owner to `rm`, move or commit anything.
- **Decide inside the approved plan.** Without the owner: `test_rework` paths and sibling test/support files of an in-scope test (`scope-check` authorizes them itself, no owner amendment), approved deletions, pre-run stray files, generator reruns, package-manager/environment preparation, gate environment. Ask only for what the approved plan does not decide.

The worker reads authoritative paths itself. OpenStage reads compact state, blockers and evidence paths. `--no-session-reuse` disables resume in runtime; reviewer/planning sessions remain fresh. Missing/unavailable child sessions fall back fresh before execution; worker failures retain normal repair semantics.

Every compact subagent result carries `session_reuse`: `resumed` or `fresh:<reason>`. That field is the only source of truth about continuity: call a dispatch a continuation of a session only when it says `resumed`, and never pass or invent `sessionID` (runtime strips it). A background child first returns `status: running` with `child_running: true`; it is not a result. Wait for the OpenCode completion notification; runtime refuses a redispatch of the same work item meanwhile (`CHILD_STILL_RUNNING`). If a turn of yours ends while the RUN is active, nothing runs and no owner checkpoint is open, runtime wakes you once with a `<pipeline_wake/>` message: run `stage-cli next` and continue.

A dispatch or result with `runtime_reload_required: true` means the distribution changed on disk after OpenCode started, so the running hooks still enforce the old rules. Finish no further stage: stop at an owner checkpoint asking to restart OpenCode, then continue the same RUN. `runtime_changed_during_run: true` (OpenCode was restarted with a newer distribution mid-RUN) is informational: reread this command before the next dispatch and name it in the final report.

A review verdict is persisted by runtime under `handoffs/results/**`. Never dispatch a reviewer (fresh or "the same one") to persist, restate or confirm a verdict it already returned; record the decision from the result file.

## Dispatch and machine gates

Dispatch strictly by the frozen `executors[stage_id]`; never infer executor from a stage name.

- `agent`: implementation / `technical_fix` work goes to the scoped worker for the exact frozen work item. Worker agents never publish or transition state. Every supplied bound `advisory_checks[]` entry is mandatory before successful completion of that agent stage; `stage-complete-cli` rejects missing, non-PASS or stale evidence.
- `review`: fresh CodeReviewer with `technical_fix|security_fix|replan|security_stop|scope_stop|secret_stop|destructive_stop|optional`. Every finding is tagged `subject: product|test_coverage` and `blocking`; only blocking findings charge a cycle. A test-coverage note blocks only when it hides product behavior. Keep notes in the verdict and list them for the owner at acceptance. A lane `review` runs as soon as that lane's implementation completes, in parallel with other lanes; the sink review checks only cross-lane interaction and changes after lane reviews.
- `local_gate`: call `gate-runner-cli.ts <run-id> <pipeline-id> <stage-id>`. Use it for deterministic test/lint/typecheck/build/docs and install/runtime/smoke gates. Only its PASS evidence can satisfy the stage; successful transition still goes through `stage-complete-cli`, which delegates to the existing canonical local-gate evidence verification. For the cost-aware deployable path, local fail-fast gates are frozen after `git_verify` and before `git_publish`; post-CI local CD gates consume the published `{candidate_sha}`.
- `git_verify`: after `stage-cli start`, use only `git-worktree-cli verify <manifest>`. It writes canonical `git-verify.json`; `stage-complete-cli` delegates to the existing freshness check and rejects missing or pre-stage/stale verify evidence.
- `git_publish`: Git verify, then `git-worktree-cli publish <manifest>`. **This executor owns staging, candidate commit creation, non-force push and remote-SHA verification. Never ask the owner to run `git add`, `git commit` or `git push` during RUN.** `stage-complete-cli` delegates to the existing candidate check requiring PASS `candidate.json` with `candidate_sha == remote_sha`.
- `github_ci`: `validate` then `run` for the frozen workflow/event/branch and exact published SHA; all `required_jobs[]` plus terminal job must be `completed/success`. Canonical v2 gates are artifactless: workflow run/attempt + exact `candidate_sha` + required-job evidence is the provenance contract, and `actions/upload-artifact`/`download-artifact` is incompatible with an artifactless gate. FAIL/BLOCKED always writes canonical identity/phase evidence. For terminal FAIL, `diagnose` writes compact job metadata plus redacted multiline per-job `.log` files; use `log ... --job|--job-id` for one exact-run job. Deterministic diagnostics own CI log access; ask the owner only on explicit auth/permission blockers. A job GitHub never started (billing, spending limit, no runner) is `GITHUB_CI_INFRA_BLOCKED: <kind>` (reason from the job annotations), not a code failure: charge no cycle and do not rerun. With `github_ci_mode: optional` write `ci_infra_waiver` evidence (`kind`, `stage`, `pipeline_id`, `reason` quoting the blocker), run `stage-cli owner-skip`, post one `⚠` line and continue. With `required`, stop once and offer the owner: fix GitHub and rerun `run` on the same candidate, or skip the stage. `GITHUB_CI_CODE_FAILURE` is the normal failing-gate path.
- `github_dev`: retained for the special `testing_strategy.mode=opencode_host` path only. Call deterministic `validate` then `run`; the stateful trusted workflow receives the exact `candidate_sha`, exact successful source-CI `workflow_run_id`, `pipeline_run_id` and optional `target_id`, then installs/checks out that SHA and validates the target. `disposable` legacy gates remain supported when already frozen, but ordinary `hybrid` CD does **not** use `github_dev`; it uses `local_gate` after final GitHub CI.
- Source documentation is changed by DocWriter only when represented by a frozen `agent` work item/scope and must complete before `git_publish`. Deterministic docs checks, if any, are explicit `local_gate` or `github_ci` stages. Post-publish finalization may update pipeline/PR metadata only; any repository source change after publication requires a new candidate SHA and rerun of affected GitHub/runtime gates.

- `owner_acceptance`: manual owner test gate used only when the frozen testing strategy says `post_deploy_test=user|automated_then_user`. Generic `stage-cli complete` and `stage-complete-cli complete` are forbidden for this executor. Stop RUN after successful local CD and report the exact deployed candidate SHA/source-CI run and what the owner should verify. Only after an explicit owner response for that current stage call `stage-cli owner-accept <run-id> <stage> --pipeline <id> --result pass|fail [--message <text>]`. A PASS resumes scheduling. FAIL records a resumable owner changes-requested checkpoint; it MUST NOT make the RUN terminal before the feedback is classified.

Owner feedback may clarify local requirements/AC/UI/behavior in this same RUN when business intent, architecture, external contracts, security boundaries and destructive semantics remain compatible. It may add files/components/technical work/runtime work units; existing frozen work-item count is not a replan boundary. Keep manifest immutable after first implementation start; effective contract = manifest + accepted amendments + reconciliations. Write fresh review evidence by the same classes as runtime scope (class 1: SeniorTechnicalPlanReviewer only; class 2: ArchitectureAnalyzer, then SeniorTechnicalPlanReviewer on its artifact, never in parallel), then `stage-cli owner-amend-apply <run-id> <checkpoint-stage> --pipeline <id> --evidence <owner-amendment.json>`. Any existing checkpoint between stages may receive explicit owner feedback. Reopen only the affected implementation-to-acceptance chain; old candidate/CI/deploy gate results become stale. Workers receive runtime units through the same hash-checked dispatch boundary.

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

Respect the repository package-manager contract for `local_gate`. Before dispatch, `stage-cli prepare-environment <manifest>` may install the exact packageManager version into the runtime user's managed cache, then rerun environment preflight. This is authorized environment preparation, not a technical-fix cycle or replan; never mutate package.json/lockfiles or substitute another manager. Missing unrepairable tooling, incompatible Node, registry/auth failures or unsupported pins remain environment BLOCKED. Do not ask the owner to install a user-local pinned manager that this deterministic command can prepare.

### Early feedback during implementation

For every CoderAgent dispatch, inspect the packet's `advisory_checks[]`. Every supplied `mode=affected` entry is a mandatory completion check for that exact work item and must be executed by the worker after its source changes using the packet's exact identity. The entry carries the exact allowlisted `command` (literal `$HOME` prefix) for the worker to run verbatim, plus `focus_command` and `frozen_commands[]` for fast single-file iteration:

```text
gate-runner-cli.ts RUN PIPELINE GATE --advisory --affected \
  --work-item WORK_ITEM_ID \
  --baseline BASELINE_PATH \
  --baseline-sha256 BASELINE_SHA256
```

Do not substitute a different baseline, guess a profile/test command or run the bound check concurrently with a worker that overlaps the same frozen work-item scope. A failing bound advisory remains inside the current implementation attempt: correct the source and rerun it without `fix-cycle`. `stage-complete-cli` rejects successful completion when bound PASS evidence is missing, belongs to another work item/baseline, or is stale after another change inside that work-item scope. Unrelated parallel changes outside the scope do not invalidate it.

The worker iterates on a failing suite with `--advisory --command-index N --test-file PATH` (repeatable; explicit `vitest run` commands only) and finishes with the bound check as one foreground shell call with the entry's `shell.timeout`. A run stopped by its caller is recorded as `INTERRUPTED` and does not consume the no-progress fingerprint; rerun it the same way. Never tell a worker it has no shell: its allowlist permits exactly these gate-runner invocations, and a rejected arbitrary command proves nothing. GateRunner, TestEngineer or another permitted specialist may additionally run `--advisory --affected` or `--advisory --command-index N` for diagnostics. Those unbound diagnostic checks are useful evidence but do not satisfy a supplied completion check unless they carry the exact work-item/baseline identity.

Read `skills/task-management/gate-testing.md` for PLAN contract fields and diagnostic/resource rules.
`DIAGNOSTIC_NO_PROGRESS` requires a concrete correction or a new recorded hypothesis under
this RUN's `checks/` (pass `--hypothesis PATH`); if diagnosis is exhausted, dispatch independent
review of code and tests. It is not a routine owner checkpoint. Do not weaken tests or
rewrite a frozen manifest to bypass diagnostics. Authoritative invocation has no `--advisory`;
only its complete final evidence satisfies the stage.

## Automatic repair loops — initial budget 5

Implementation omissions, PARTIAL output, interruption recovery and parent-requested completion redispatch the same work item without `fix-cycle`. Bound or diagnostic advisory checks through the existing gate runner are free and do not complete authoritative test stages. A bound advisory failure is corrected inside the same implementation attempt and cannot be bypassed by completing the agent stage. Only a fresh negative CodeReviewer or authoritative machine-gate result initiates a charged cycle. A repair cycle is one source-changing attempt that reaches its next authoritative review/gate result. The shared budget applies to both `technical_fix` and bounded `security_fix`. **Scope discovery/authorization happens before the cycle counter is consumed.** If the frozen DAG contains executor=`review`, that stage runs a fresh CodeReviewer. A cycle already started may finish through that review/gate even when its counter becomes `N/N`.

When a gate of one pipeline (typically the sink) finds a defect whose files belong to an upstream pipeline it depends on, charge the cycle on the sink gate and reopen that lane: after `scope-check`, `stage-cli fix-cycle <run-id> <gate-stage> --pipeline <sink> --evidence <file> --repair-pipeline <lane>` (all preflight paths must lie in the lane's scope; `CROSS_LANE_NOT_UPSTREAM` / `CROSS_LANE_OWNER_AMBIGUOUS` are refusals to resolve, not to bypass). The lane reruns its agent stage through its end and then the sink chain reruns after the lane is ready again; dispatch borrows the repair evidence through `repair_origin_pipeline`. Never ask the owner to reopen a completed lane.

`fix-cycle` on a review or machine gate reopens its preceding agent stage and all following stages, before or after publication. Dispatch the affected original work items on that agent stage, following their frozen dependencies: the item whose scope owns each finding's paths, never a fixed carrier item. Completion of a reopened stage needs bound evidence only from work items dispatched in this repair loop (`ADVISORY_REPAIR_DISPATCH_REQUIRED` otherwise); earlier evidence of other items is superseded, so do not rerun their stale checks. Preserve completed independent source work; if affected items cannot be identified safely, widen the repair coverage within approved scope. Its dispatch borrows the initiating gate's repair evidence, paths and loop number. A retry of the same accepted result while repair is open is idempotent. All findings and worker continuations before the next authoritative result remain that one cycle. Batch every finding of one review into that cycle: when the same review also has a confirmed bounded `security_fix`, run `security-fix-check` first and charge one `--repair-class security_fix` cycle that carries the technical findings too, instead of two consecutive cycles. Each repair prompt names the defect class and asks the worker to audit and fix every path of that class (all branches of the function, the sibling workflow, the same assertion pattern), not only the cited line; repeated findings of one class are the most expensive cycles, so pass the reviewer's class name and remaining-instance list to the worker verbatim by path. Record the next cycle on the initiating gate only; reopening source work and running fresh review do not consume a second cycle. Never dispatch CoderAgent on a review stage or require a PLAN amendment merely to transport an approved fix. A completed implementation stage and a preceding live-test PASS do not require owner amendment: a new bounded `technical_fix` review automatically reopens source through `fix-cycle`. Continue without asking for owner approval while scope/security and budget permit; owner amendments are for changed requirements, not residual or new defects in approved behavior. An older blocked checkpoint with an already charged cycle may resume that same attempt through fix-cycle only with identical hash-bound repair evidence and authorized paths after the current scope/security preflight; a fresh result or changed scope/evidence starts a new cycle.

### Source deletion and deferred decisions

Moving/archiving tracked source byte-for-byte is never transcribed by a model. Use `git-worktree-cli.ts move <run-id> --pipeline <id> --stage <active-agent-stage> --work-item <id> --role <worker-role> --evidence <run-local-review.json>` with `kind=source_move` and `moves[]` of `{from,to}` instead of `paths[]` (other fields as below). The CLI validates every move first, copies without overwriting, verifies SHA-256, then removes the original; it is resumable and records `source-move-*.json`.

Removing tracked source already required by approved acceptance criteria is ordinary scoped implementation, including upstream replacement cleanup. Use `git-worktree-cli.ts delete <run-id> --pipeline <id> --stage <active-agent-stage> --work-item <id> --role <worker-role> --evidence <run-local-review.json>`. Reviewed JSON requires `kind=source_deletion`, `status=ready`, exact `run_id`, `pipeline_id`, `work_item_id`, frozen `work_item_sha256`, concrete `paths[]`, `approved_requirement=true`, `owner_decision_required=false`, and non-empty `policy_basis` citing the requirement. The CLI verifies dispatch, branch, scope, tracked regular files and protected/symlink paths, then records evidence. Do not leave tombstones or ask the owner to run rm for approved source deletion.

For a new deletion requiring a decision, prepare paths, reasons, consequences and proposed changes without executing it. Register run-local JSON using `stage-cli owner-decision-defer <run-id> <decision-id> --pipeline <id> --evidence <file>`. Evidence requires `kind=deferred_owner_decision`, `owner_decision_required=true`, `independent_repairs_safe=true`, `action_executed=false`, `summary`, exact `paths[]`, `source_stage` and `before_stage`, the frozen final verification/test gate. Continue only independent safe repairs. Reviews may accept those changes while explicitly retaining the deferred finding; never claim the deferred requirement is implemented. The CLI blocks the final gate after preceding work finishes. Present all pending decisions together. Dependent actions stay blocked; active secret exposure or an unsafe ongoing runtime action cannot be deferred.

After an explicit owner response only, call `stage-cli owner-decision-resolve <run-id> <decision-id> --message approve|reject`. Approval resumes the initiating stage's existing fix loop without resetting/granting cycles or bypassing security/scope checks. Rejection requires an owner amendment when approved requirements change. New source deletion evidence can reference an approved `decision_id`; its exact paths must match that decision. `--unattended` never supplies approval.

For `technical_fix`:

1. diagnose from canonical evidence; for GitHub failures use `github-actions-gate-cli diagnose` before asking the owner for anything;
2. identify exact repository paths before source mutation;
3. call `stage-cli scope-check <run-id> <stage> <path>... --pipeline <id> --json`;
4. when it returns `TECHNICAL_SCOPE_REVIEW_REQUIRED`, classify: paths inside approved modules with no new dependency or contract between modules (class 1) → fresh SeniorTechnicalPlanReviewer alone (`architecture_status: not_required`); a new module boundary or contract (class 2) → fresh ArchitectureAnalyzer first, then SeniorTechnicalPlanReviewer on its artifact, never both at once. Generator outputs (`generated_paths`, `generators[].outputs`, a bound test map) and test paths of approved components are authorized by scope-check itself. Then use `stage-cli scope-extend ... --class technical --evidence <review.json>` only when that evidence proves a decision-free bounded clarification;
5. Only after scope preflight PASS call `stage-cli fix-cycle <run-id> <stage> --pipeline <id> --evidence <negative-review-or-gate-result>`. Charge on the checking stage, never on implementation.

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

For a source-changing fix after `git_publish`, `fix-cycle` reopens the chain from the preceding source agent through `git_verify` through local fail-fast, publish, final CI and affected CD/runtime stages. Evidence for the previous candidate becomes stale.

The default automatic budget is **5 cycles per review/final machine gate**; agent, publication and owner-acceptance stages have no repair budget. On RUN start the owner may pre-authorize a higher ceiling with `--fix-cycles N` (maximum 20); OpenStage maps it to:

```text
stage-cli fix-budget-set <run-id> --cycles N
```

This operation is audited in stage state as `source=run_override`, applies across the RUN, and only raises limits. During RUN the owner can still grant `+N` to one active stage with:

```text
stage-cli fix-budget-add <run-id> <stage> --pipeline <id> --cycles N
```

Budget exhaustion is checked only when a review/gate result requires the **next** source-changing repair. Never interrupt an already-started `N/N` cycle before its frozen review/gates finish.

**Architecture checkpoint after 5 cycles.** When a charged `fix-cycle` makes the initiating stage's cycle count reach 5 (and again at 10, 15), the CLI output carries `architecture_review_due: true`; the cycle itself proceeds. The next charged `fix-cycle` on that stage throws `ARCHITECTURE_REVIEW_REQUIRED: <pipeline>/<stage>` until the review is recorded. While the started cycle runs or right after it, OpenStage dispatches a fresh ArchitectureAnalyzer in repair-checkpoint mode on the repeatedly repaired block (it reads the review/gate evidence of the cycles, names the defect classes, and decides whether the approach or only its implementation is wrong), then a fresh SeniorTechnicalPlanReviewer on its artifact, never in parallel. OpenStage writes run-local evidence `{kind: "architecture_review", run_id, pipeline_id, stage, result: no_change|apply_within_requirements|requirements_change, summary}` (for `apply_within_requirements` also `requirements_changed`, `acceptance_criteria_changed`, `external_contract_changed`, `security_boundary_changed`, `destructive_change`, all literal `false`) and records it with `stage-cli architecture-review-record <run-id> <stage> --pipeline <id> --evidence <file>`. `no_change` and `apply_within_requirements` continue without the owner: post one `⚠` line (what the review changed in the approach, how to undo) and give the architecture artifact to the next repair as context. `requirements_change` blocks only that stage (`ARCHITECTURE_REQUIREMENTS_CHANGE: owner decision; other lanes continue`): keep running every other runnable lane, notify the owner once in Russian with the plain-language choice, and resume only through the runtime-replan path below. The owner is notified, never asked to babysit the checkpoint. This does not change the budget: 5 cycles per stage by default, `--fix-cycles` up to 20.

At a budget exhaustion checkpoint (the next repair would exceed the limit) the owner has three choices:

1. **Continue current approach:** explicit `+N` → `fix-budget-add`.
2. **Runtime replan this block:** only on explicit owner intent; fresh ArchitectureAnalyzer, then SeniorTechnicalPlanReviewer on its artifact, `stage-cli runtime-replan-propose`, mandatory owner clarification/approval, then `stage-cli runtime-replan-approve --cycles N`.
3. **Full replan:** when owner feedback changes the business intent, an external contract, security/trust boundary, destructive/migration semantics, or otherwise requires a structural PLAN-level decision. A bounded owner clarification may change local requirements or acceptance criteria through `owner_amendment` while the pipeline responsibility remains compatible.

A pending runtime replan cannot be bypassed with `fix-budget-add`. `--unattended` never supplies runtime-replan approval.

### Security stop taxonomy

Use owner stops only where owner judgement/action is actually required:

- `security_fix` — bounded fail-closed/least-privilege correction determined by frozen policy; automatic and budgeted.
- `security_stop` — owner must decide security policy, trust, role/access semantics, or remediation cannot satisfy the bounded security-fix contract.
- `secret_stop` — actual secret/credential exposure or rotation/revocation is required.
- `destructive_stop` — remediation is irreversible/destructive (for example production-data deletion, global session invalidation, key rotation with destructive effects).
- `scope_stop` — repair needs protected/sensitive/non-authorizable scope.
- `replan` — business-intent change, external contract, security/trust boundary, destructive/migration semantics or another structural PLAN decision is required. Local owner-approved requirements/AC clarification inside the approved pipeline responsibility is `owner_amendment`, not `replan`.

For `security_stop | secret_stop | destructive_stop | scope_stop | replan`, use `stage-cli block` and report a resumable BLOCKED owner checkpoint. Do **not** mark the RUN terminal `failed` merely because a security finding exists. These stops consume no fix cycle.

When an owner security decision is genuinely required, do not ask the owner to design the security mechanism. Present: (1) what resource/action is being protected in plain language, (2) what the frozen policy cannot decide, (3) the safest fail-closed default, (4) concrete owner choices and consequences, and (5) a recommendation. Ask only for the policy/business choice; implementation details remain the pipeline's responsibility.

Do not make CI green by excluding/suppressing a failing tracked test merely because fixing it needs a runtime scope extension. Test removal/exclusion requires evidence that the test no longer represents approved requirements, not convenience.

After any source-changing fix to an already published candidate: Git verify, rerun the frozen local fail-fast gates, publish a NEW candidate SHA, then rerun every affected final `github_ci`, CD/runtime and acceptance gate. Evidence from the previous candidate is stale by construction and `stage-complete-cli` must reject it.

## Status on request

When the owner asks for status, read `.tmp/pipelines/<run-id>/state.json` and `stage-cli next <run-id> --json` once and show lanes and work items (pipeline, stage, state, cycles `n/N`, blocker or `⚠` notes) as a compact `openchamber_render` page when that tool exists, otherwise as a table, in Russian. Do not dispatch or change anything for a status request.

## Status semantics

- `ready`: functional/acceptance gates through frozen `ready_after_stage` passed.
- `release_ready`: release/build/runtime gates through `release_ready_after_stage` passed.
- `completed`: every frozen stage, including pre-publish source documentation and post-validation non-source handoff/finalization, is completed/skipped with evidence.

Do not use natural-language completion to skip these state transitions. A pipeline may continue from `ready` or `release_ready` into later frozen stages.

Closing a RUN (every pipeline terminal, or a final owner stop) always ends with `node $HOME/.config/opencode/skills/task-management/scripts/reuse-report.mjs <run-id> .tmp/pipelines/<run-id>/reuse-report`. The final report cites `reuse-report/summary.json`: subagent session reuse (`agents`, `groups`, `fallback_reasons`) and gate evidence reuse (`gates`) as two separate figures, never summed, plus any `runtime` events.

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

Use the deterministic CLI that owns the operation. Owner shell intervention is allowed only on explicit `OWNER_ACTION_REQUIRED`, auth or permission blockers; model/tool-format inconvenience is not an owner task. Never hand the owner `rm`, `git add|commit|push`, exports of gate variables, install-root creation or generator runs: deletion of strays is `quarantine-strays`, identity/install roots come from the gate environment, staging/commit/push belong to `git_publish`. If a command needs a shell action only the owner can do, say in Russian exactly one command, why, and what RUN does meanwhile.

Follow-up issues of the run (out-of-scope findings, deferred work): write the body to `.tmp/pipelines/<run-id>/follow-up-<name>.md` and create the issue with `gh issue create --repo <owner/repo> --title <title> --body-file .tmp/pipelines/<run-id>/follow-up-<name>.md` (the only `gh` write OpenStage has; the owner pre-granted it for follow-ups; no labels/assignees beyond what the body states). Mention the issue number in the final report. Never use it for the delivery PR or to reopen/close existing issues.

## Owner skip

The owner may skip any stage. Only after the owner's explicit decision, write run-local evidence `{kind: "owner_skip", stage, pipeline_id, reason, owner_decision_required: true, owner_decision: "<owner's words>"}` and call `stage-cli owner-skip <run-id> <stage> --pipeline <id> --evidence <file>`. Before skipping an `agent`, `review` or `fail-fast` stage, say in one line what will not be done or verified. `--unattended` never skips a stage on its own (the only automatic skip is `ci_infra_waiver` under `github_ci_mode: optional`). List every skipped stage in the final report and the PR description. Runtime, deployment and install gates have no advisory mode: do not try to reach them through `--advisory`.

## Owner approval and unattended

`--unattended` skips interaction only inside the already-approved frozen scope. It does not approve decisions, changed scope/base/manifest/evidence, exceptions or merge. It also never auto-approves a runtime replan: `awaiting_owner_clarification` and `awaiting_owner_approval` are mandatory owner checkpoints.

Owner-facing messages (questions, `⚠` lines, checkpoints, status, final report) are always in Russian, in plain functional language (what the user sees, what changes in testing or time), whatever `artifact_language` the artifacts use. When an owner decision is required and the owner does not answer, keep running every lane that does not depend on it and ask once; do not repeat the question or idle the RUN. With `openchamber_render` available, ask choices as a page with `awaitAnswer` (options as buttons) and continue in the same turn; otherwise numbered plain-text options.

Under `--unattended`, stop only for a BLOCK condition listed below or a mandatory owner checkpoint. Any other choice the rules allow (`scope-check` PASS, no change to AC, contracts, DAG or security) is yours: take the recommended option, post one line starting with `⚠` that names the choice and how to undo it, and keep going. The owner reads warnings later and corrects them. When an owner instruction conflicts with the usual mechanism (for example, no background runs), comply in the compatible way instead of asking.

Reuse healthy CoderAgent sessions for continuations of the same frozen work item, including PARTIAL completion, bound-advisory corrections and parent completion redispatch at `loop=0`, as well as automatic repair cycles (`technical_fix` or bounded `security_fix`). TestEngineer/BuildAgent reuse remains limited to automatic repair cycles. Require exact:

```text
{run_id,pipeline_id,stage,role,work_item_id}
```

The first dispatch is fresh. Runtime checks the frozen contract/scope fingerprint, prior state revision, required files, persisted previous result or authoritative repair evidence and child availability. Continuation does not consume a fix-cycle. Interrupted/error/cancelled/in-progress sessions without confirmed healthy completion fall back fresh; interruption recovery does not itself prove safe resume. Legacy registry entries without a contract fingerprint also fall back fresh once. Planning/reviews are always fresh. Invalid reuse starts a fresh child, never another worktree session.

## GitHub handoff mode

`github_handoff_prepare` / `github_handoff_status` verify immutable source/worktree and generated validation. Approved automatic repair loops use the RUN/stage budget (default **5 cycles**, optionally raised by explicit owner `--fix-cycles N`). `github_handoff_publish` publishes only a validated outcome. No implicit Git setup, force push or ref change.

## Stops

BLOCK on stale main/base, wrong worktree, changed planning evidence/project policy/work item, failed GitHub→OpenCode-host CD readiness recheck, unresolved owner decision, changed manifest, invalid/unreadable rules, protected/sensitive runtime-scope request, runtime-scope review that changes business intent/external contracts/security boundaries/destructive behavior outside an approved bounded owner amendment, GitHub gate without a valid frozen contract, missing workflow without its frozen bootstrap/adaptation work item, GitHub Environment/trusted-ref/concurrency mismatch, required GitHub job skipped/failed/missing, missing or mismatched artifact ID/digest, GitHub run/evidence from the wrong SHA/workflow/job/artifact, local-gate package-manager/environment failure, a true `security_stop`/`secret_stop`/`destructive_stop`/protected `scope_stop`, conflict that requires a DAG change, runtime failure needing design change, or an exhausted automatic-repair budget awaiting an owner choice.