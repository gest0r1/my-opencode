---
description: Design-freeze PLAN in the worktree selected by its owner; no session or branch creation
tags:
  - pipeline
  - planning
  - design-freeze
---

Before creating or starting any PLAN/RUN, call `pipeline_runtime_preflight`. Require PASS from live tools, skills, exact subagent IDs and delegation permissions. `PIPELINE_CAPABILITY_UNAVAILABLE` stops execution with its concrete missing capability. Never implement inline or widen write permissions to bypass unavailable delegation.


# Pipeline Planning — manually selected worktree

Build a design-freeze PLAN only. Never implement source changes, create a worktree/branch/session, switch checkout, rebase, merge, clean, reset or invoke `openchamber session.create`. Owner opens an existing worktree-session and invokes this command inside that session. Other worktrees may PLAN concurrently; only one RUN executes at a time.

`$ARGUMENTS` selects exactly one source mode: `--revise <run-id>` for a not-yet-implemented PLAN; same-repository Issue refs such as `#51 #47`; an existing task/plan file path; or free task text. Empty arguments are invalid. There is NO fallback to `docs/plan.md` and no OpenChamber linked-Issue source: GitHub Issues are selected explicitly with `#N`. `docs/pipeline-rules.md` remains the rules path; project rules take precedence and invalid rules BLOCK. PLAN and all delegated agents must never edit project or distribution rules.

For `--revise <run-id>`, use the existing folder. Before changing manifest or gate artifacts, write a fresh independent revision review containing the current `manifest_sha256`, `owner_contract_changed: true|false`, `affected_gates[]` and `reason`, then call `pipeline-reconcile-cli.ts revise-plan <run-id> --evidence <review-path>`. It rejects revision after any source-changing agent stage actually started. Replace stories/manifest/work items in place; repeat only invalidated gates, keeping unaffected ready artifacts. Never reset state manually. If owner scope/behavior/constraints changed, obtain approval again; technical corrections reuse the previous approval when the validated revised manifest is initialized. Log a short reason/gate list, not old story versions.

After implementation began, an incompatible replan uses `pipeline-reconcile-cli.ts inherit-replan <old-run-id> --new-run <new-run-id>`. The CLI copies stories/context/previous decisions/research to `planning/inherited/` only. Read them as historical context; rebuild all required gates. Never transfer old manifest/state/reviews/work-items/candidate/CI/deployment evidence as current validity. Old run remains intact. Compatible owner clarifications use RUN amendments instead.

All distribution CLI invocations use the current runtime user's `$HOME/.config/opencode/...`; never hard-code `/root/.config/opencode/...`.

## Preflight: inspect only

0. Resolve source first. For GitHub Issue mode use only:

```text
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-issue-cli.ts probe <issue-number>...
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-issue-cli.ts show <issue-number>...
```

The GitHub Issue itself is authoritative; PLAN persists normalized semantic evidence via `pipeline-reconcile-cli.ts snapshot-source <run-id>` after writing the draft manifest and before initialization. GitHub remains authoritative; `planning/source-requirements.json` is only the planning baseline for future diff. Freeze the returned repository/source Issue metadata and semantic `requirements_sha256` as `source_requirements_sha256`. The digest covers Issue title/body and human comments while excluding pipeline-owned audit/planning comments. Immediately before design freeze, run the same `probe` again and require the digest to equal the value used for planning. Do not substitute anonymous GitHub HTML/API requests, `webfetch`, free-form `curl` or `github_handoff_probe`.

1. `git-worktree-cli.ts inspect`: require owner-created linked worktree, non-default branch, valid local main and clean tracked checkout. Verify `.tmp/pipelines/` is ignored; tracked pipeline state BLOCKS.
2. Record exact worktree directory, branch, HEAD and local main SHA in `git_setup.base_sha`; require main ancestor of HEAD. `stage-cli.ts rules docs/pipeline-rules.md --json` must PASS. PLAN never mutates Git.
3. Inspect repository policy only through `stage-cli.ts policy --json`. If `.opencode/pipeline-policy.json` exists, freeze the returned path+SHA-256 in `project_policy`; v2 preflight enforces protected paths and triggered project gates.
4. If project policy declares `deployment_target.kind=opencode_host`, run `deployment-target-cli.ts inspect {run-id} --policy .opencode/pipeline-policy.json` as a **capability probe**. It dispatches the trusted GitHub probe workflow, validates the protected Environment/trusted ref, verifies required Environment secret names without reading values, and requires the configured probe job to PASS. On READY freeze `planning/deployment-target.json` path+SHA-256 as `deployment_target_check`. Probe failure does not by itself kill PLAN: it makes only GitHub-initiated `opencode_host` CD unavailable for this run and must be shown to the owner. Local `hybrid` CD does not depend on this probe. Agents never receive raw `gh`/SSH credentials or SSH permission.

   The trusted probe workflow contract is deterministic: `workflow_dispatch` with required `pipeline_run_id`, `run-name` containing that input, explicit read-only GitHub permissions, the frozen `probe_job` bound to the protected Environment, and SHA-pinned third-party actions. For `transport=github_ssh`, the job must reference every frozen Environment secret name and execute non-interactive SSH with `BatchMode=yes` and `StrictHostKeyChecking=yes`. For `transport=self_hosted_runner`, `runs-on` must include `self-hosted` plus every frozen runner label. The CLI reads this workflow from the frozen trusted ref, never from candidate source.

5. `git_setup` contains `base_sha` and `branch`, optional `must_absent`, but no `source_sha` or `checkout_paths`.

## Planning gate protocol

Planning gates are sequential. A gate advances only on literal `status: ready`. A later gate never makes an earlier `needs_revision` gate pass.

Strict order: one gate at a time. A reviewer never runs while its artifact is still changing, and only the artifact's author agent edits it (OpenStage never edits stories or architecture itself; it passes findings to the author). Collect ALL findings of one review into ONE revision before the next review.

For each triggered gate:
1. run a fresh planning/review agent;
2. persist append-only evidence (stories themselves are the only stable/mutable planning artifacts);
3. if `ready`, freeze path+SHA-256 and advance;
4. record EVERY review verdict, ready or not, with `stage-cli plan-review <run-id> <gate> --evidence <review> [--defect-class <a,b>]`; the ledger, not OpenStage, counts cycles. Its JSON output names the `next` step; follow it without waiting for the owner unless it is `owner_decision`:
   - `revise`: the author revises and the SAME gate is re-reviewed. Up to **3 autonomous revisions** go this way.
   - `research_then_rework` (`PLAN_RESEARCH_REQUIRED` on the next review): a defect class came back in consecutive verdicts, or 3 revisions did not converge. Run ExternalScout on the class or on the non-converging section (`planning/research/class-<key>-v<N>.md` or `planning/research/escalation-<gate>-v<N>.md`), record it with `stage-cli plan-review <run-id> <gate> --research <file>`, then have a FRESH author session rework the whole section with that research and all open findings, not the cited lines; review that rework in full.
   - `revise_or_carry`: after the escalation rework, findings that are still technical (no decision or business-story change) are not a reason to stop. Revise once more if the fix is clear; otherwise write `planning/carried-findings-<gate>.md` (each finding, its class, the affected work items, how RUN must verify it) and record it with `--carry <file>`. Freeze it in `planning_readiness.carried_findings` with its SHA-256; TaskManager attaches each carried finding to its work items as an explicit check, and CodeReviewer verifies them in RUN.
   - `full_review`: a delta review said ready; the gate is frozen only on a FULL fresh review (`review_scope: full`).
   - `owner_decision`: a finding classified `replan`/`security_stop`/`scope_stop`/`secret_stop`/`destructive_stop` changes a decision or a business story; go to step 5.
   Delta re-reviews go to `FindingsReviewer` (cheaper model, `review_scope: delta`) with the previous verdict and the author's list of changed sections; full reviews stay with SeniorStoryReviewer/SeniorTechnicalPlanReviewer. Re-reviews may be `review_scope: delta` (previous findings + the author's list of changed sections + every place that references them); the first review and the review that freezes the gate are `review_scope: full`, always in a fresh session;
5. if an owner decision is required, ask only the questions that block the CURRENT gate, with context, consequences and a recommendation, in plain functional language (see Owner questions below); STOP;
6. after the owner answers, update the decision register and rerun the SAME gate fresh;
7. `blocked` (a missing capability or fact) or `owner_decision` stops; nothing else does. Renaming a gate, splitting one review into "sync"/"confirm" rounds or freezing a smaller `cycles` number does not reset the count: preflight binds each frozen `gates.<gate>.review` to the ledger's last verdict, which must be a full ready review or one whose findings were carried. The orchestrator may not reinterpret a blocker as belonging to a later gate.

Numbers, wording or line-reference slips are `nit` in the reviews: the author fixes them in the next revision, they never cost a review round of their own. Architecture and contracts have one author each and never restate each other: the contract inventory references architecture sections instead of re-describing behaviour; when both must change, the architect goes first and ContractManager applies only the listed deltas. OpenStage never edits a planning artifact itself.

Default gate order when triggered:
1. stories + SeniorStoryReviewer;
2. architecture;
3. contracts;
4. SeniorTechnicalPlanReviewer;
5. work-item compilation;
6. final manifest approval.

Owner may request a different presentation language. Freeze it as `planning_readiness.artifact_language`; all subsequent stories/reviews/evidence for that run use the same language. Existing review evidence is immutable: translation creates a new/versioned artifact, never overwrites a review.

## Planning-agent artifact contract

Every planning/review child receives:
- exact `artifact_path` (or explicit stable story paths);
- `artifact_language`;
- compact input paths/decision IDs.

Every child returns only:

```text
status: ready | needs_revision | blocked
blockers:
- <short blocker, if any>
artifacts:
- <path>
```

A child must write its own evidence. The parent must not reconstruct a child artifact from chat text. If the child cannot write the authorized artifact path, the gate is `blocked` until the permission/path contract is corrected.

Planning/review sessions are always fresh. Subagents do not delegate further agents. Allowed research tools may clarify concrete external facts directly; missing project context or broad research returns to OpenStage, which calls ContextScout/ExternalScout/WebResearcher and reruns only the affected gate fresh.

## Design-freeze

0. **Owner decisions before design.** Right after reading the source (and the context packet), collect in ONE plain-language message, each with a recommendation and a "свой вариант" option, every decision that changes the architecture: delivery strategy and whether GitHub Actions minutes are available (the capability matrix of step 7 is built from preflight facts; ask the choice now, not after the architecture); the release version (and the milestone it belongs to); which issues are in scope; target contours of any install/deploy; the default behaviour of every command or installer the change alters (what happens with no flags, what happens when something is missing or broken); and any user-visible behaviour the issue leaves open. Record the answers in `decision-register.md`. ArchitectureAnalyzer does not start while any of these, or any story question, is open. A late owner change to one of them is a revision with its affected gates, not another review round.

1. Collect project context once through ContextScout into a compact packet of exact relevant paths. Fetch again only on a documented gap. ContextScout also looks one level up from each touched module for other implementations of the same concept (integration-level drift) and lists them in the packet.
   Record the union of actual repository paths consumed by planning in `planning_scope[]`. Existing `planning_inputs` is read for legacy RUNs; new PLANs do not need per-gate read-sets. Use exact paths or `directory/**` only. These paths are the deterministic read-set used by `/pipeline-replan`; do not substitute broad writable scope when a narrower read-set is known.
2. Select only triggered planning gates: StoryMapper/SeniorStoryReviewer for user-facing behavior; ArchitectureAnalyzer for architecture/cross-module; ContractManager for interfaces; ExternalScout for current external technology/security/migration facts; SeniorTechnicalPlanReviewer for material risks. PrioritizationEngine only on explicit owner prioritization.
   **Own mechanisms are researched before design.** Whenever the change would make the project write a mechanism itself (format/archive/image handling, a parser or validator of a standard format, a protocol or API client, integrity/crypto, an installer/update flow, a scheduler, a cache, retry/backoff, a check that re-reads what the project's own code produces), ExternalScout runs its own-mechanism check after the stories and before ArchitectureAnalyzer, one row per mechanism with sources and supported versions. This is not optional for such changes: it is the cheapest gate and the one that prevents whole repair loops later. ArchitectureAnalyzer's `own_mechanisms` section and SeniorTechnicalPlanReviewer's `missing_prior_art` check build on it.
   Within the existing ExternalScout technology-evidence gate, research applicable libraries/GitHub approaches before the architect chooses a solution when a material external technical choice is involved. Reuse valid evidence; simple known-pattern edits need no new research. Apply ExternalScout's escalation criteria: OpenStage calls WebResearcher with question, comparison criteria, existing evidence and a versioned `planning/research/**` artifact_path, then provides that artifact to ExternalScout/ArchitectureAnalyzer. The child writes its own artifact. Have ExternalScout consolidate material findings and source provenance from supporting research into the final technology-evidence artifact; freeze that file as the existing `required_artifacts.technology_evidence` and map its research IDs/reference path to affected work items. Supporting raw reports alone are not frozen authority; no new stage or unconditional gate. Before selected research or direct clarification, call `pipeline_runtime_preflight` with `research_agents` containing the actual roles; verify returned capabilities and actual source fetch results. No-source success is not research PASS.
3. Maintain stable Issue story files `stories/issue-N.md`; owner corrections rewrite the same story. Reviews are append-only/versioned.
4. Collect ALL unresolved owner decisions in `decision-register.md`. Each decision records its owning planning gate and status. Never omit a decision to make validation pass or self-authorize it.
5. Compile prerequisites and conflicts into a DAG. Freeze `exclusive_paths`, `migration_paths`, `fixture_paths` and/or `conflict_group` where relevant. Pipelines sharing such conflict metadata must be serialized by dependencies. A pipeline referenced by another pipeline's `depends_on` MUST define `ready_after_stage` at the source-ready boundary: all source-mutating `agent` work and its required CodeReviewer/review must be complete by that stage, and no source-mutating `agent` stage may appear after it. Runtime dependency satisfaction uses this milestone, not full CI/CD completion. Runtime locks are only for genuinely shared external mutable targets.

   Wall-clock is decided here. The scheduler runs one stage at a time inside a pipeline and independent pipelines in parallel, so a batch of issues folded into one long pipeline runs strictly serially. Split the batch into source-only lanes (one pipeline per issue or work block) whose `allowed_change_paths` do not overlap, each ending at its `ready_after_stage`, and let the one integrated delivery sink depend on all of them. Files several lanes must touch (shared test configs, CI workflows, `Dockerfile`, lockfiles) belong to the sink or to an explicit conflict group, never to two parallel lanes. Every source lane ends `implementation -> review` (executor `review`, fresh CodeReviewer on that lane's diff) and sets `ready_after_stage: review`, so findings arrive per lane and in parallel; the sink's review checks only cross-lane interaction. The repository rule "one task touches 1-2 test blocks" is only a size estimate; for hub files it never forces tests out of the item that changes the product, and TaskManager/reviewers must not demand both. Each lane owns the tests of its own work items, including new live suites and their registration in the project's inventory (inventory tests that existing code breaks belong to `test_rework[]`); do not plan test-only sink items ("regressions", "testing metadata") for tests a lane can write itself. A pre-existing red suite found by the base probe gets its own first baseline-repair lane (its work item carries `"baseline_repair": true`) that the others depend on only if they need it green.
6. Create binary acceptance criteria and minimal **base** `allowed_change_paths` for the approved implementation components/config/docs. Do not attempt to enumerate every future test/fixture/mock path: RUN adds machine-owned test/support scope only for sibling files of an exact test/support path already in scope, files under a `test_rework[]` entry's directory, and concrete test/support paths inside an already-approved `apps/<name>` or `packages/<name>` component; protected/sensitive paths are never extended. Tests that must change are NOT left to this extension: they are listed in `test_rework[]` (below) and their exact paths are in base scope. Base scope syntax is exact path or `directory/**` only; wildcard forms such as `eslint.config.*` are invalid. Protect `.git`, rules, secrets, workflow trust boundaries and environment files.
   **Test rework (mandatory step, inside the architecture/test-strategy and work-item gates; no new gate).** ArchitectureAnalyzer finds, with the repository's own generator/check commands where they exist, the existing tests the change will break or slow: (a) inventory/pin/registry tests asserting lists, counts or order of what the run changes; (b) selection-budget thresholds of a generated test map that the new tests would exceed (recompute with the frozen generator check, not by hand); (c) tests already near their time limit or flaky under parallel load (for example a cold module import inside the test body); (d) tests that prove a helper instead of the user path. Freeze each in manifest `test_rework: [{id, path, action, reason, work_item_id}]` (`action` = `update | split | rewrite | add | move_setup | remove`; `path` is an exact repository path inside base `allowed_change_paths`; `work_item_id` is a frozen work item of a pipeline with `test_preparation: true`). Those items form the first lane, a pipeline with `test_preparation: true` and `deployable:false` plus `ready_after_stage`; every other pipeline with an `agent` stage depends on it, so RUN starts there. Never raise a test timeout or budget limit; rework the test (split it, move module loading/heavy setup out of the timed body, rewrite it on the user path). Preflight rejects violations with `TEST_REWORK_*` codes.

   **Behavior scenarios.** Every user path in the acceptance criteria gets a scenario test on the real production entry (route, handler, worker job) with only the provider transport stubbed; a test of a helper alone does not cover it. When the repository has a mutation/behavior-cell checker, its command is a frozen gate command so RUN never needs owner shell. A manual check replaces a scenario only by explicit owner decision stated in plain words.

   **Single owner and data model.** ArchitectureAnalyzer names the single module that owns each concept the change touches (delivery plan, links, keyboards, identity, ...); the reuse/drift review checks composition owners as well as helpers. Before designing on existing data it records the data model the feature builds on (what is stored in which column for each creation path). Shared code is adopted in the lane that changes the shared code, never deferred to the sink.

   **Release version.** When the project ships a `VERSION`/version file or release milestone, ask the owner once for the release version and freeze the version bump as a work item in the lane or sink that owns release files.

7. Classify every pipeline explicitly as `deployable: true|false`. When several issue/work-block pipelines compose one delivered product, upstream feature pipelines are source-only (`deployable:false`) and end at their source-ready boundary; put one integrated delivery chain only on the terminal DAG sink. The canonical cost-aware chain is:

   ```text
   implementation/review
     -> git_verify
     -> local fail-fast gates
     -> git_publish exact candidate SHA
     -> one lean artifactless GitHub CI on that exact SHA
     -> optional local or remote CD/runtime validation
     -> optional owner acceptance
   ```

   Local fail-fast gates use the existing `local_gate`/`gate-runner-cli` contract and should absorb test/lint/typecheck/build plus expensive fresh-install, repeat/upgrade-install, runtime/E2E/smoke checks when those checks are deterministic on the OpenCode machine. Place them after `git_verify` and before `git_publish`, so an existing post-publication fix cycle that reopens from `git_verify` also reruns the local validation before another candidate is pushed. A local PASS reduces GitHub minutes but never replaces the independent final GitHub CI of a deployable sink.

   **CI parity before publication.** GitHub Actions minutes are scarce (free plan) and each failed candidate costs a full reopen-review-gates-publish round, so the final CI should pass on its first run. Freeze a pre-publish `local_gate` (for example `ci-parity`) that repeats locally what every required job of the final workflow does: image/distribution build, fresh install, upgrade install, secret scan and any other required step, with the same commands where possible. When a work item adds a build or installer input (an asset referenced by the web build, a new workspace, a file the `Dockerfile` must copy), the parity gate must include `docker build` (or the project's image build) so a missing `COPY` fails locally. Keep the final CI artifactless and run it once per candidate; never add an early "advisory" CI run to save local time.

   **Equivalence and migration checks early.** When a lane changes migrations, schema snapshots or a schema-equivalence harness, freeze that equivalence check as an advisory impact group of the same lane, so a mismatch is fixed inside the lane instead of first failing the terminal gate.

   **Target state.** For `hybrid` and `opencode_host`, read the current state of every target contour that a post-CI gate will update (installed version, migration ledger, data presence) with an existing read-only command, record it in the plan, and design the update path for each state found. A contour that the approved policy would refuse is an owner decision at PLAN time, not a surprise in the last gate. For post-publish gates that need the candidate SHA or install on a contour, verify contour readiness read-only and that the gate gets its inputs from the gate environment.

   For source-changing CoderAgent pipelines, also apply the frozen early-test contract in `skills/task-management/gate-testing.md`. When an existing deterministic local check applies, assign the source pipeline the shared profile and freeze `gate_testing[profile][gate].impact_groups`, including transitive consumers. This creates only advisory `--affected` checks during implementation; it does not add another `local_gate` stage or duplicate authoritative final validation. If no applicable deterministic check exists, do not invent one. Mark heavy whole-repository commands (type-check, lint, build, complete suites) as `coordinator_only` so workers iterate on the impacted test files only, and freeze `parallel_groups` for independent commands of the complete gate (see `gate-testing.md`). Declare derived files the RUN must rebuild as `generators: [{id, write, check, outputs}]` (repository script or package script, no shell) and other generator outputs as `generated_paths`; RUN runs them with `stage-cli generate`, and scope-check authorizes their outputs. Keep each frozen command array free of repeated commands and of commands that only narrow another one to test files (`GATE_COMMAND_REDUNDANT` blocks preflight before init). When the repository generates its own impact map, ArchitectureAnalyzer names it and the command array it indexes in the architecture artifact, and PLAN binds it with `stage-cli gate-testing-freeze` before preflight; never copy or rewrite a generated map by hand. Test-time limits stay as they are: workers run only impacted tests, full sets are coordinator/final only, and slow or flaky tests are fixed through `test_rework[]`.

   **Gate inputs come from the gate environment.** Every gate command gets `PIPELINE_RUN_ID`, `PIPELINE_ID`, `PIPELINE_GATE`, `PIPELINE_GATE_ATTEMPT`, `PIPELINE_SCRATCH_DIR` (fresh empty directory, never inside the source tree) and, for authoritative gates with a candidate, `CANDIDATE_SHA` (see `gate-testing.md`, "Gate environment and PLAN probe"). Freeze gate commands so identity, install roots and disposable resources come from these variables and `gate_testing` test resources, never from the owner shell. A gate is pre-publish when every pipeline that freezes it on that profile runs it before `git_publish` (or has no `git_publish`) and its name has no deploy/smoke; pre-publish gates may carry test resources such as `live_postgres` whatever their name, and are the ones the PLAN probe covers. Post-publish gates (dev-install, release checks needing the candidate) receive `CANDIDATE_SHA`/`PIPELINE_SCRATCH_DIR` at RUN time.

   Build a capability matrix and present exactly three owner choices with an advisory recommendation:
   1. `github` — local fail-fast first, then final GitHub CI; no OpenCode-host CD stage;
   2. `opencode_host` — local fail-fast, final GitHub CI, then the existing trusted GitHub-driven stateful `github_dev` CD to the OpenCode host; this special mode requires the READY deployment-target probe;
   3. `hybrid` — local fail-fast, final GitHub CI, then a frozen post-CI `local_gate` installs/updates the exact `candidate_sha` on the OpenCode/dev host and runs smoke; owner acceptance is added only when requested.

   In the same question ask the GitHub CI mode and freeze it per deployable pipeline as `github_ci_mode`: `required` (default; an infrastructure blocker stops for the owner), `optional` (CI runs; if GitHub does not start it — billing, spending limit, no runner — the stage is skipped with a ⚠ warning and RUN continues; a code failure still blocks), or `off` (no `github_ci` stage; `deployment_validation.stage` is the authoritative local `ci-parity`/`fail-fast` `local_gate`). Recommend `optional` on a free GitHub plan and `required` for release branches.

   The LLM may recommend a mode and explain the trade-offs, but **must not choose it**. Record the owner's choice as a resolved decision ID and freeze `testing_strategy` with `mode`, `owner_decision_id`, `github_validation_stage`, optional `opencode_host_stage`, and `post_deploy_test=automated|user|automated_then_user` when runtime validation exists. Only `opencode_host` requires `deployment_target_check` and an active trusted stateful `github_dev` workflow.

   Unless `github_ci_mode` is `off`, every deployable sink freezes `deployment_validation.stage` as the final artifactless `github_ci` stage for the exact published candidate SHA. `fresh_job`/`upgrade_job` are legacy optional metadata only; fresh/repeat-install validation belongs in deterministic local gates unless the project has a concrete reason to keep it in GitHub. If owner testing is selected, append an `owner_acceptance` stage after successful CD/runtime validation; generic `complete` cannot satisfy it.
8. Freeze one concrete **artifactless** GitHub Actions contract for the final CI. Prefer `.opencode/pipeline-policy.json#github_actions.ci` when present; otherwise inspect an existing compatible workflow. Candidate CI must have explicit read-only permissions, no repository/environment secrets, no `paths`/`paths-ignore` trigger filters, SHA-pinned third-party actions, an exact terminal job and only the `required_jobs[]` needed for independent CI assurance. Do not duplicate expensive fresh/upgrade/runtime work merely because it already ran locally. Canonical candidate CI MUST NOT use `actions/upload-artifact` or `actions/download-artifact`; provenance is the exact `candidate_sha`, workflow run/attempt and required-job evidence. If final CI is missing/incompatible, use the existing bootstrap/adaptation mechanism (`.github/workflows/pipeline-ci.yml` + `pipeline_ci`) and keep it lean.

   `github_dev`, `deployment-target-cli`, trusted Environment/ref and deferred `future_github_gates` remain supported only for the special GitHub-initiated `opencode_host` path. Ordinary `hybrid` post-CI CD is a `local_gate` and needs no new CLI, raw SSH/Docker permission or deployment-target probe.

   Release packaging is separate from candidate CI/CD. If the target project already produces a releasable package/container/binary, preserve its release workflow and run it only for the actual release/tag/explicit release event; publish deliverables directly as GitHub Release/package-registry assets rather than using Actions artifacts as durable storage. Do not invent a universal release workflow when the project has no release product.
9. Before manifest freeze call TaskManager. It builds the `test_preparation` lane and its `test_rework` work items first, then the source lanes (shared-code adoption stays in the lane that changes the shared code). It writes atomic work items under `.tmp/pipelines/{run-id}/work-items/**`; freeze every work-item ID, path and SHA-256 in the manifest. Each pipeline maps its own work-item IDs and defines `decision_ids`, `research_ids`, `contract_ids`. A candidate CI bootstrap/adaptation work item and any deferred future stateful DEV workflow work item must be mapped to the same pipeline and their exact workflow paths must be inside `allowed_change_paths`; prefer narrow paths over `.github/workflows/**`. An **active** trusted stateful DEV workflow must remain outside candidate change scope. A `future_github_gates` workflow is allowed in change scope only because it cannot execute in the current run.
10. Mandatory planning artifacts are `decision-register.md` and the work-item index; the final architecture is already frozen as the required `architecture` gate artifact and is not duplicated in `required_artifacts`. `technology-evidence.md` is frozen only when external research was actually required; `contract-inventory.md` is frozen only when an interface/data/CLI/event contract was materially changed. Test strategy and accepted risks live inside the final architecture artifact rather than separate mandatory files. Obtain hashes only through:

```text
stage-cli.ts artifacts {run-id} <run-relative-path>... --json
```

Freeze exactly the returned path+SHA-256 pairs. Do not use free-form `sha256sum` or model-computed hashes.


For GitHub Issue sourced PLANs, after all required planning gates and deterministic preflight pass and the owner explicitly approves the design freeze, publish the frozen Story/Architecture comments idempotently:

```text
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-issue-cli.ts publish-plan {run-id}
```

A document longer than one GitHub comment (65 536 characters; the CLI keeps under 65 000) is posted as numbered parts "Pipeline Architecture (i/N)", split at `##` sections, so never shorten the frozen architecture to fit. A publish failure BLOCKS initialization/handoff; it must not alter the requirements digest because pipeline-owned artifact comments are excluded.

## Manifest schema v2

New PLANs MUST use `schema_version: 2`, `planning_mode: "design-freeze"` and:

- rules version recorded at approval for initial consistency; RUN later adopts externally changed live rules metadata without rewriting the manifest;
- `git_setup`, base `allowed_change_paths`, `freshness_sensitive_paths`, and frozen per-gate `planning_inputs`; runtime scope extensions are machine-owned RUN state and are never written back into the manifest;
- pipelines/DAG, source-ready `ready_after_stage` on every depended-on pipeline, explicit `deployable`, one integrated delivery sink per delivered product where practical, mandatory `deployment_validation` + owner-selected `testing_strategy` for deployable sinks, artifactless active `github_gates[stage_id]`, deferred `future_github_gates`, explicit `executors[stage_id]` including `owner_acceptance`, shared local `gate_profiles`, frozen `gate_testing` where the early-test contract applies (see `skills/task-management/gate-testing.md`), conflict metadata and work-item mappings;
- `planning_readiness.design_freeze: true`;
- `planning_readiness.required_gates[]` and a `ready` evidence record for every required gate;
- path+SHA-256 for every gate artifact/review and required planning artifact;
- `open_decisions: []` before init;
- frozen `work_items[]` with path+SHA-256;
- optional frozen `project_policy` reference when repository policy exists;
- frozen `deployment_target_check` evidence only for GitHub-initiated `opencode_host` CD.

GitHub Issue mode additionally freezes `repository`, `source_issues[]`, `planning_base_sha`, per-pipeline `issue_numbers[]` and semantic `source_requirements_sha256`. Manifest schema version 2 is the only supported pipeline manifest format.

## Mandatory execution-gate contract

Every schema-v2 stage has exactly one explicit executor: `agent | review | local_gate | git_verify | git_publish | github_ci | github_dev | owner_acceptance`. Never infer execution mode from the stage name during RUN.

Repository test/build/typecheck/lint/install/runtime checks may use `local_gate`; for deployable sinks PLAN should place the deterministic fail-fast set after `git_verify` and before `git_publish`. The deployable sink still requires one final `github_ci` stage after publication for the exact candidate SHA. When that final CI is unavailable, PLAN must bootstrap/adapt the project workflow rather than fall back to local-only delivery validation.

For every `github_ci`/`github_dev` stage freeze `github_gates[stage_id]` with:
- repository workflow path under `.github/workflows/*.yml|yaml`;
- terminal job ID and only the `required_jobs[]` needed by that gate;
- trigger (`push` for first-time/bootstrap candidate CI, `workflow_dispatch` for already trusted dispatched workflows);
- final `github_ci` is artifactless; legacy artifact fields remain accepted only for existing compatible contracts and are not the canonical design;
- for the special `opencode_host` `github_dev`: `source_ci_stage`, stateful mode, `target_id`, environment, trusted ref and non-cancelling `concurrency_group`;
- `bootstrap_required` + frozen `bootstrap_work_item_id` for candidate CI adaptation, or inside `future_github_gates` for a stateful remote-CD workflow that is authored now but becomes executable only after merge to the trusted ref.

Before freeze inspect the proposed project workflow:

```text
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-actions-gate-cli.ts inspect <workflow> <terminal-job> --trigger <push|workflow_dispatch> [--artifact <name>] [--required-job <job>]... [--executor github_ci|github_dev] [--mode stateful --environment <env> --trusted-ref <ref> --concurrency-group <group>]
```

TestEngineer/DevOps author the test/resource contract and transitive consumer coverage inside the approved work items; independent planning review checks it. Keep full required commands in `gate_profiles`; diagnostic filters never replace them. Missing impact coverage falls back to full tests. Do not retrofit frozen RUN manifests.

For `local_gate`, `gate-runner-cli` still runs from project root with `shell:false`; one command-array item is one executable plus argv. No `cd`, `&&`, pipes, redirects, `$()` or stage-time dependency bootstrap/resolution. `local_gate` stages require a pipeline `profile`; source-only CoderAgent pipelines may also carry the same shared profile solely when frozen `gate_testing` impact groups define advisory `--affected` checks. That advisory profile reuse does not create a stage or authoritative gate.

Respect the repository package manager for local JS gates. If `package.json#packageManager` or a lockfile declares pnpm/npm/yarn/bun, local JS gates must use that manager. Missing tooling is an environment BLOCK, never a fallback to another manager or dependency-installing `npx --yes`. For a project containing both `pyproject.toml` and `uv.lock`, local pytest gates use `uv run --frozen ...`.

**PLAN probe.** After the draft manifest and gate freeze, and before owner approval, run for every pipeline `profile` and every pre-publish `local_gate` that has no `{candidate_sha}` and is not a runtime gate (deploy/smoke):

```text
gate-runner-cli.ts --plan-probe .tmp/pipelines/{run-id}/manifest.json <pipeline-id> <gate>
```

It needs a clean checkout (`BASE_PROBE_REQUIRES_CLEAN_CHECKOUT`), runs the complete frozen command set with the gate environment and writes `.tmp/pipelines/{run-id}/planning/probes/<pipeline>-<gate>.json` (`kind: plan_probe`, `commands_sha256` of the frozen commands). Pipelines sharing profile+gate may share one probe. PASS is required; any later change to those frozen commands needs a new probe. FAIL means a red baseline: add a `baseline_repair: true` work item on that profile (the only case where FAIL passes preflight) or fix the gate contract. BLOCKED never passes: fix the gate contract (missing env, resources, install root) before approval. `plan-run-preflight` and `run-preflight` reject a missing, stale or non-PASS probe with `PLAN_PROBE_REQUIRED: <pipeline>/<gate>` and print the command. A PASS probe at the same clean HEAD also satisfies the RUN base-probe requirement.

Before presenting owner approval run the **same executable contract that RUN will depend on**, while no state exists yet:

```text
stage-cli.ts plan-run-preflight .tmp/pipelines/{run-id}/manifest.json --environment
git-worktree-cli.ts adopt .tmp/pipelines/{run-id}/manifest.json
git-worktree-cli.ts verify .tmp/pipelines/{run-id}/manifest.json
```

All three must PASS. `plan-run-preflight` accepts only schema version 2. `verify` must prove that the complete current branch diff is either the frozen preserved baseline or inside writable `allowed_change_paths`; do not defer a baseline/scope mismatch until RUN. Preflight verifies planning evidence hashes, frozen work items, project policy/conflict serialization, explicit executor coverage, GitHub gate/bootstrap contracts and package-manager contract only for `local_gate`. Before `init`, deterministic manifest corrections remain the same draft/run-id and are simply revalidated; after `init`, use the trusted revise-plan lifecycle until implementation starts; after first implementation start, never mutate that manifest.

## Preservation, migration and replan

Canonical results stay under `.tmp/pipelines/{run-id}/`. Deterministic tools own `state.json`, locks, candidate and machine evidence. Never manually edit runtime state; before implementation use revise-plan to authorize in-place manifest changes.

When PLAN intentionally continues existing committed implementation from an older/legacy run, first call:

```text
git-worktree-cli.ts baseline <planning-base-sha>
```

Freeze its exact `head_sha`, sorted `changed_paths[]` and `diff_sha256` as `preserved_baseline`. Those files are allowed to remain exactly as they were at the preserved HEAD, but that does **not** grant the new RUN permission to edit them. Any post-baseline change to such a path must still match `allowed_change_paths`. This is the canonical V1→V2/existing-implementation migration contract.

Lifecycle rule: before the first actual source-agent start, all plan corrections/replanning stay in this folder via `revise-plan`. Afterwards, compatible amendments stay in the current RUN, while incompatible replan uses `inherit-replan` and a new PLAN with historical context only. Never hand-copy run directories, clone approved reviews/work-items as current validity, or use the legacy `stage-cli supersede` cloning path for new replans.

## Owner approval — mandatory stop

For a new PLAN or owner-contract-changing revision, present gate readiness, branch/main SHA, manifest, DAG with the maximum number of lanes running at once, scope, hashes, risks and run ID. Then STOP.

**Owner questions and approval text.** Write every owner question and the approval summary in plain functional language: what the user will see or get, what changes in testing and time, what the choice costs. No decision codes, gate names or flags without a one-phrase meaning. When the `openchamber_render` tool is available, present the approval (and each multi-option question) as a page with `awaitAnswer`, options as buttons, and continue in the same turn on the answer; otherwise use plain text with numbered options. The explicit approval message requirement below is unchanged. A technical-only `--revise` with previous approval and `owner_contract_changed=false` instead runs normal preflight/adopt/verify/init; init restores approved status, so do not ask for approval again or invoke approve on the already-approved state.

Only AFTER a separate explicit owner message approving this exact v2 manifest/run ID, with every owner decision resolved and every required planning gate `ready`, run:

```text
stage-cli.ts plan-run-preflight .tmp/pipelines/{run-id}/manifest.json --environment
git-worktree-cli.ts adopt .tmp/pipelines/{run-id}/manifest.json
git-worktree-cli.ts verify .tmp/pipelines/{run-id}/manifest.json
stage-cli.ts init .tmp/pipelines/{run-id}/manifest.json
stage-cli.ts approve {run-id}
node $HOME/.config/opencode/skills/task-management/scripts/pipeline-github-sync.mjs sync {run-id}
stage-cli.ts validate {run-id} --json
stage-cli.ts next {run-id} --json
```

The initial PLAN invocation never runs init/approve. `--unattended` and reviewer approval are not owner approval. Approval sync for Issue runs must finish with `pending=0`. GitHub audit delivery is event-oriented, not a sticky-status comment: `init` queues a separate `created -> planned` event for every mapped pipeline and `approve` queues a separate `planned -> approved` event. `pipeline-github-sync` posts each distinct event as its own idempotent Issue comment; it does not edit the previous comment, and one Issue mapped to several pipelines may therefore receive several audit comments from one PLAN approval sequence.

After approval, show a concrete recommended RUN command **and** the available option template so the owner does not have to remember flags. Example:

```text
Recommended:
/pipeline-run {run-id} --unattended

Available options:
/pipeline-run {run-id} [--unattended] [--fix-cycles <5..20>] [--no-session-reuse]
```

If the owner has said they will be away or wants a larger autonomous repair window, recommend a concrete higher ceiling, for example `/pipeline-run {run-id} --unattended --fix-cycles 10`. Do not choose a higher ceiling without that context. Never invoke RUN automatically.


PR CI requires an existing PR number frozen as `github_gates.<stage>.pr_number` with `trigger: pull_request`. Use authenticated GitHub/CLI to inspect private PRs. The PR head must equal the published candidate; head/merge mapping is verified by the deterministic gate. Workflow bootstrap uses push.


## Freeze boundary and owner clarifications

Owner may clarify in the current session at any time. Before implementation starts, refine this PLAN in the same folder. Frozen runtime starts at the first `stage-cli start` whose executor is `agent` (source implementation, including bootstrap), not at approval, command invocation, preflight, reconciliation or review. After that boundary keep manifest immutable and use accepted amendments. File/component/work-unit count is never a reason for full replan by itself. A new PLAN is required after start only for an incompatible business/architecture/external-contract/security/destructive boundary or an unresolved owner decision.


## Executable completeness before approval

Use frozen work-item files as the single source for dependencies and interface/schema references; derive the index and `pipelines[].work_items` summaries from the complete catalog, including bootstrap/release work. Existing PLAN preflight rejects unbound items, duplicate mappings, missing/cyclic dependencies and incorrect in-pipeline order. Every implementation item needs an agent executor; review packets derive from stages and do not require separate synthetic tasks.

The existing technical review must trace mandatory acceptance checks to executable frozen gate commands, including live services/database suites. Missing prerequisites/suites or skipped mandatory tests must fail in the project test runner; a generic passing test command is insufficient. For source-changing CoderAgent work with applicable deterministic checks, require the frozen shared profile + `gate_testing` impact groups defined by `skills/task-management/gate-testing.md`; if no applicable deterministic check exists, do not invent one. Advisory execution never replaces final gates. It also checks that `test_rework[]` is complete (inventory/pin tests, selection budgets, near-limit/cold-import tests, helper-only tests), that every acceptance-criteria user path has a scenario test on its real production entry and the repository's mutation checker is a frozen gate command, that every pre-publish gate has a PASS plan probe, that post-publish gates take inputs from the gate environment, and that a release version work item exists when the project versions releases. Refer to exact contract/schema paths and symbols instead of duplicating their definitions across work items.
