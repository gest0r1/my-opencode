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

`$ARGUMENTS` selects exactly one source mode: `--revise <run-id>` for a not-yet-implemented PLAN; `--milestone <title|number>` for every open Issue of a milestone; same-repository Issue refs such as `#51 #47`; an existing task/plan file path; or free task text. Empty arguments are invalid. There is NO fallback to `docs/plan.md` and no OpenChamber linked-Issue source: GitHub Issues are selected explicitly with `#N`. `docs/pipeline-rules.md` remains the rules path; project rules take precedence and invalid rules BLOCK. PLAN and all delegated agents must never edit project or distribution rules.

A single fully double-quoted `$ARGUMENTS` value (for example `"7"` or `"v0.6.6"`) is shorthand for `--milestone <title|number>`. Inspect the **raw, trimmed `$ARGUMENTS`**, preserving the quotes: only when the entire argument is enclosed in one matching pair of double quotes, with non-empty content and no extra arguments, remove that outer pair and use the existing milestone lookup. Resolve this before treating the argument as a file path or free task text. Do not interpret unquoted `7` as a milestone; `#N`, `--milestone` and `--revise` keep their existing meanings. Empty or mixed quoted arguments are invalid; never silently reinterpret them as text. OpenCode `$ARGUMENTS` retains the typed quotes; do not use `$1` for this distinction.

For `--revise <run-id>`, use the existing folder. Before changing manifest or gate artifacts, write a fresh independent revision review containing the current `manifest_sha256`, `owner_contract_changed: true|false`, `affected_gates[]` and `reason`, then call `pipeline-reconcile-cli.ts revise-plan <run-id> --evidence <review-path>`. It rejects revision after any source-changing agent stage actually started. Replace stories/manifest/work items in place; repeat only invalidated gates, keeping unaffected ready artifacts. Never reset state manually. If owner scope/behavior/constraints changed, obtain approval again; technical corrections reuse the previous approval when the validated revised manifest is initialized. Log a short reason/gate list, not old story versions.

After implementation began, an incompatible structural PLAN replan defaults to an explicitly owner-authorized **in-place unfreeze of the same RUN**, not another plan. See `/pipeline-run` and `pipeline-unfreeze-cli.ts begin|finalize`: the authorized artifact scope, reviewed manifest SHA, selective dependency invalidation, and re-approval are mandatory. An owner-chosen new RUN or a failed safe-closure proof may still use `pipeline-reconcile-cli.ts inherit-replan <old-run-id> --new-run <new-run-id>` as a fallback. Never transfer old evidence as current validity. Compatible owner clarifications continue through ordinary RUN amendments.

All distribution CLI invocations use the current runtime user's `$HOME/.config/opencode/...`; never hard-code `/root/.config/opencode/...`.

## Preflight: inspect only

0. Resolve source first. For `--milestone` or the fully double-quoted milestone shorthand, first run `$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-issue-cli.ts milestone <title|number>`. Its `issue_numbers` are the Issue refs of this PLAN. Its `version` is the release version: freeze `release: {version, milestone: {number, title}}` in the manifest. Candidates carry no tag; `vX.Y.Z` is set on the accepted candidate by `/pipeline-release`. Never ask the owner about the version and never choose another one. `status: BLOCKED` stops PLAN with its `conflicts[]` quoted as they are: the owner fixes the milestone (name, tag, VERSION) and PLAN starts again. For GitHub Issue mode use only:

```text
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-issue-cli.ts probe <issue-number>...
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-issue-cli.ts show <issue-number>...
```

The GitHub Issue itself is authoritative; PLAN persists normalized semantic evidence via `pipeline-reconcile-cli.ts snapshot-source <run-id>` after writing the draft manifest and before initialization. GitHub remains authoritative; `planning/source-requirements.json` is only the planning baseline for future diff. Freeze the returned repository/source Issue metadata and semantic `requirements_sha256` as `source_requirements_sha256`. The digest covers Issue title/body and human comments while excluding pipeline-owned audit/planning comments. Immediately before design freeze, run the same `probe` again and require the digest to equal the value used for planning. Do not substitute anonymous GitHub HTML/API requests, `webfetch`, free-form `curl` or `github_handoff_probe`.

1. `git-worktree-cli.ts inspect`: require owner-created linked worktree, non-default branch, valid local main and clean tracked checkout. Verify `.tmp/pipelines/` is ignored; tracked pipeline state BLOCKS.
2. Run `git-worktree-cli.ts sync-plan`: it fast-forwards local main to origin/main and merges main into the PLAN branch (never reset, rebase or force). Do not ask the owner to update main or the branch; stop only on `SYNC_PLAN_CONFLICT`, `SYNC_PLAN_DIRTY`, `SYNC_PLAN_MAIN_CHECKOUT_DIRTY` or `SYNC_PLAN_LOCAL_MAIN_DIVERGED`, quoting the error. Then record exact worktree directory, branch, HEAD and local main SHA in `git_setup.base_sha`; require main ancestor of HEAD. `stage-cli.ts rules docs/pipeline-rules.md --json` must PASS. Apart from `sync-plan`, PLAN never mutates Git; after `stage-cli init` only `sync-main <manifest>` syncs.
3. Inspect repository policy only through `stage-cli.ts policy --json`. If `.opencode/pipeline-policy.json` exists, freeze the returned path+SHA-256 in `project_policy`; v2 preflight enforces protected paths and triggered project gates.
4. If project policy declares `deployment_target.kind=opencode_host`, run `deployment-target-cli.ts inspect {run-id} --policy .opencode/pipeline-policy.json` as a **capability probe**. It dispatches the trusted GitHub probe workflow, validates the protected Environment/trusted ref, verifies required Environment secret names without reading values, and requires the configured probe job to PASS. On READY freeze `planning/deployment-target.json` path+SHA-256 as `deployment_target_check`. Probe failure does not by itself kill PLAN: it makes only GitHub-initiated `opencode_host` CD unavailable for this run and must be shown to the owner. Local `hybrid` CD does not depend on this probe. Agents never receive raw `gh`/SSH credentials or SSH permission.

   The trusted probe workflow contract is deterministic: `workflow_dispatch` with required `pipeline_run_id`, `run-name` containing that input, explicit read-only GitHub permissions, the frozen `probe_job` bound to the protected Environment, and SHA-pinned third-party actions. For `transport=github_ssh`, the job must reference every frozen Environment secret name and execute non-interactive SSH with `BatchMode=yes` and `StrictHostKeyChecking=yes`. For `transport=self_hosted_runner`, `runs-on` must include `self-hosted` plus every frozen runner label. The CLI reads this workflow from the frozen trusted ref, never from candidate source.

5. `git_setup` contains `base_sha` and `branch`, optional `must_absent`, but no `source_sha` or `checkout_paths`.

## Story and behavior-delta approval (OpenChamber, all source modes)

The owner makes product decisions **in OpenChamber**, not in GitHub Issue
comments. For every user-facing baseline Story, after a fresh full
SeniorStoryReviewer verdict and **before** architecture, show a compact
`Как сейчас | Как будет | Как проверить` table and the material exceptions.
Obtain an explicit separate owner response: «Утвердить» / «Есть замечания» /
«Свой вариант». Use the existing `openchamber_render` with `awaitAnswer`
when available; otherwise ask in the current interactive session. Never treat
the agent's summary, an unanswered question, an independent reviewer or
`--unattended` as owner approval.

Before the review, obtain the Story's **actual SHA-256 from the existing
deterministic artifacts command**; the review must bind the path and SHA.
After the owner's answer, record in the existing `decision-register.md`
the `run_id`, artifact path, exact Story SHA, full reviewer verdict path/SHA,
decision (`approved` / `rejected`), and the explicit owner's response,
without inventing a GitHub comment ID or a second approval index.
A rejected or corrected baseline returns to StoryMapper and a **fresh full**
SeniorStoryReviewer; only the freshly approved SHA can move to architecture.
The approval record is a workflow audit record, **not an independently
authenticated transcript**: no native OpenChamber user-message read-back
API has been verified. Do not claim independent proof of authorship.

If architecture proposes changed user behavior, StoryMapper writes a
versioned `planning/story-deltas/**` artifact linked to the approved baseline.
Show only the architect-proposed changed behavior to the owner and obtain
explicit approval/rejection in OpenChamber **before** the technical review.
Run the existing SeniorTechnicalPlanReviewer (not SeniorStoryReviewer) for
approved deltas to independently check the proposal, exact SHA and consent.
Record delta path/SHA, architect's decision ID, review reference (for approved
deltas), owner response and the ordered accepted/rejected disposition in
`decision-register.md`. **Effective Story**
= approved baseline + only accepted deltas in order. Rejected deltas must not
reach the work items, contracts, tests or owner acceptance. A changed SHA,
missing approval, or conflict between deltas returns to the affected gate;
never silently reuse approval from an older version.

GitHub Issue / milestone / text / file / revise inputs remain supported:
do not block Story approval solely because the PLAN is not sourced from
GitHub Issues. Technical-only Issues bypass the intermediate Story checkpoint.
The existing final design-freeze owner approval remains a **separate**
OpenChamber answer.

**GitHub comments are automatic publication, not approval.** For
`github_issues` sourced PLANs the existing `publish-plan` posts frozen
Stories/Architecture to source Issues after final approval, and
`pipeline-github-sync` posts lifecycle/PR audit events. Keep both mechanisms
and exclude only pipeline-owned comments from semantic requirements SHA;
normal human comments still change requirements. Version artifact comments
by exact artifact SHA: same version is idempotent, changed versions append
comments without rewriting the past. Never ask the owner to post JSON into
GitHub as a condition of proceeding.

A **technical-only Issue** does not invoke StoryMapper, SeniorStoryReviewer or
the intermediate owner checkpoint. If it unexpectedly needs new behavior,
ask the owner to authorize that product scope first; if rejected, omit the
behavior or stop with a concrete blocker. Do not start architect/StoryMapper
on unapproved new requirements.

When ArchitectureAnalyzer changes user-visible behavior, **always** trigger
the existing SeniorTechnicalPlanReviewer (not SeniorStoryReviewer) to
independently check the exact delta SHA against the architect proposal,
baseline, owner approval, testable AC and reuse/drift. ContractManager stays
conditional on interface changes. Keep technical-only and no-architecture
runs on existing lightweight triggers.

## Planning gate protocol

Planning gate **finalization** follows dependency order: an artifact freezes only on literal `status: ready` plus a complete fresh review where required. An independent draft/research task may run concurrently once all of its own upstream inputs are frozen. A later gate never makes an earlier `needs_revision` gate pass. Do not enforce global serial execution on unrelated authoring: after accepted behavior and architecture, ContractManager may author its interface inventory while TestEngineer independently evaluates testability, test levels and data/environment risks. Contract-dependent test assertions wait until ContractManager's interface artifact is ready. One author per artifact; one frozen SHA for each reviewed artifact. No new required gate, review round or copy of the StoryMapper scenario document. When TestEngineer PLAN actually runs, freeze its approved, resolved assessment path + SHA under the **optional existing** `planning_readiness.required_artifacts.test_assessment` reference; the normal manifest preflight and SeniorTechnicalPlanReviewer then bind the assessment to the accepted behavior/contract. Do not create this artifact/ref for low-risk plans.

Strict order **within each dependency chain**, not across unrelated draft work: a reviewer never runs while its artifact is still changing, and only the artifact's author agent edits it (OpenStage never edits stories or architecture itself; it passes findings to the author). Collect ALL findings of one review into ONE revision before the next review.

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

Default **freeze/approval dependency order** when triggered:
1. StoryMapper baseline + SeniorStoryReviewer + owner approval (technical-only: technical AC, no StoryMapper);
2. targeted ExternalScout for unresolved external/own-mechanism facts, ArchitectureAnalyzer + any approved behavior deltas;
3. after the architecture artifact, **concurrently where independent**: ContractManager authoring (interface trigger) and TestEngineer PLAN read-only testability assessment (material behavior/contract/regression/integration risk), each in a separate artifact. TestEngineer does not approve contract-specific cases before the interface is frozen. Low-risk local tasks omit the TestEngineer PLAN call entirely;
4. SeniorTechnicalPlanReviewer on the ready architecture, relevant contract and test assessment (if triggered), not on half-written drafts. No extra plan-review gate solely for TestEngineer;
5. TaskManager compiles dependency-aware vertical work items, then existing manifest/review validation;
6. final manifest owner approval.
Existing `plan-review` ledger semantics, frozen gate artifacts and senior review criteria remain authoritative. Parallelism applies to drafting independent inputs, not to an unreviewed artifact being treated as ready.

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

0. **Prove current behavior before owner questions or design.** Read the complete source Issue body plus material human comments (not just titles), then require a compact factual comparison for each affected scenario in the existing planning inventory/context artifact: current route or handler and data invariant (verified path/symbol), current regression test/FACT, requested Issue behavior, proposed **delta** and only then whether an owner decision is necessary. When a current rule is already settled, preserve it by default; do not ask the owner to select an invented exception. Mark unknowns explicitly. Technical-only Issues get technical AC, not fabricated user Stories. A new behavior that is unsupported by issue text, code or an explicit owner answer is not a requirement. If evidence is missing, ask ContextScout only for the gap and keep its existing packet/index.
   **Owner decisions before design.** Only after that baseline inventory and context packet, collect in ONE plain-language message, each with a recommendation and a "свой вариант" option, every decision that changes the architecture: how the owner accepts the delivery (`post_deploy_test` of step 7) and the dev contour key; the release version (and the milestone it belongs to); which issues are in scope; target contours of any install/deploy; the default behaviour of every command or installer the change alters (what happens with no flags, what happens when something is missing or broken); and any user-visible behaviour the issue leaves open. Record the answers in `decision-register.md`. ArchitectureAnalyzer does not start while any of these, or any story question, is open. A late owner change to one of them is a revision with its affected gates, not another review round.

1. Collect project context once through ContextScout into a compact packet of exact relevant paths. The OpenStageOrchestrator's mandatory ContextScout pre-dispatch validation applies to each requested destination. ContextScout can write multiple separate planning documents (for example `planning/drift/**`), with `planning/context-packet.md` a concise index rather than the single writable artifact. When an architecture/cross-module gate is triggered, after required baseline approvals ask the same ContextScout to **extend that existing packet** with a short map of shared concepts, candidate owners, distant consumers, tests and uncertainty. Link focused supporting planning documents from the packet; do not duplicate the packet or run a broad rescan. Fetch again otherwise only on a documented gap. ContextScout also looks one level up from each touched module for other implementations of the same concept (integration-level drift) and lists them in the packet.
   Record the union of actual repository paths consumed by planning in `planning_scope[]`. Existing `planning_inputs` is read for legacy RUNs; new PLANs do not need per-gate read-sets. Use exact paths or `directory/**` only. These paths are the deterministic read-set used by `/pipeline-replan`; do not substitute broad writable scope when a narrower read-set is known.
2. Select only triggered planning gates: StoryMapper/SeniorStoryReviewer for user-facing behavior; ArchitectureAnalyzer for architecture/cross-module; ContractManager for interfaces; ExternalScout for current external technology/security/migration facts; SeniorTechnicalPlanReviewer for material risks. PrioritizationEngine only on explicit owner prioritization.
   **Own mechanisms are researched before design.** Whenever the change would make the project write a mechanism itself (format/archive/image handling, a parser or validator of a standard format, a protocol or API client, integrity/crypto, an installer/update flow, a scheduler, a cache, retry/backoff, a check that re-reads what the project's own code produces), ExternalScout runs its own-mechanism check after the stories and before ArchitectureAnalyzer, one row per mechanism with sources and supported versions. This is not optional for such changes: it is the cheapest gate and the one that prevents whole repair loops later. ArchitectureAnalyzer's `own_mechanisms` section and SeniorTechnicalPlanReviewer's `missing_prior_art` check build on it.

    **PLAN owner checkpoint for an unjustified custom mechanism (not a new gate).** After the existing ArchitectureAnalyzer artifact, inspect `custom_mechanism_assessment` for every material custom mechanism (`justified | unjustified | uncertain`). An `unjustified` verdict requires a concise owner choice **keep the nonstandard design vs simplify/remove it** with the verified alternative, affected approved AC, additional states/contracts/tests/recovery/maintenance, and plausible RUN/release delay. A material `uncertain` verdict requires a missing decisive fact or the owner choice. Before work-item freeze record the source/version, verdict, simpler recommendation and explicit answer in the existing `decision-register.md`; link the same choice in the architecture and in `technology_evidence` where present. Rerun only the affected existing architecture/technical reviews if the chosen approach changes. Never silently remove approved behavior, claim no alternative based on failed search, or introduce another gate. A justified common solution proceeds without an extra owner question; no monetary ROI calculation.

   Within the existing ExternalScout technology-evidence gate, research applicable libraries/GitHub approaches before the architect chooses a solution when a material external technical choice is involved. Reuse valid evidence; simple known-pattern edits need no new research. Apply ExternalScout's escalation criteria: OpenStage calls WebResearcher with question, comparison criteria, existing evidence and a versioned `planning/research/**` artifact_path, then provides that artifact to ExternalScout/ArchitectureAnalyzer. The child writes its own artifact. Have ExternalScout consolidate material findings and source provenance from supporting research into the final technology-evidence artifact; freeze that file as the existing `required_artifacts.technology_evidence` and map its research IDs/reference path to affected work items. Supporting raw reports alone are not frozen authority; no new stage or unconditional gate. Before selected research or direct clarification, call `pipeline_runtime_preflight` with `research_agents` containing the actual roles; verify returned capabilities and actual source fetch results. No-source success is not research PASS.
3. Maintain stable Issue baseline story files `stories/issue-N.md` only for user-behavior Issues; technical-only Issues retain technical AC without invented Stories. Reviews are append-only/versioned; the final full baseline review lists every reviewed Story's path and SHA. Owner changes to a baseline require a fresh Story review and human approval, not silent in-place reuse. Architecture-induced behavior changes are immutable versioned delta files, and require fresh human confirmation and SeniorTechnicalPlanReviewer (not a repeated SeniorStoryReviewer).
4. Collect ALL unresolved owner decisions in `decision-register.md`. Each decision records its owning planning gate and status. Never omit a decision to make validation pass or self-authorize it.
5. Compile prerequisites and conflicts into a DAG. Freeze `exclusive_paths`, `migration_paths`, `fixture_paths` and/or `conflict_group` where relevant. Pipelines sharing such conflict metadata must be serialized by dependencies. A pipeline referenced by another pipeline's `depends_on` MUST define `ready_after_stage` at the source-ready boundary: all source-mutating `agent` work and its required CodeReviewer/review must be complete by that stage, and no source-mutating `agent` stage may appear after it. Runtime dependency satisfaction uses this milestone, not full CI/CD completion. Runtime locks are only for genuinely shared external mutable targets.

   Wall-clock is decided here. The scheduler runs one stage at a time inside a pipeline and independent pipelines in parallel, so a batch of issues folded into one long pipeline runs strictly serially. Split the batch into source-only lanes (one pipeline per issue or work block) whose `allowed_change_paths` do not overlap, each ending at its `ready_after_stage`, and let the one integrated delivery sink depend on all of them. Files several lanes must touch (shared test configs, CI workflows, `Dockerfile`, lockfiles) belong to the sink or to an explicit conflict group, never to two parallel lanes. Every source lane ends `implementation -> review` (executor `review`, fresh CodeReviewer on that lane's diff) and sets `ready_after_stage: review`, so findings arrive per lane and in parallel; the sink's review checks only cross-lane interaction. The repository rule "one task touches 1-2 test blocks" is only a size estimate; for hub files it never forces tests out of the item that changes the product, and TaskManager/reviewers must not demand both. Work items of one lane are dispatched together in waves: two items whose `allowed_change_paths` overlap (a shared registry, hub file or test directory) must be ordered by `depends_on`, the later item naming the earlier, and preflight rejects them otherwise (`WORK_ITEM_SCOPE_OVERLAP`). Put an order stated in the architecture into `depends_on`; prose alone does not reach RUN. Each lane owns the tests of its own work items, including new live suites and their registration in the project's inventory (inventory tests that existing code breaks belong to `test_rework[]`); do not plan test-only sink items ("regressions", "testing metadata") for tests a lane can write itself. A pre-existing red suite found by the base probe gets its own first baseline-repair lane (its work item carries `"baseline_repair": true`) that the others depend on only if they need it green.
6. Create binary acceptance criteria and minimal **base** `allowed_change_paths` for the approved implementation components/config/docs. Do not attempt to enumerate every future test/fixture/mock path: RUN adds machine-owned test/support scope only for sibling files of an exact test/support path already in scope, files under a `test_rework[]` entry's directory, and concrete test/support paths inside an already-approved `apps/<name>` or `packages/<name>` component; protected/sensitive paths are never extended. Tests that must change are NOT left to this extension: they are listed in `test_rework[]` (below) and their exact paths are in base scope. Base scope syntax is exact path or `directory/**` only; wildcard forms such as `eslint.config.*` are invalid. Protect `.git`, rules, secrets, workflow trust boundaries and environment files.
   **Existing-test preparation errors.** Treat any `TEST_REWORK_*` manifest preflight failure as a broken frozen test ownership/consumer contract, not permission to remove checks or skip the required prep lane.\n   **Existing-test preparation (no new gate).** ArchitectureAnalyzer owns the inventory of existing tests requiring rework (registries/pins, generated impact-map limits, flaky/slow tests, helper-only assertions) and supplies paths/action/reasons; TaskManager freezes each as `test_rework: [{id, path, action, reason, work_item_id, required_by}]` with `action=update|split|rewrite|add|move_setup|remove`. Each exact `path` must be inside base `allowed_change_paths`, owned by a frozen `test_preparation:true, deployable:false` lane/work item. `required_by` names actual consumers, or `[]` if none; independent lanes must not wait for irrelevant prep. Existing legacy manifests retain their frozen dependencies. A pre-existing RED baseline is repaired by the separate baseline-repair work item; never raise timeouts to hide failing tests.

   **Test-first implementation (risk-based).** StoryMapper's approved scenario/AC IDs and frozen contracts are the sole test intent. TaskManager determines whether the materially risky behavior/integration needs independent TestEngineer: freeze RED and GREEN work items **on the same consuming agent stage/lane**, with CoderAgent's `depends_on` and `test_first_work_item_id` pointing to the TestEngineer work item. The CLI records the pre-RED source identity and requires that CoderAgent's bound affected PASS covers the new tests; RED itself is diagnostic, not a new failing gate/owner checkpoint. For low-risk local work freeze only CoderAgent with self-TDD. Future-feature tests are not placed in prep lanes or run before source-ready producers; existing behavior's independent `test_rework` remains separate.

   **Behavior scenarios.** Freeze references to the single StoryMapper scenario/AC inventory, not another test specification. ArchitectureAnalyzer owns coverage levels; TestEngineer owns executable checks. The project's scenario/mutation checker, if present, is a frozen gate. Manual-only replacement requires explicit owner approval.

   **Single owner and data model.** Use ArchitectureAnalyzer's verified canonical owners, data model and reuse/drift decisions. Adopt shared code in its owning lane, not in the delivery sink.

   **Release version.** When the project ships a `VERSION`/version file or release milestone, ask the owner once for the release version and freeze the version bump as a work item in the lane or sink that owns release files.

7. Classify every pipeline explicitly as `deployable: true|false`. Upstream feature lanes are source-only (`deployable:false`) and end at their source-ready boundary. Every PLAN with `release` (a `--milestone` PLAN) has exactly one deployable pipeline, the terminal DAG sink, and it ends with this fixed delivery tail; preflight refuses anything else with `DELIVERY_TAIL_REQUIRED`:

   ```text
   integration implementation/review
     -> git_verify                        (git_verify)
     -> local fail-fast gate              (local_gate; optional when the candidate gate covers it)
     -> publish the exact candidate SHA   (git_publish)
     -> candidate gate                    (local_gate = deployment_validation.stage: the full frozen set on that
                                           commit; every command that passed on the same bytes is reused)
     -> install on the dev contour        (dev_deploy)
     -> optional smoke                    (local_gate with post-install checks: health, installed version)
     -> owner acceptance                  (owner_acceptance)
   ```

   Freeze `github_ci_mode: "off"`, `deploy_target` (the owner's dev contour key: `svd1` unless the owner named another) and `testing_strategy: {mode: "hybrid", owner_decision_id, github_validation_stage: <candidate gate>, opencode_host_stage: <dev_deploy stage>, post_deploy_test: "user" | "automated_then_user", owner_acceptance_stage: <acceptance stage>}`. GitHub Actions are not used: GitHub holds the code, the PR and the release assets only. The version comes from the milestone once: the sink's first work item sets the project's version file (for example `VERSION`) to `release.version` when it differs; candidates are identified by their SHA and carry no tag until `/pipeline-release` tags the accepted one, so a fix after the owner's findings is a new SHA of the same version. With the environment checked, preflight requires the contour to be described by root (`DEPLOY_TARGET_NOT_CONFIGURED` names the missing `/etc/opencode/deploy-targets/<key>.conf`); name that one-time root action in the approval question instead of finding it at the end. The owner chooses `post_deploy_test` (`user`: manual acceptance only; `automated_then_user`: smoke first); the LLM may recommend but **must not choose it**, and records the answer as `owner_decision_id`. A PLAN without `release` may keep every pipeline source-only.

   Local gates absorb test/lint/typecheck/build and, when they are deterministic on this machine, fresh-install, upgrade-install and image builds, so a missing build input (an asset the web build references, a file the `Dockerfile` must copy) fails before publication.

   For source-changing CoderAgent pipelines, also apply the frozen early-test contract in `skills/task-management/gate-testing.md`. When an existing deterministic local check applies, assign the source pipeline the shared profile and freeze `gate_testing[profile][gate].impact_groups`, including transitive consumers. This creates only advisory `--affected` checks during implementation; it does not add another `local_gate` stage or duplicate authoritative final validation. If no applicable deterministic check exists, do not invent one. Mark heavy whole-repository commands (type-check, lint, build, complete suites) as `coordinator_only` so workers iterate on the impacted test files only, and freeze `parallel_groups` for independent commands of the complete gate (see `gate-testing.md`). Declare derived files the RUN must rebuild as `generators: [{id, write, check, outputs}]` (repository script or package script, no shell) and other generator outputs as `generated_paths`; RUN runs them with `stage-cli generate`, and scope-check authorizes their outputs. Keep each frozen command array free of repeated commands and of commands that only narrow another one to test files (`GATE_COMMAND_REDUNDANT` blocks preflight before init). When the repository generates its own impact map, ArchitectureAnalyzer names it and the command array it indexes in the architecture artifact, and PLAN binds it with `stage-cli gate-testing-freeze` before preflight; never copy or rewrite a generated map by hand. Test-time limits stay as they are: workers run only impacted tests, full sets are coordinator/final only, and slow or flaky tests are fixed through `test_rework[]`.

   **Gate inputs come from the gate environment.** Every gate command gets `PIPELINE_RUN_ID`, `PIPELINE_ID`, `PIPELINE_GATE`, `PIPELINE_GATE_ATTEMPT`, `PIPELINE_SCRATCH_DIR` (fresh empty directory, never inside the source tree) and, for authoritative gates with a candidate, `CANDIDATE_SHA` (see `gate-testing.md`, "Gate environment and PLAN probe"). Freeze gate commands so identity, install roots and disposable resources come from these variables and `gate_testing` test resources, never from the owner shell. A gate is pre-publish when every pipeline that freezes it on that profile runs it before `git_publish` (or has no `git_publish`) and its name has no deploy/smoke; pre-publish gates may carry test resources such as `live_postgres` whatever their name, and are the ones the PLAN probe covers. Post-publish gates (the candidate gate, smoke, release checks) receive `CANDIDATE_SHA`/`PIPELINE_SCRATCH_DIR` at RUN time.

   **Equivalence and migration checks early.** When a lane changes migrations, schema snapshots or a schema-equivalence harness, freeze that equivalence check as an advisory impact group of the same lane, so a mismatch is fixed inside the lane instead of first failing the terminal gate.

   **Target state.** Read the current state of the dev contour the tail will update (installed version, migration ledger, data presence) with an existing read-only command, record it in the plan, and design the update path for each state found. A contour the approved policy would refuse is an owner decision at PLAN time, not a surprise in the last stage.
8. Release packaging stays in the project. If the project builds releasable assets (images, packages), keep its release command for `/pipeline-release`; never use GitHub Actions or their artifacts.
9. Before manifest freeze call TaskManager. It builds the `test_preparation` lane and its `test_rework` work items with explicit real `required_by` consumers, then independently runnable source lanes (shared-code adoption stays in the lane that changes the shared code). It writes atomic work items under `.tmp/pipelines/{run-id}/work-items/**`; freeze every work-item ID, path and SHA-256 in the manifest. Each pipeline maps its own work-item IDs and defines `decision_ids`, `research_ids`, `contract_ids`. A candidate CI bootstrap/adaptation work item and any deferred future stateful DEV workflow work item must be mapped to the same pipeline and their exact workflow paths must be inside `allowed_change_paths`; prefer narrow paths over `.github/workflows/**`. An **active** trusted stateful DEV workflow must remain outside candidate change scope. A `future_github_gates` workflow is allowed in change scope only because it cannot execute in the current run.
For new PLANs, set `work_item_output_contract_version: 1` to require docs-only DocWriter work items to declare frozen output paths; existing frozen manifests without this marker remain compatible.

**Early O10 static check, after TaskManager has written provisional work items and before closing owner review:** write a minimal draft manifest with `planning_readiness.design_freeze: false` and the exact frozen work-item path/SHA references, then run `stage-cli.ts preflight <draft-manifest.json>` once. Require `DRAFT_READY` (never interpret it as final approval), resolve any `WORK_ITEM_OUTPUT_*`, `AGENT_POLICY_*`, unsafe gate command, or work-item dependency errors in PLAN without a review/fix-cycle. This command uses existing local validators and no models, test suites, installation or GitHub calls. The later complete design-freeze manifest must still pass the full mandatory `plan-check` and owner approval. For docs-only `DocWriter` work items freeze nonempty exact `required_outputs[]` inside source/work-item scope; do not assign machine-owned `.tmp/pipelines/**` as DocWriter output.

10. Mandatory planning artifacts are `decision-register.md` and the work-item index; the final architecture is already frozen as the required `architecture` gate artifact and is not duplicated in `required_artifacts`. `technology-evidence.md` is frozen only when external research was actually required; `contract-inventory.md` is frozen only when an interface/data/CLI/event contract was materially changed. The conditional TestEngineer PLAN assessment, when executed, is frozen only as optional `planning_readiness.required_artifacts.test_assessment` with its SHA; never add a separate required gate. Test strategy and accepted risks live inside the final architecture artifact rather than separate mandatory files. Obtain hashes only through:

```text
stage-cli.ts artifacts {run-id} <run-relative-path>... --json
```

Freeze exactly the returned path+SHA-256 pairs. Do not use free-form `sha256sum` or model-computed hashes. After any work item, required artifact or carried-findings file changes, run `stage-cli.ts manifest-refresh .tmp/pipelines/{run-id}/manifest.json` instead of editing hashes: it rewrites those SHA-256 values from disk and refuses (`GATE_ARTIFACT_CHANGED_AFTER_REVIEW`) when a reviewed gate artifact changed, which needs `plan-review` again. `plan-check` fails on a stale hash, so run `manifest-refresh --check` first when unsure.


For GitHub Issue sourced PLANs, after all required planning gates and deterministic preflight pass and the owner explicitly approves the design freeze **in OpenChamber**, publish the frozen Story/Architecture comments automatically. Only triggered artifacts are published (Story-only, architecture-only, or both); a PLAN without either is a valid no-op:

```text
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-issue-cli.ts publish-plan {run-id}
```

A document longer than one GitHub comment (65 536 characters; the CLI keeps under 65 000) is posted as numbered parts "Pipeline Architecture (i/N)", split at `##` sections, so never shorten the frozen architecture to fit. Versioned markers bind **run ID + Issue + artifact type + SHA** (and part number when split): repeat calls do not duplicate a version, while a changed SHA gets a new comment. Existing older comments stay visible. A publish failure BLOCKS initialization/handoff; it must not alter the requirements digest because pipeline-owned artifact comments are excluded.

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

Every schema-v2 stage has exactly one explicit executor: `agent | review | local_gate | git_verify | git_publish | dev_deploy | owner_acceptance` (`github_ci`/`github_dev` remain only for runs frozen before; new plans do not use them). Never infer execution mode from the stage name during RUN.

Repository test/build/typecheck/lint/install/runtime checks use `local_gate`; for the deployable sink PLAN places the deterministic fail-fast set after `git_verify` and before `git_publish`, and the candidate gate after it validates the exact published SHA.

ArchitectureAnalyzer identifies test levels/coverage requirements, ContractManager the affected interface invariants, TestEngineer (only when risk warrants it) investigates technical edge cases, fixtures and RED feasibility in a **distinct concise assessment**, and DevOps describes actual gate environment/resources. TaskManager references these outputs in approved work items: no duplicate test plan, no second AC document. The existing independent planning review checks their consistency. Keep full required commands in `gate_profiles`; diagnostic filters never replace them. Missing impact coverage falls back to full tests. Do not retrofit frozen RUN manifests.

**Prove that post-publish test gates are executable before asking the owner to approve the PLAN.** A pre-publish plan probe cannot run a future candidate's install/upgrade, so do not claim it does. For an install/upgrade gate, inventory the actual existing entrypoint, required prior release artifact/credentials, database/test isolation, cleanup/recovery, denied-path tests and the producing work item (if the entrypoint is to be built in this RUN). Use the existing `gate_testing[profile][gate].input_kind` and, for isolated `candidate-contour`, the existing supervised `lifecycle` contract from #60: `validateGateTesting` rejects a missing/invalid lifecycle without a second bespoke harness. The planning technical reviewer must match every mandatory install/upgrade requirement to a concrete executable command and available or **frozen-to-be-produced** dependency. If such a dependency is missing, BLOCK or revise the same PLAN before owner approval; do not convert the inability to test into permission to delete/skip the test. Limit this to reading declared metadata and existing probes—**no extra full install, no second PLAN gate or model, no heavy runtime test before the candidate exists**. Record the factual readiness and remaining candidate-only checks in the existing test strategy/technical review artifact.

For `local_gate`, `gate-runner-cli` still runs from project root with `shell:false`; one command-array item is one executable plus argv. No `cd`, `&&`, pipes, redirects, `$()` or stage-time dependency bootstrap/resolution. `local_gate` stages require a pipeline `profile`; source-only CoderAgent pipelines may also carry the same shared profile solely when frozen `gate_testing` impact groups define advisory `--affected` checks. That advisory profile reuse does not create a stage or authoritative gate.

Respect the repository package manager for local JS gates. If `package.json#packageManager` or a lockfile declares pnpm/npm/yarn/bun, local JS gates must use that manager. Missing tooling is an environment BLOCK, never a fallback to another manager or dependency-installing `npx --yes`. For a project containing both `pyproject.toml` and `uv.lock`, local pytest gates use `uv run --frozen ...`.

**PLAN probe.** After the draft manifest and gate freeze, and before owner approval, run for every pipeline `profile` and every pre-publish `local_gate` that has no `{candidate_sha}` and is not a runtime gate (deploy/smoke):

```text
gate-runner-cli.ts --plan-probe .tmp/pipelines/{run-id}/manifest.json <pipeline-id> <gate>
```

It needs a clean checkout (`BASE_PROBE_REQUIRES_CLEAN_CHECKOUT`), runs the complete frozen command set with the gate environment and writes `.tmp/pipelines/{run-id}/planning/probes/<pipeline>-<gate>.json` (`kind: plan_probe`, `commands_sha256` of the frozen commands). Pipelines sharing profile+gate may share one probe. PASS is required; any later change to those frozen commands needs a new probe. FAIL means a red baseline: add a `baseline_repair: true` work item on that profile (the only case where FAIL passes preflight) or fix the gate contract. BLOCKED never passes: fix the gate contract (missing env, resources, install root) before approval. `plan-run-preflight` and `run-preflight` reject a missing, stale or non-PASS probe with `PLAN_PROBE_REQUIRED: <pipeline>/<gate>` and print the command. A PASS probe at the same clean HEAD also satisfies the RUN base-probe requirement.

Before presenting owner approval run the **same executable contract that RUN will depend on**, while no state exists yet:

```text
stage-cli.ts plan-check .tmp/pipelines/{run-id}/manifest.json
```

It runs `plan-run-preflight --environment`, `git-worktree-cli.ts adopt` and `git-worktree-cli.ts verify` in that order, stops at the first failure and names it (`failed_step`). All three must PASS. `plan-run-preflight` accepts only schema version 2. `verify` must prove that the complete current branch diff is either the frozen preserved baseline or inside writable `allowed_change_paths`; do not defer a baseline/scope mismatch until RUN. Preflight verifies planning evidence hashes, frozen work items, project policy/conflict serialization, explicit executor coverage, GitHub gate/bootstrap contracts and package-manager contract only for `local_gate`. Before `init`, deterministic manifest corrections remain the same draft/run-id and are simply revalidated; after `init`, use the trusted revise-plan lifecycle until implementation starts; after first implementation start, never mutate that manifest.

## Preservation, migration and replan

Canonical results stay under `.tmp/pipelines/{run-id}/`. Deterministic tools own `state.json`, locks, candidate and machine evidence. Never manually edit runtime state; before implementation use revise-plan to authorize in-place manifest changes.

When PLAN intentionally continues existing committed implementation from an older/legacy run, first call:

```text
git-worktree-cli.ts baseline <planning-base-sha>
```

Freeze its exact `head_sha`, sorted `changed_paths[]` and `diff_sha256` as `preserved_baseline`. Those files are allowed to remain exactly as they were at the preserved HEAD, but that does **not** grant the new RUN permission to edit them. Any post-baseline change to such a path must still match `allowed_change_paths`. This is the canonical V1→V2/existing-implementation migration contract.

Lifecycle rule: before the first actual source-agent start, revise in the same folder via `revise-plan`. Afterwards, compatible amendments stay in the RUN; structural replan requires owner-bound begin/finalize in-place unfreeze, with `inherit-replan` only as an explicit owner-approved fallback. Never hand-copy run directories, clone approved reviews/work-items as current validity, or use the legacy `stage-cli supersede` cloning path for new replans.

## Owner approval — mandatory stop

For a new PLAN or owner-contract-changing revision, present gate readiness, branch/main SHA, manifest, DAG with the maximum number of lanes running at once, scope, hashes, risks and run ID. Then STOP.

**Owner questions and approval text.** Write every owner question and the approval summary in plain functional language: what the user will see or get, what changes in testing and time, what the choice costs. No decision codes, gate names or flags without a one-phrase meaning. When the `openchamber_render` tool is available, present the approval (and each multi-option question) as a page with `awaitAnswer`, options as buttons with the last one always «Свой вариант» and a free-text field, and continue in the same turn on the answer; otherwise use plain text with numbered options ending with «свой вариант». The explicit approval message requirement below is unchanged. A technical-only `--revise` with previous approval and `owner_contract_changed=false` instead runs normal preflight/adopt/verify/init; init restores approved status, so do not ask for approval again or invoke approve on the already-approved state.

Only AFTER the owner explicitly approves the **final manifest** (not a scope/story clarification) and every required planning gate is `ready`, run `plan-start` with an audit descriptor that names this run and the exact SHA-256 shown to the owner. The descriptor records the response and decision; an OpenCode `messageID` or source session may be included only when actually available. These fields maintain workflow correlation and do not authenticate authorship.

Add the final-manifest decision, exact displayed manifest SHA, run ID and explicit response to the existing `decision-register.md`. A response to a preceding Story, scope, or probe question belongs to that question's existing decision entry and cannot be reused as the final-manifest descriptor. The CLI checks the descriptor fields and the current manifest bytes; it does not infer consent from natural-language wording.

```text
stage-cli.ts plan-start .tmp/pipelines/{run-id}/manifest.json \
  --approval-subject final-manifest \
  --approval-run-id {run-id} \
  --approval-manifest-sha256 {shown-manifest-sha256} \
  --approval-decision approved \
  --owner-response 'Approved: {explicit response}' \
  [--owner-message-id {actual-message-id}] [--owner-source-session {actual-session-id}]
```

It checks the descriptor against the manifest bytes before any initialization or approval mutation, then runs `plan-check`, `init`, `approve`, the GitHub sync, `validate` and `next`, in that order, and stops at the first failure with `failed_step`. A technical-only revision with `previous_approval=true` and `owner_contract_changed=false` carries the existing approval record through `planning/revision.json` and skips a second approval; owner-contract changes require a fresh descriptor for the new manifest hash.

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
