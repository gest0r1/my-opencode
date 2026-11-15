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

`stage-cli` owns frozen manifest/rules/planning evidence, DAG, executor contracts, machine-owned runtime scope extensions, owner-acceptance state and negative transitions. `stage-complete-cli` is the mandatory boundary for every ordinary successful stage completion: it first verifies any bound Coder advisory evidence for the exact dispatch/work-item scope and then delegates to the existing `stage-cli complete` evidence checks. `git-worktree-cli` owns identity/effective-scope/non-force publication. `gate-runner-cli` owns frozen local gates and advisory checks. `dev-deploy-cli` owns evidence that the dev contour runs exactly the candidate. `github-actions-gate-cli` and `deployment-target-cli` serve only legacy runs frozen with GitHub gates. Model output never overrides deterministic FAIL/BLOCKED or owner decisions. OpenStage is the only orchestrator; never delegate orchestration to BatchExecutor or another child.

## Preflight and owner clarifications

1. Determine actual active stages, then `git-worktree-cli.ts sync-main <manifest> --check` (read-only) and never reset the branch to main: branch work stays, only missing main commits are merged in. (a) Checkout clean and main not contained: `pipeline-replan-cli.ts preflight <run-id>` followed by trusted `worktree-refresh.sh` synchronizes main with a verified snapshot of `.tmp/pipelines`. (b) Main already contained (`contains_main: true`): no synchronization, even with uncommitted changes of an earlier attempt; continue. (c) Uncommitted changes and main moved (typical restart after a merge): do not stop; continue implementation and run `git-worktree-cli.ts sync-main <manifest>` before `git_verify` (it commits the in-scope changes as a branch checkpoint and merges main; out-of-scope changes refuse with `SYNC_MAIN_OUT_OF_SCOPE`, nothing changed). `/pipeline-run` authorizes this deterministic synchronization. A merge conflict or main changing plan-relevant paths (`STALE_PLAN`) is an owner checkpoint (checkpoint commit kept); never stash/reset/rebase or repair conflicts outside PLAN.
2. `pipeline-reconcile-cli.ts apply <run-id>` is the common Issue/main compatibility check. Unchanged source and main outside `planning_scope` use a cheap deterministic PASS. Hash mismatch is only a detector: inspect exact diff/live requirements against approved stories/AC/architecture/contracts plus accepted amendments. `REVIEW_REQUIRED` does not mean full replan. Persist fresh review in this run and call `apply --evidence <path>`; review binds `input_sha256`, `result: COMPATIBLE|PLAN_INVALID`, reason, and for compatibility explicit false values for `business_intent_changed`, `architecture_invalid`, `external_contract_changed`, `security_boundary_changed`, `destructive_change`, `owner_decision_required`, `implementation_change_required`.
3. If compatible clarification needs implementation changes, first amend effective work: before implementation use `/pipeline-plan --revise <same-run-id>`; after implementation use owner amendment with exact paths and optional hash-bound runtime work units. Then reconcile against the effective contract. Accepted reconciliation appends evidence and adopts source digest/base; no manifest rewrite or repeated owner approval.
4. `PLAN_INVALID` before implementation means revise the same folder and invalidate only affected gates. Changes in owner-approved behavior/scope/constraints require renewed approval; technical corrections retain it. After implementation actually started, incompatible replan uses a new folder with CLI inherited context, leaving old run intact.
5. `stage-cli validate <run-id> --json`, then `stage-cli run-preflight <run-id> --json`, `prepare-environment <manifest> --dependencies` (exact user-local package manager from packageManager, then dependencies from the lockfile), `preflight <manifest> --environment`, `git-worktree-cli adopt` (only before the first source agent start; it needs the clean adopted base) and `verify` must PASS before dispatch. A resumed RUN with uncommitted earlier work skips `adopt` and relies on `verify` plus step 1. For Issue runs `github-issue-cli check <run-id>` uses the accepted effective source digest. Schema v1 is audit/read-only: `LEGACY_V1_REPLAN_REQUIRED` requires a v2 PLAN. Rules are live external policy: a changed rules hash/version is not a blocker; missing/unreadable/malformed rules BLOCK. deployment target recheck is required only for `opencode_host`. Owner ensures only one RUN executes across worktrees. Apply an explicit `--fix-cycles N` override before scheduling.
6. Base probe, once per RUN before the first source-agent start (skip when implementation already started): for every pipeline whose profile has a pre-publish `local_gate` (before `git_publish`, not deploy/smoke, no `{candidate_sha}`), run `gate-runner-cli.ts <run-id> <pipeline-id> <gate> --advisory --base-probe` through GateRunner on the clean adopted checkout. It executes the complete frozen command set and writes `checks/<pipeline>-<gate>-base-probe.json`. A PASS plan probe (PLAN, `planning/probes/<pipeline>-<gate>.json`) may satisfy this requirement only through the existing `planProbeMatches` validator and `cleanHeadIs` check. For live PostgreSQL gates that means **the exact pipeline**, `phase=plan_probe`, `preflight_status=PASS`, `candidate_sha=null`, the verified baseline HEAD and identical frozen command/resource `input_digest`, not merely `commands_sha256` or another lane's result; a FAIL plan probe counts like a FAIL base probe. PASS → dispatch. FAIL means that gate is already red on the untouched base: because implementation has not started, revise this PLAN in place (`/pipeline-plan --revise <same-run-id>`) so a first baseline-repair work item (`"baseline_repair": true`) owns the failing suites (technical correction, approval retained), or stop at an owner checkpoint when the repair would change approved behavior/contracts. Never let an unrelated work item absorb a pre-existing red suite. BLOCKED is an environment blocker, not a red base. `stage-cli dispatch` enforces the probe per frozen profile (pipelines sharing a profile need a single probe): no probe on a clean base → `BASE_PROBE_REQUIRED`; a FAIL probe → `BASE_RED_REPAIR_REQUIRED` until the plan holds a `baseline_repair` work item on that profile; once the checkout has already moved past the base, a missing probe is recorded in the dispatch baseline instead of blocking.

Owner may provide clarification at any moment in the current session, including between stages and after acceptance FAIL. Stop source workers before applying it. Before implementation starts, revise this PLAN in place; after it starts, compatible feedback uses amendments. Starting RUN/preflight/review is not the implementation freeze boundary.

## Candidate-contour lifecycle gates

A frozen `local_gate` with `gate_testing[profile][gate].input_kind: candidate-contour`
is a post-publish test on a repo-provisioned disposable contour, **not**
`deployed-service`. Require the reviewed `lifecycle` descriptor in the
same frozen manifest: typed producer command, exact command identity-to-operation
mapping, v2 handoff schema, recipe SHA-256 and exclusive lock. The runner
allocates a fresh lease/scratch per frozen command, runs `reap` and `provision`,
validates the identity-bound handoff, injects the ref and SHA-256, executes the
unchanged frozen command, and always calls `down`. A failed provision, changed
handoff or failed cleanup is BLOCKED. No PASS reuse or timeout retry is
permitted for these commands. Only the repository producer manages Docker,
databases, fixtures or provider transports. The operator, not RUN, stops and
restarts any dev contour that shares provider tokens. No installed-config
hot-patch, new stage, extra agent, or alternative scheduler is allowed.

The schema, subcommands, handoff fields, protected incident-copy reference,
failure codes and tests are specified in
`skills/task-management/gate-testing.md#candidate-contour-lifecycle-supervisor-issue-60`.
A previously approved manifest must use ordinary revision/amendment before
accepting the new descriptor. SeVami producer availability is an independent
integration prerequisite.

## Scheduler and frozen work

`stage-cli next <run-id> --json` is the ONLY runnable queue. Do not recompute planning dependencies during RUN. A frozen dependency is satisfied when its upstream pipeline has completed through `ready_after_stage`; only pipelines without that milestone retain the legacy requirement `status=completed`. Therefore a late CI/CD/infrastructure blocker after source-ready does not freeze downstream source work. The `test_preparation` lane contains frozen `test_rework[]` items. Respect the explicit `required_by` dependencies in the frozen plan; independent source lanes may run concurrently. Older manifests without `required_by` retain their frozen legacy dependencies. Rework tests rather than raising limits without evidence. If runnable work remains, RUN stays active even when another pipeline is blocked/failed; report terminal BLOCKED/FAILED only when no active/runnable work remains.

For implementation stages, dispatch work-item IDs frozen in the v2 manifest or hash-bound runtime units in accepted owner amendments. Resolve the exact frozen path+SHA-256 and pass that work item plus its `decision_ids/research_ids/contract_ids`, context files and the current effective scope (`manifest.allowed_change_paths` + machine-owned runtime extensions) to the worker. Never dispatch an unapproved/unhashed ad-hoc work item. New PLAN work items freeze their agent stage and narrow `allowed_change_paths`; accepted runtime amendment units use their validated `target_stage` and `paths`. A missing/changed work item is BLOCKED/replan.

Before each stage:
1. `stage-cli start`;
2. GitHub sync;
3. execute only the frozen executor; source-changing `agent` work is followed by Git scope verification, while a dedicated `git_verify` stage runs `git-worktree-cli verify` after its start so its evidence is fresh for that stage;
4. record deterministic evidence;
5. on success call `stage-complete-cli.ts advance <run-id> <stage> --pipeline <id>` with any normal stage-cli completion options. It runs the same completion checks as `complete`, syncs GitHub, reads `next` and already starts every runnable `agent`, `review` and `local_gate` stage (`started[]`); stages that need preparation first (`git_verify` after `sync-main`, publication, CI, deploy, owner) come back in `waiting[]` and are started by you after that preparation. Do not call `start` or `next` again for what `advance` returned. On a negative result use the owning `stage-cli block|fail` path instead. Never call `stage-cli complete` directly from OpenStage.

Pending GitHub outbox events must be zero before PR handoff (`github-pr-cli` enforces it). A failing outbox sync never blocks `git_publish` or the final CI wait: publish, then keep retrying the sync while CI runs.

## Compact dispatch and reuse

When calling `stage-cli fix-cycle`, include `--evidence <fresh-review-artifact>` for the repair that follows that review. The CLI freezes its hash and the scope preflight paths. The runtime uses this verified delta; negative result evidence is mandatory for a new charged cycle; missing/PASS/partial/transport evidence cannot charge it.

For each frozen agent work item, call `stage-cli dispatch <run-id> --pipeline <id> --stage <stage> --work-item <id> --role <registered-role> --json` after stage start. Pass its paths and the markers `<pipeline_work_item id="ID"/>` and `<pipeline_dispatch run="RUN" pipeline="PIPELINE" stage="STAGE"/>` to `subagent`. The runtime hook validates fresh machine state, binds the exact agent stage/work-item scope, captures the machine-owned per-dispatch advisory baseline and injects the dispatch packet. `pipeline_runtime_prepare` is optional compatibility tooling, not an LLM-dependent prerequisite. For executor=`review`, use the stage name as `--work-item`, role `CodeReviewer`, and the same markers. After a charged repair, re-review with role `FindingsReviewer` (cheaper model): it checks only the issued findings and the repaired lines. Its negative verdict is the evidence for the next `fix-cycle`; when it is ready (or reports `needs_full_review: true`), dispatch a fresh full `CodeReviewer`. `stage-complete-cli` refuses to complete a review stage whose last dispatch was `FindingsReviewer` (`REVIEW_CLOSING_FULL_REQUIRED`), and `dispatch` refuses `FindingsReviewer` before any finding was issued. The CLI derives `review_work_items` from the frozen catalog; do not create a synthetic review task or bypass dispatch. Never invent `sessionID`.

## Wall-clock discipline

**Do not stop while another lane can proceed.** Before a non-terminal owner/security/environment stop, use the latest authoritative `stage-cli next/waves` state already available. If another independent lane or work item is runnable, continue it within current permissions; only report the blocked lane once. Do not add polling, a new agent, or a fresh CLI call when the current response already proves runnable work. A real authorization checkpoint still blocks the affected lane and cannot be bypassed by handover, model reasoning or stale success evidence.

**Fix-cycle rejected?** The error includes all known missing scope/class/architecture prerequisites. Complete them in the documented order rather than repeatedly invoking the same command to learn permissions or prerequisites; never replace a negative gate with a guessed PASS.

- **One proof per tree.** After a worker reports a bound PASS, call `stage-complete-cli` directly. Never rerun the bound check "to verify independently": the runner wrote that evidence, workers cannot edit it, and `stage-complete-cli` checks its identity and freshness. Rerun only when `stage-complete-cli` rejects it (`ADVISORY_*`): pass the `rerun via GateRunner` command from that error to GateRunner verbatim, and complete the stage once it returns PASS. Do the same when a worker returns without a bound PASS. Gate commands get their identity and install roots from the gate environment (`PIPELINE_RUN_ID`, `PIPELINE_ID`, `PIPELINE_GATE`, `PIPELINE_GATE_ATTEMPT`, `CANDIDATE_SHA` when a candidate exists, `PIPELINE_SCRATCH_DIR`; see `skills/task-management/gate-testing.md`): never ask the owner to export variables, create install directories or prepare a shell for a gate. `gate-runner-cli` reuses an existing PASS for the identical source tree, manifest, environment and commands (`reused_from` in the evidence), so a second work item on the same tree or the final gate after an unchanged advisory run costs seconds. Use `--no-reuse` only to investigate a suspected environment difference.
- **Parallel lanes.** Execute `waves.dispatchable` in frozen dependency order (including TestEngineer → CoderAgent); an expected RED is diagnostic, not a coordinator or final gate. The pre-RED baseline and affected GREEN selection are CLI-owned. `stage-cli next` returns every runnable stage of independent pipelines. Dispatch all of them in one message as several subagent calls (background or not); do not serialize independent lanes. An owner instruction against background runs never means serial execution. Which work items start is decided by the CLI, not by you: dispatch exactly the items `advance` returns in `dispatch_now` (or that `stage-cli waves <run-id> --json` lists as `dispatchable`), all in one message, and after any worker returns run `waves` again and dispatch what became dispatchable. `dispatch` refuses an item whose paths a running worker may change (`DISPATCH_SCOPE_BUSY`) or whose `depends_on` item has not returned (`DISPATCH_DEPENDENCY_PENDING`), and `scope-check` refuses a path another stage's running worker may change (`SCOPE_BUSY`): each is a wait for that worker, not a failure; never merge, reorder or widen items to get around it.
- **New files and generators.** After a worker adds files, run `git-worktree-cli.ts stage-new <manifest>` (intent-to-add for untracked files inside effective scope) so project tooling that reads the git index sees them. Regenerate derived files only through frozen generators: `stage-cli generate <run-id> <generator-id>` (write, then check). Run both before the coordinator check and before `git_verify`; never ask the owner to run `git add` or a generator.
- **Coordinator check.** Run it only after the relevant work-item wave is GREEN: never invoke it in the expected TestEngineer RED window or while its consumer CoderAgent remains pending. Other independent GREEN lanes can continue. Workers run only their impacted tests; `coordinator_only` commands (type-check, lint, build, complete suites) never run inside a worker. Before a review on a combined tree (after a parallel wave, before the sink review, after a repair), run only the coordinator commands (`gate-runner-cli RUN PIPELINE GATE --advisory --coordinator`, through GateRunner: build, type-check, lint), and fix what it finds in the owning lane. Worker bound checks already ran the impacted tests; never run the complete advisory set before a review. The final authoritative gate runs the complete set and reuses every command that already passed on the same tree (`commands_reused`).
- **Long checks.** Never start a shell command in the background, in OpenStage or in a child: its completion wakes only the session that started it, and the parent waits forever. OpenStage runs short sequential commands itself in the foreground (CLI calls, a single advisory run expected to take about a minute or less, `stage-new`, `generate`). Long runs (authoritative gates, base probe, coordinator check, a bound-check rerun) go to `GateRunner` as a background subagent with the exact command whenever OpenStage has other runnable work (waves, reviews, other lanes): a gate runs on a tree snapshot, so the tree may change under it. A gate in OpenStage's own foreground blocks every dispatch for its whole duration; run one there (`timeout: 3600000`) only when nothing else is runnable. GateRunner runs the command in the foreground and returns `status`, `evidence` and failures. GateRunner `INTERRUPTED` → dispatch it once more; a second one is a blocker to report.
- **Snapshot fallback.** When a gate's `snapshot.status` is `unavailable`, or a command fails on the snapshot with a cause the evidence ties to the snapshot environment (module or workspace package not resolved, missing file outside the source tree) while the same command passes in the checkout, rerun that gate yourself with `--in-place` appended. Never ask the owner to run a gate. While an in-place gate runs, start no writer whose paths its commands read.
- **Gates on a snapshot.** Full gates and coordinator checks run on a snapshot of the working tree in a separate worktree (`snapshot` in the evidence), so workers keep working while a gate runs: never hold dispatches for a gate. When files changed after the snapshot reach a failed command, the runner itself reruns once on a fresh snapshot (`snapshot.rerun`) and only that result counts; a FAIL it returns is real and charges a cycle as usual. From its last agent stage until its ready milestone a lane's planned files (generated ones aside) are reserved: other pipelines' `dispatch` and `scope-check` wait on them (`DISPATCH_SCOPE_BUSY`/`SCOPE_BUSY` naming `lane <id> in its gate or review`); by plan no parallel lane writes them. Shared paths granted through `scope-check` stay free, so another lane may change them right away. `EVIDENCE_STALE_LANE_SOURCE` at completion then means such a change: rerun the gate, no cycle; it repeats only the commands the changes since its last PASS reach (`snapshot.reused_by_impact`).
- **Machine load.** Full sets (authoritative gates, coordinator checks, base and plan probes) take one machine-wide slot in turn, and narrow worker checks wait while a full set runs; `heavy_slot_wait_ms` in the result is that wait, not a hang. Live-database commands take one machine-wide live slot in turn (`live_slot_wait_ms`), and two checks of one lane gate queue on its lock, so `runtime target is locked` and `GATE_TUPLE_AMBIGUOUS` from parallel checks no longer happen: never serialize workers to avoid them. A command that hits its time limit is rerun once by the runner, alone, before it counts (`timeout_retry` in its evidence). A gate that still fails after that rerun is a real failure. Do not repeat the run on an "idle machine", do not raise limits, and do not record a load hypothesis. Gates get `PIPELINE_MAX_WORKERS` (half the CPUs); a project limits its own test runner by using it in the frozen command.
- **Bounded diagnostics.** Every diagnostic subagent prompt (GateRunner, TestEngineer, OpenDevopsSpecialist, a reviewer investigating a failure) states an explicit limit: at most N shell calls and M minutes (default 5 calls, 15 minutes; stricter for a single narrow question). The subagent stops at the limit and returns what it has, marked partial; OpenStage decides the next step from that instead of waiting or redispatching the same open-ended task.
- **Worker leftovers and stray files.** When `git-worktree-cli verify` fails on an untracked path outside scope that a worker created, run `git-worktree-cli.ts quarantine-strays <manifest> --apply` (moves only untracked, out-of-scope files created after the first dispatch into the run's quarantine) and verify again. An untracked file that predates the RUN and blocks verify or a gate goes the same way with `quarantine-strays <manifest> --apply --include-pre-run --paths <path>...` (exact untracked files only; tracked, protected, sensitive and `.tmp/pipelines`/`.git` paths are refused; the move is reversible and never a delete). Never ask the owner to `rm`, move or commit anything.
- **Decide inside the approved plan.** Without the owner: `test_rework` paths and sibling test/support files of an in-scope test (`scope-check` authorizes them itself, no owner amendment), approved deletions, pre-run stray files, generator reruns, package-manager/environment preparation, gate environment. Ask only for what the approved plan does not decide.

The worker reads authoritative paths itself. OpenStage reads compact state, blockers and evidence paths. `--no-session-reuse` disables resume in runtime; reviewer/planning sessions remain fresh. Missing/unavailable child sessions fall back fresh before execution; worker failures retain normal repair semantics.

Every compact subagent result carries `session_reuse`: `resumed` or `fresh:<reason>`. That field is the only source of truth about continuity: call a dispatch a continuation of a session only when it says `resumed`, and never pass or invent `sessionID` (runtime strips it). A background child first returns `status: running` with `child_running: true`; it is not a result. Wait for the OpenCode completion notification; runtime refuses a redispatch of the same work item meanwhile (`CHILD_STILL_RUNNING`). If a turn of yours ends while the RUN is active, nothing runs and no owner checkpoint is open, runtime wakes you once with a `<pipeline_wake/>` message: run `stage-cli next` and continue.

A dispatch or result with `runtime_reload_required: true` means the distribution changed on disk after OpenCode started, so the running hooks still enforce the old rules. Finish no further stage: stop at an owner checkpoint asking to restart OpenCode, then continue the same RUN. `runtime_changed_during_run: true` (OpenCode was restarted with a newer distribution mid-RUN) is informational: reread this command before the next dispatch and name it in the final report.

A review verdict is persisted by runtime under `handoffs/results/**`. Never dispatch a reviewer (fresh or "the same one") to persist, restate or confirm a verdict it already returned. A review stage remains in progress until the full CodeReviewer's current JSON verdict is present and has `status=ready` without blocking findings. The verdict must echo the dispatch packet's `review_dispatch_id` and `review_source_digest`; pass its actual run-local JSON path via `stage-complete-cli.ts advance RUN REVIEW_STAGE --pipeline PIPELINE --evidence PATH`. If the source digest has changed, redispatch CodeReviewer on current source, not the stale verdict. A `needs_revision` result goes through the usual scope-check + fix-cycle; a late negative verdict on a previously completed legacy review may also be consumed by `fix-cycle` without owner amendment when its dispatch/evidence identity is verified. Never close on `child_running`, missing verdict, `[object Object]`, an optional-only result masquerading as a blocker, or a FindingsReviewer verdict.

## Dispatch and machine gates

Dispatch strictly by the frozen `executors[stage_id]`; never infer executor from a stage name.

- `agent`: execute only frozen CLI-dispatchable work items in `depends_on` order. Role-specific TestEngineer/CoderAgent behavior belongs in their own prompts; the CLI binds `test_first_work_item_id` to pre-RED source and mandatory affected GREEN. `stage-complete-cli` verifies bound PASS/freshness; workers never transition pipeline state.
- `review`: fresh CodeReviewer with `technical_fix|security_fix|replan|security_stop|scope_stop|secret_stop|destructive_stop|optional`. Every finding is tagged `subject: product|test_coverage` and `blocking`; only blocking findings charge a cycle. A test-coverage note blocks only when it hides product behavior. Keep notes in the verdict and list them for the owner at acceptance. A lane `review` runs as soon as that lane's implementation completes, in parallel with other lanes; the sink review checks only cross-lane interaction and changes after lane reviews.
- `local_gate`: call `gate-runner-cli.ts <run-id> <pipeline-id> <stage-id>`. Use it for deterministic test/lint/typecheck/build/docs and install/runtime/smoke gates. Only its PASS evidence can satisfy the stage; successful transition still goes through `stage-complete-cli`, which delegates to the existing canonical local-gate evidence verification. For the cost-aware deployable path, local fail-fast gates are frozen after `git_verify` and before `git_publish`; post-CI local CD gates consume the published `{candidate_sha}`.
- `git_verify`: before `stage-cli start` of the first `git_verify` (and after every source-changing repair) run `git-worktree-cli.ts sync-main <manifest>` so local gates and publication test the branch with current main (`action: none` when main is already contained). After `stage-cli start`, use only `git-worktree-cli verify <manifest>`. It writes canonical `git-verify.json`; `stage-complete-cli` delegates to the existing freshness check and rejects missing or pre-stage/stale verify evidence.
- `git_publish`: Git verify, then `git-worktree-cli publish <manifest>`. The candidate is identified by its SHA and gets no tag: the release tag `vX.Y.Z` lands on that same commit only after owner acceptance and merge (`/pipeline-release`). **This executor owns staging, candidate commit creation, non-force push and remote-SHA verification. Never ask the owner to run `git add`, `git commit` or `git push` during RUN.** `stage-complete-cli` delegates to the existing candidate check requiring PASS `candidate.json` with `candidate_sha == remote_sha`.
- `dev_deploy`: installs the published candidate on the owner's dev contour. After `stage-cli start` run `sudo -n /usr/local/sbin/opencode-deploy-target <deploy_target> <candidate_sha>` (the owner confirms each run; it installs exactly that commit from the owner's root-owned clone with the owner's installer arguments and records the outcome under `/var/lib/opencode/deploy-targets/`). Then `$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/dev-deploy-cli.ts record <run-id> <stage> --pipeline <id>` writes the evidence, and `stage-complete-cli complete` accepts it only for the current candidate installed after the stage started. `DEV_DEPLOY_NOT_RUN`, `DEV_DEPLOY_OTHER_COMMIT`, `DEV_DEPLOY_STATUS_MISMATCH` or a helper error (`not configured by root`, `not in origin`) blocks the stage with that message; `DEV_DEPLOY_FAILED` is a failing gate (read the installer output, `fix-cycle` with the FAIL evidence). Never install another way, never ask the owner to install by hand, never edit the contour's files.
- `github_ci` (legacy, only in runs frozen with GitHub gates): `validate` then `run` for the frozen workflow/event/branch and exact published SHA; all `required_jobs[]` plus terminal job must be `completed/success`. Canonical v2 gates are artifactless: workflow run/attempt + exact `candidate_sha` + required-job evidence is the provenance contract, and `actions/upload-artifact`/`download-artifact` is incompatible with an artifactless gate. FAIL/BLOCKED always writes canonical identity/phase evidence. For terminal FAIL, `diagnose` writes compact job metadata plus redacted multiline per-job `.log` files; use `log ... --job|--job-id` for one exact-run job. Deterministic diagnostics own CI log access; ask the owner only on explicit auth/permission blockers. A job GitHub never started (billing, spending limit, no runner) is `GITHUB_CI_INFRA_BLOCKED: <kind>` (reason from the job annotations), not a code failure: charge no cycle and do not rerun. With `github_ci_mode: optional` write `ci_infra_waiver` evidence (`kind`, `stage`, `pipeline_id`, `reason` quoting the blocker), run `stage-cli owner-skip`, post one `⚠` line and continue. With `required`, stop once and offer the owner: fix GitHub and rerun `run` on the same candidate, or skip the stage. `GITHUB_CI_CODE_FAILURE` is the normal failing-gate path.
- `github_dev` (legacy): retained for the special `testing_strategy.mode=opencode_host` path only. Call deterministic `validate` then `run`; the stateful trusted workflow receives the exact `candidate_sha`, exact successful source-CI `workflow_run_id`, `pipeline_run_id` and optional `target_id`, then installs/checks out that SHA and validates the target. `disposable` legacy gates remain supported when already frozen, but ordinary `hybrid` CD does **not** use `github_dev`; it uses `local_gate` after final GitHub CI.
- When source-changing CoderAgent WI modifies a documented shared contract or behavior, **that CoderAgent** updates the relevant normative project documentation **inside the same frozen `allowed_change_paths` scope** before publish. DocWriter runs **docs-only WI**, not as another executor for a source WI. Use the target project's documentation standard. Deterministic documentation checks remain in existing local gates. Repository changes after publication require a new candidate SHA and affected checks.

- `owner_acceptance`: the owner's manual test on the dev contour. Generic `stage-cli complete` and `stage-complete-cli complete` are forbidden for this executor. After `stage-cli start` write two Russian files in the run directory: `acceptance/checklist.md` (a concise **functional** checklist derived from the approved Effective Story = baseline + accepted architectural deltas, limited to changed user scenarios and exceptions, exact expected results on the dev contour, installed version and short SHA; put technical review notes and machine evidence in a separate optional subsection, not as choices for the owner) and `acceptance/client-notes.md` (plain-language release notes for the client, no internal terms). Stop RUN, give both paths and ask with buttons: «Принять», «Есть замечания», «Свой вариант». Only after an explicit owner answer for that current stage:
  - «Принять» → `stage-cli owner-accept <run-id> <stage> --pipeline <id> --result pass`; scheduling resumes and the RUN goes to the PR.
  - «Есть замечания» → ask for the findings, then `owner-accept ... --result fail --message "<owner's words>"`. Classify them: a defect or a refinement compatible with the plan is a repair of the same version: `scope-check` the paths to change, then `stage-cli fix-cycle <run-id> <stage> --pipeline <id> --evidence .tmp/pipelines/<run-id>/owner/<pipeline>-<stage>.json`. It reopens the chain from the last agent stage; repair, gates, publish of a new SHA, dev_deploy and acceptance follow as usual. The version stays the same; only the SHA changes. A change of business intent or architecture goes through `owner-amend-apply` (below) or a new PLAN.
  - «Свой вариант» → act on the owner's text; when it is neither acceptance nor findings, keep the stage waiting.

Owner feedback may clarify local requirements/AC/UI/behavior in this same RUN when business intent, architecture, external contracts, security boundaries and destructive semantics remain compatible. It may add files/components/technical work/runtime work units; existing frozen work-item count is not a replan boundary. Keep manifest immutable after first implementation start; effective contract = manifest + accepted amendments + reconciliations. Write fresh review evidence by the same classes as runtime scope (class 1: SeniorTechnicalPlanReviewer only; class 2: ArchitectureAnalyzer, then SeniorTechnicalPlanReviewer on its artifact, never in parallel), then `stage-cli owner-amend-apply <run-id> <checkpoint-stage> --pipeline <id> --evidence <owner-amendment.json>`. Any existing checkpoint between stages may receive explicit owner feedback. Reopen only the affected implementation-to-acceptance chain; old candidate/CI/deploy gate results become stale. Workers receive runtime units through the same hash-checked dispatch boundary.

### Testing strategy execution

The owner-selected manifest strategy is binding. New plans use `hybrid` with `github_ci_mode: "off"`; GitHub Actions are not used.

- `hybrid`: local fail-fast gates, publish, the local candidate gate on the exact published SHA (`deployment_validation.stage`), then `dev_deploy` on `deploy_target`, an optional local smoke gate against the contour, then `owner_acceptance` when `post_deploy_test` asks for it. A local deployment/runtime failure is a normal failing gate.
- `github`, `opencode_host` (legacy, only in runs frozen with GitHub gates): `github` publishes and waits for the final GitHub CI without deployment; `opencode_host` adds the trusted `github_dev` workflow after a target re-probe, and loss of target readiness BLOCKS. With `github_ci_mode: optional` an infrastructure-blocked GitHub job is waived as described for `github_ci`.

### Missing or incompatible project workflow

Legacy: applies only to runs frozen with GitHub gates.

A frozen GitHub gate marked `bootstrap_required` means RUN must implement the mapped CI/bootstrap work item in the TARGET PROJECT before candidate publication. After that source change:

1. Git scope verify;
2. `github-actions-gate-cli validate <run-id> <pipeline-id> <github-stage>`;
3. if validation is not PASS, repair only inside the same frozen work item/scope using the normal technical-fix counter;
4. continue the frozen DAG through every local fail-fast gate between `git_verify` and `git_publish`;
5. only after those local gates PASS, publish the candidate branch;
6. for first-time workflows use the frozen `push` trigger and wait for that exact candidate SHA.

If CI is missing/incompatible, implement its frozen bootstrap/adaptation work item and validate it before publish. If stateful DEV is missing for an explicitly selected `opencode_host` strategy, implement its frozen `future_github_gates` work item as source only and run `github-actions-gate-cli validate-future <run-id> <pipeline-id> <gate-name>` before publication; do **not** add a current-run `github_dev` stage for it. After owner merge makes that workflow trusted, a later PLAN can activate the remote-CD path. Ordinary `hybrid` does not need this bootstrap because its CD stage is local.

Never replace a missing, incompatible or failed **final** GitHub CI workflow with local-only validation. Local npm/pnpm/pytest/build gates are expected before publication, but final independent exact-SHA CI must still pass. If the frozen bootstrap/adaptation scope cannot produce a valid final CI workflow, BLOCK/replan.

Respect the repository package-manager contract for `local_gate`. Before dispatch, `stage-cli prepare-environment <manifest>` may install the exact packageManager version into the runtime user's managed cache, then rerun environment preflight. Run it with `--dependencies` at RUN start and once more whenever a gate or worker fails because a package or module is missing (`MODULE_NOT_FOUND`, `Cannot find module`, broken `node_modules` link): it restores project dependencies strictly from the lockfile (pnpm `install --frozen-lockfile`, npm `ci`, yarn `--immutable`, bun `--frozen-lockfile`) and writes `checks/dependencies.json`; `DEPENDENCY_LOCK_CHANGED`/`DEPENDENCY_LOCK_MISSING`/`DEPENDENCY_INSTALL_FAILED` are environment blockers, never a reason to hand the owner `pnpm install`. This is authorized environment preparation, not a technical-fix cycle or replan; never mutate package.json/lockfiles or substitute another manager. Missing unrepairable tooling, incompatible Node, registry/auth failures or unsupported pins remain environment BLOCKED. Do not ask the owner to install a user-local pinned manager that this deterministic command can prepare.

### Early feedback during implementation

**Every supplied `mode=affected` entry is a mandatory completion check.** The worker executes its exact allowlisted command from `advisory_checks[]`; the baseline binds the work item and source fingerprint. Example command *shape only* (use literal packet command, not constructed placeholders):

```text
gate-runner-cli.ts RUN PIPELINE GATE --advisory --affected --work-item WORK_ITEM_ID --baseline BASELINE_PATH --baseline-sha256 BASELINE_SHA256
```


For dispatched worker agents, the validated `pipeline-dispatch` packet contains `run_stage_rules_path`; **only the target worker reads that file**. The coordinator passes the packet/marker, not its content or expanded role instructions. Universal standalone-agent instructions remain unchanged.

Coordinator contract: each supplied `advisory_checks[]` entry is bound to a work item and is mandatory for successful CoderAgent completion; `stage-complete-cli` enforces identity, freshness and PASS. Advisory failures, failed edits, interrupted tests, unknown paths and no-progress diagnoses are resolved **within the current implementation attempt** without charging `fix-cycle`. Only a fresh negative independent CodeReviewer or authoritative machine gate triggers a charged repair. Never add an agent, probe permissions, or run full tests merely to validate an advisory packet. Consult `skills/task-management/gate-testing.md` for authoritative testing semantics.

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

**Architecture checkpoint control:** when `architecture_review_due` is present, `ARCHITECTURE_REVIEW_REQUIRED` blocks the next charged repair until `stage-cli architecture-review-record <run-id> <stage> --pipeline <id> --evidence <file>` succeeds with current evidence. This replaces repeated architecture agents with one relevant checkpoint, not a bypass of owner or security gates.

**Architecture checkpoint after repeated repairs.** A stage's next charged repair is blocked by `ARCHITECTURE_REVIEW_REQUIRED` after five charged cycles since the last **relevant** ArchitectureAnalyzer/class checkpoint; legacy records without proven coverage retain absolute 5/10/15 checkpoints. The relative clock requires review `covered_paths` including all current repair paths **and** at least one exact-SHA `dependency_files` entry; changed reviewed dependencies trigger the checkpoint early. CLI validates the path coverage/dependency hashes, never infers them from write scope. Run a fresh ArchitectureAnalyzer on the affected block, callers, dependencies and contracts. Record `kind: architecture_review` via `stage-cli architecture-review-record`; a documented `no_change` continues without another senior review, `apply_within_requirements` redesign is independently reviewed by SeniorTechnicalPlanReviewer, and `requirements_change` pauses that lane for the owner. For `apply_within_requirements` the CLI requires the **ready** senior verdict as `technical_review_artifact` (run-local, SHA recorded); a missing or negative verdict cannot release the checkpoint. Unrelated runnable lanes continue. A recorded class review of the same covered scope also satisfies this checkpoint; a review of another scope does not.

**Repeated defect class.** The CLI blocks the **third independently evidenced negative authoritative** CodeReviewer/gate result of a class before charging its next cycle (`CLASS_REVIEW_REQUIRED`). A/A and A/B/A count; identical SHA, advisory/transport results and optional-only findings do not. `root_cause_id` is a diagnostic hint, **not** proof of a different root cause or a waiver. On due: reuse validated applicable ExternalScout research or obtain current prior-art evidence → fresh ArchitectureAnalyzer root-cause assessment of affected code, callers, dependencies and contracts. The architect chooses `confirm_approach|rework_block|remove_mechanism|requirements_change`. **Only real redesigns require fresh SeniorTechnicalPlanReviewer**; `confirm_approach` needs fresh run-local diagnosis, verifiable implementation plan, justification and confirmed research relevance, not an invented architecture change. A repeat after confirmation requires new diagnostic evidence and a changed repair plan; repeat after redesign requires new research and a different design. Follow the exact artifacts/flag contracts in the agent instructions and `class-review-record` validator. The CLI requires a **ready**, run-local technical verdict only for `rework_block`/`remove_mechanism`; `requirements_change` is an owner checkpoint, not a speculative senior-review call. Record `stage-cli class-review-record <run-id> <stage> --pipeline <id> --evidence <class-review.json>`, then retry `fix-cycle` on the **same** negative result: a single consolidated repair, not a second charge or an owner amendment. Only changed requirements/security/external contract/destructive semantics go to the owner. Post one concise owner-visible warning on the verified cause and decision, and preserve other ready lanes.

**Carried PLAN findings.** When the manifest freezes `planning_readiness.carried_findings`, pass the file to every review of the affected work items; CodeReviewer treats each carried finding as an acceptance check of that lane. Post one `⚠` line after each recorded class review: which class, what changes in the approach, the research source.

When the fix-cycle budget is exhausted, the owner has three choices:

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

After any source-changing fix to an already published candidate: Git verify, rerun the frozen local fail-fast gates, publish a NEW candidate SHA, then rerun the candidate gate, `dev_deploy` and acceptance. The version stays the same; only the SHA changes. Evidence from the previous candidate is stale by construction and `stage-complete-cli` must reject it.

## Durable handover and context compaction

OpenCode already has automatic compaction. The pipeline runtime writes a compact **machine-derived index** under `.tmp/pipelines/<run-id>/handoffs/context/current.{json,md}` on meaningful existing RUN transitions **and before model compaction**. This is an index, never stage/owner/security authority. It includes current lanes, fix budgets, candidate/manifest hashes, active worker markers, amendments, blockers and evidence pointers. It does not paste whole logs, research or prompts into the coordinator's context and adds no model call or per-tool permission check.

On **resume**, read `handoffs/context/current.md` if present, then run the authoritative `stage-cli next <run-id> --json` (and check active leases/children through existing runtime mechanisms) before dispatch. Handover can be stale: only the current frozen manifest, `state.json`, canonical evidence and CLI decisions may authorize work; compaction cannot approve, complete, relaunch or skip a stage. To create a snapshot before an intentional stop when no transition has just occurred, use the allowlisted exact CLI:

```text
node $HOME/.config/opencode/skills/task-management/scripts/pipeline-handover.mjs <run-id>
```

`--check` returns `PASS|STALE|MISSING`, and neither mode modifies machine state. Do not call it after every ordinary shell/read/edit. Never infer a child's completion from a handover snapshot; a running child must settle through the existing runtime lease/wake authority.

## Status on request

When the owner asks for status, read `.tmp/pipelines/<run-id>/state.json` and `stage-cli next <run-id> --json` once and show lanes and work items (pipeline, stage, state, cycles `n/N`, blocker or `⚠` notes) as a compact `openchamber_render` page when that tool exists, otherwise as a table, in Russian. Do not dispatch or change anything for a status request.

## Status semantics

- `ready`: functional/acceptance gates through frozen `ready_after_stage` passed.
- `release_ready`: release/build/runtime gates through `release_ready_after_stage` passed.
- `completed`: every frozen stage, including pre-publish source documentation and post-validation non-source handoff/finalization, is completed/skipped with evidence.

Do not use natural-language completion to skip these state transitions. A pipeline may continue from `ready` or `release_ready` into later frozen stages.

Closing a RUN (every pipeline terminal, or a final owner stop) always ends with `node $HOME/.config/opencode/skills/task-management/scripts/reuse-report.mjs <run-id> .tmp/pipelines/<run-id>/reuse-report`. The final report cites `reuse-report/summary.json`: subagent session reuse (`agents`, `groups`, `fallback_reasons`) and gate evidence reuse (`gates`) as two separate figures, never summed, plus any `runtime` events, and spend from `usage`: tokens (input, output, cache read) and cost per role and per model, with the orchestrator as its own row. Name the three most expensive roles.

## GitHub Issue / PR handoff

Before successful handoff drain Issue status outbox:

```text
node /root/.config/opencode/skills/task-management/scripts/pipeline-github-sync.mjs sync <run-id>
```

Issue audit comments are append-only **per distinct pipeline lifecycle event**. A transition such as `planned -> approved` and a later `approved -> in_progress` are different outbox events and are posted as separate comments. Sync idempotency only prevents reposting the same event marker; it does not PATCH or coalesce earlier comments. If the same Issue is mapped to multiple pipelines, each pipeline can emit its own comments for the same run.

After every frozen stage is completed and `git-worktree-cli publish` produced PASS `candidate.json`, create/update the one delivery PR only through:

```text
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-pr-cli.ts create <run-id>
```

The deterministic PR boundary works for any RUN (Issue-mapped or not) and verifies frozen repository, completed Issue mapping when the RUN has one, non-default candidate branch, `candidate_sha == remote_sha`, and that every deployable pipeline's frozen `deployment_validation.stage` has PASS evidence for that **same final cumulative candidate SHA**; it writes close keywords for completed Issues and requires PR-link outbox `pending=0`. Never use free-form `gh pr create`, `gh api` or merge commands. Owner merges manually.

For a versioned run (`release.version`), the final report tells the owner to merge the PR with a **merge commit** (not squash or rebase), then run `/pipeline-release <run-id>`. It sets `vX.Y.Z` on the tested candidate. RUN never sets the final tag.

## Owner shell actions

Use the deterministic CLI that owns the operation. Owner shell intervention is allowed only on explicit `OWNER_ACTION_REQUIRED`, auth or permission blockers; model/tool-format inconvenience is not an owner task. Never hand the owner `rm`, `git add|commit|push`, exports of gate variables, install-root creation or generator runs: deletion of strays is `quarantine-strays`, identity/install roots come from the gate environment, staging/commit/push belong to `git_publish`. If a command needs a shell action only the owner can do, say in Russian exactly one command, why, and what RUN does meanwhile.

Follow-up issues of the run (out-of-scope findings, deferred work): **creating a GitHub Issue is a separate write decision.** Do it only when the owner explicitly requests creating that Issue, or an approved frozen work item explicitly requires the follow-up Issue. An owner asking for consequences, alternatives or risk analysis is not authorization to create an Issue. If not approved, record the finding locally in the RUN's handover/report and ask at an existing owner checkpoint, never blocking unrelated work. For authorized follow-ups: write the body to `.tmp/pipelines/<run-id>/follow-up-<name>.md` and create the issue with `gh issue create --repo <owner/repo> --title <title> --body-file .tmp/pipelines/<run-id>/follow-up-<name>.md` (`gh issue create` is `ask` in the installed role permissions; obtain the actual owner permission at execution time, including for an authorized work item; no labels/assignees beyond what the body states). Mention the issue number in the final report. Never use it for the delivery PR or to reopen/close existing issues.

## Owner skip

The owner may skip any stage. Only after the owner's explicit decision, write run-local evidence `{kind: "owner_skip", stage, pipeline_id, reason, owner_decision_required: true, owner_decision: "<owner's words>"}` and call `stage-cli owner-skip <run-id> <stage> --pipeline <id> --evidence <file>`. Before skipping an `agent`, `review` or `fail-fast` stage, say in one line what will not be done or verified. `--unattended` never skips a stage on its own (the only automatic skip is `ci_infra_waiver` under `github_ci_mode: optional`). List every skipped stage in the final report and the PR description. Runtime, deployment and install gates have no advisory mode: do not try to reach them through `--advisory`.

## Owner approval and unattended

`--unattended` skips interaction only inside the already-approved frozen scope. It does not approve decisions, changed scope/base/manifest/evidence, exceptions or merge. It also never auto-approves a runtime replan: `awaiting_owner_clarification` and `awaiting_owner_approval` are mandatory owner checkpoints.

When the owner asks for status or progress mid-RUN, run `stage-cli status <run-id> --chart` and paste its output as is in a code block; never draw the status yourself.

Owner-facing messages (questions, `⚠` lines, checkpoints, status, final report) are always in Russian, in plain functional language (what the user sees, what changes in testing or time), whatever `artifact_language` the artifacts use. When an owner decision is required and the owner does not answer, keep running every lane that does not depend on it and ask once; do not repeat the question or idle the RUN. With `openchamber_render` available, ask choices as a page with `awaitAnswer` (options as buttons, the last one always «Свой вариант» with a free-text field) and continue in the same turn; otherwise numbered plain-text options ending with «свой вариант».

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