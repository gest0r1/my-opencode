---
description: Design-freeze PLAN in the worktree selected by its owner; no session or branch creation
tags:
  - pipeline
  - planning
  - design-freeze
---

# Pipeline Planning — manually selected worktree

Build a design-freeze PLAN only. Never implement source changes, create a worktree/branch/session, switch checkout, rebase, merge, clean, reset or invoke `openchamber session.create`. Owner opens an existing worktree-session and invokes this command inside that session. Other worktrees may PLAN concurrently; only one RUN executes at a time.

`$ARGUMENTS` selects exactly one source mode: same-repository Issue refs such as `#51 #47`; an existing task/plan file path; or free task text. Empty arguments are allowed only when OpenChamber attached synthetic context contains `Linked GitHub issues for this session:` with at least one `owner/repo#N` ref. There is NO fallback to `docs/plan.md`. Explicit `#N` arguments override linked refs. `docs/pipeline-rules.md` remains the rules path; project rules take precedence and invalid rules BLOCK. PLAN and all delegated agents must never edit project or distribution rules.

## Preflight: inspect only

0. Resolve source first. For GitHub Issue mode use only:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-issue-cli.ts fetch {run-id} <issue-number>...
```

The persisted `.tmp/pipelines/{run-id}/sources/github-issues.json` is authoritative. Record the returned `snapshot_sha256` in the v2 manifest. To read full bodies/comments use the non-mutating reader:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-issue-cli.ts show {run-id} [issue-number...]
```

Never split, rewrite, normalize or temporarily edit the authoritative snapshot. OpenChamber refs are identifiers only. Do not substitute anonymous GitHub HTML/API requests, `webfetch`, free-form `curl` or `github_handoff_probe`.

1. `git-worktree-cli.ts inspect`: require owner-created linked worktree, non-default branch, valid local main and clean tracked checkout. Verify `.tmp/pipelines/` is ignored; tracked pipeline state BLOCKS.
2. Record exact worktree directory, branch, HEAD and local main SHA in `git_setup.base_sha`; require main ancestor of HEAD. `stage-cli.ts rules docs/pipeline-rules.md --json` must PASS. PLAN never mutates Git.
3. Inspect repository policy only through `stage-cli.ts policy --json`. If `.opencode/pipeline-policy.json` exists, freeze the returned path+SHA-256 in `project_policy`; v2 preflight enforces protected paths and triggered project gates.
4. If project policy declares `deployment_target.kind=opencode_host`, run `deployment-target-cli.ts inspect {run-id} --policy .opencode/pipeline-policy.json` as a **capability probe**. It dispatches the trusted GitHub probe workflow, validates the protected Environment/trusted ref, verifies required Environment secret names without reading values, and requires the configured probe job to PASS. On READY freeze `planning/deployment-target.json` path+SHA-256 as `deployment_target_check`. Probe failure does not by itself kill PLAN: it makes `opencode_host` and `hybrid` unavailable for this run and must be shown to the owner. Agents never receive raw `gh`/SSH credentials or SSH permission.

   The trusted probe workflow contract is deterministic: `workflow_dispatch` with required `pipeline_run_id`, `run-name` containing that input, explicit read-only GitHub permissions, the frozen `probe_job` bound to the protected Environment, and SHA-pinned third-party actions. For `transport=github_ssh`, the job must reference every frozen Environment secret name and execute non-interactive SSH with `BatchMode=yes` and `StrictHostKeyChecking=yes`. For `transport=self_hosted_runner`, `runs-on` must include `self-hosted` plus every frozen runner label. The CLI reads this workflow from the frozen trusted ref, never from candidate source.

5. `git_setup` contains `base_sha` and `branch`, optional `must_absent`, but no `source_sha` or `checkout_paths`.

## Planning gate protocol

Planning gates are sequential. A gate advances only on literal `status: ready`. A later gate never makes an earlier `needs_revision` gate pass.

For each triggered gate:
1. run a fresh planning/review agent;
2. persist append-only evidence (stories themselves are the only stable/mutable planning artifacts);
3. if `ready`, freeze path+SHA-256 and advance;
4. if `needs_revision` and no owner judgement is needed, revise and rerun the SAME gate, up to **3 cycles**;
5. if an owner decision is required, ask only the questions that block the CURRENT gate, with context, consequences and a recommendation; STOP;
6. after the owner answers, update the decision register and rerun the SAME gate fresh;
7. `blocked`, or `needs_revision` after 3 autonomous cycles, BLOCKS. The orchestrator may not reinterpret a blocker as belonging to a later gate.

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

Planning/review sessions are always fresh. Subagents do not delegate further agents; when context/evidence is missing, they return the concrete gap to OpenStage, which calls ContextScout/ExternalScout and reruns the original gate fresh.

## Design-freeze

1. Collect project context once through ContextScout into a compact packet of exact relevant paths. Fetch again only on a documented gap.
2. Select only triggered planning gates: StoryMapper/SeniorStoryReviewer for user-facing behavior; ArchitectureAnalyzer for architecture/cross-module; ContractManager for interfaces; ExternalScout for current external technology/security/migration facts; SeniorTechnicalPlanReviewer for material risks. PrioritizationEngine only on explicit owner prioritization.
3. Maintain stable Issue story files `stories/issue-N.md`; owner corrections rewrite the same story. Reviews are append-only/versioned.
4. Collect ALL unresolved owner decisions in `decision-register.md`. Each decision records its owning planning gate and status. Never omit a decision to make validation pass or self-authorize it.
5. Compile prerequisites and conflicts into a DAG. Freeze `exclusive_paths`, `migration_paths`, `fixture_paths` and/or `conflict_group` where relevant. Pipelines sharing such conflict metadata must be serialized by dependencies. Runtime locks are only for genuinely shared external mutable targets.
6. Create binary acceptance criteria and minimal `allowed_change_paths` including source, tests, docs and approved helper scripts. Protect `.git`, secrets and environment files.
7. Classify every pipeline explicitly as `deployable: true|false`. For each deployable pipeline, first build a **testing capability matrix** from project architecture plus deterministic probes:
   - **GitHub**: can fresh install, upgrade/repeat install and useful runtime/E2E checks execute on GitHub-hosted/disposable infrastructure without access to the OpenCode host?
   - **OpenCode host**: is a trusted stateful GitHub CD workflow already present, and did `deployment-target-cli inspect` prove that GitHub can reach/authenticate to the machine where OpenCode runs?
   - **Deferred local CD**: if trusted CD/probe automation is missing, can this run safely author it only as future trusted automation for use after merge?

   Then present exactly three owner choices with an advisory recommendation:
   1. `github` — deployment/runtime testing stays in GitHub disposable infrastructure;
   2. `opencode_host` — GitHub deploys the exact CI artifact to the machine where OpenCode runs, then tests there automatically, hands it to the owner for testing, or both;
   3. `hybrid` — all feasible automated checks run in GitHub first, then GitHub deploys the same artifact to the OpenCode host, followed by explicit owner testing (optionally after automated local smoke).

   The LLM may recommend a mode and explain what is/isn't testable in GitHub, but **must not choose it**. Record the owner's choice as a resolved decision ID and freeze `testing_strategy` with `mode`, `owner_decision_id`, stage references and local `post_deploy_test=automated|user|automated_then_user`. `opencode_host`/`hybrid` are selectable only when the target probe is READY and an active trusted `github_dev` workflow already exists. If that automation is being bootstrapped in this run, local modes are unavailable now; the owner may choose `github` for this run and bootstrap future CD, or stop and complete the trust/bootstrap cycle first.

   Every deployable pipeline must also freeze `deployment_validation` with one GitHub-executed validation stage plus two distinct required job IDs: `fresh_job` and `upgrade_job`. For `github`/`hybrid`, these belong to the GitHub validation stage. For `opencode_host`, they belong to the stateful OpenCode-host CD stage. Both jobs use the same candidate artifact/SHA. If owner testing is selected, append an `owner_acceptance` stage after successful local CD; generic `complete` cannot satisfy it.
8. For every required authoritative CI/DEV gate, freeze a concrete GitHub Actions contract. Prefer `.opencode/pipeline-policy.json#github_actions` when present. Otherwise inspect existing compatible project workflows. Candidate CI must have explicit read-only permissions, no repository/environment secrets, no `paths`/`paths-ignore` trigger filters, SHA-pinned actions, an exact terminal job, `required_jobs[]`, and an immutable artifact when deployment/runtime consumes one. If authoritative CI is missing/incompatible, use canonical bootstrap default `.github/workflows/pipeline-ci.yml` + `pipeline_ci`; runtime/E2E needed during that first bootstrap includes the mandatory fresh+upgrade jobs in candidate CI. Existing disposable/stateful DEV consumes the exact source-CI artifact **ID and its SHA-256 digest**. Stateful DEV additionally freezes `trusted_ref`, protected `environment`, and a non-cancelling `concurrency_group`; `github-actions-gate-cli inspect/validate` must verify the Environment exists and accepts the trusted ref. If stateful DEV workflow is missing, PLAN creates a separate frozen work item and `future_github_gates` contract for that workflow. RUN may author it now, but it is deliberately absent from the current stage DAG and cannot execute until it is merged into the trusted ref; current-run runtime validation remains in candidate CI. A later PLAN can promote that now-trusted workflow into active `github_dev`. `BLOCKED` stops PLAN. Missing/incompatible GitHub Actions is normal planned work, never permission to substitute local final tests/builds.
9. Before manifest freeze call TaskManager. It writes atomic work items under `.tmp/pipelines/{run-id}/work-items/**`; freeze every work-item ID, path and SHA-256 in the manifest. Each pipeline maps its own work-item IDs and defines `decision_ids`, `research_ids`, `contract_ids`. A candidate CI bootstrap/adaptation work item and any deferred future stateful DEV workflow work item must be mapped to the same pipeline and their exact workflow paths must be inside `allowed_change_paths`; prefer narrow paths over `.github/workflows/**`. An **active** trusted stateful DEV workflow must remain outside candidate change scope. A `future_github_gates` workflow is allowed in change scope only because it cannot execute in the current run.
10. Canonical planning artifacts are `decision-register.md`, `technology-evidence.md`, `contract-inventory.md`, `test-strategy.md`, `accepted-risks.md` and the work-item index. Obtain hashes only through:

```text
stage-cli.ts artifacts {run-id} <run-relative-path>... --json
```

Freeze exactly the returned path+SHA-256 pairs. Do not use free-form `sha256sum` or model-computed hashes.

## Manifest schema v2

New PLANs MUST use `schema_version: 2`, `planning_mode: "design-freeze"` and:

- rules version recorded at approval for initial consistency; RUN later adopts externally changed live rules metadata without rewriting the manifest;
- `git_setup`, `allowed_change_paths`, `freshness_sensitive_paths`;
- pipelines/DAG, explicit `deployable`, mandatory `deployment_validation` + owner-selected `testing_strategy` for deployable pipelines, explicit `executors[stage_id]` including `owner_acceptance`, active `github_gates[stage_id]`, deferred `future_github_gates`, local-only `gate_profiles`, conflict metadata and work-item mappings;
- `planning_readiness.design_freeze: true`;
- `planning_readiness.required_gates[]` and a `ready` evidence record for every required gate;
- path+SHA-256 for every gate artifact/review and required planning artifact;
- `open_decisions: []` before init;
- frozen `work_items[]` with path+SHA-256;
- optional frozen `project_policy` reference when repository policy exists;
- frozen `deployment_target_check` evidence only when the selected testing strategy uses the OpenCode host (`opencode_host|hybrid`).

GitHub Issue mode additionally freezes `repository`, `source_issues[]`, `planning_base_sha`, per-pipeline `issue_numbers[]` and `source_snapshot_sha256`.

Schema v1 is legacy-read compatibility only; never create a new v1 PLAN.

## Mandatory execution-gate contract

Every schema-v2 stage has exactly one explicit executor: `agent | review | local_gate | git_verify | git_publish | github_ci | github_dev | owner_acceptance`. Never infer execution mode from the stage name during RUN.

Authoritative repository test/build/typecheck/lint stages use `github_ci`. A local stage whose name explicitly identifies it as fast/local/precheck may use `local_gate`, but its PASS cannot replace the authoritative GitHub CI stage. When GitHub CI is required and unavailable, PLAN must bootstrap/adapt the project workflow rather than fall back to local execution.

For every `github_ci`/`github_dev` stage freeze `github_gates[stage_id]` with:
- repository workflow path under `.github/workflows/*.yml|yaml`;
- terminal job ID and every authoritative `required_jobs[]` job ID;
- trigger (`push` for first-time/bootstrap candidate workflows, `workflow_dispatch` only for an already trusted workflow);
- expected artifact when the contract produces one; runtime evidence binds its GitHub artifact ID and `sha256:` digest;
- DEV `mode` (`disposable|stateful`), `source_ci_stage`, DEV evidence artifact/file plus `ci_artifact_id`/`ci_artifact_digest`; OpenCode-host stateful gates also freeze `target_id`; stateful additionally freezes environment, trusted workflow ref and `concurrency_group` with `cancel-in-progress: false`;
- `bootstrap_required` + frozen `bootstrap_work_item_id` for candidate CI adaptation, or inside `future_github_gates` for a stateful DEV workflow that is authored now but becomes executable only after merge to the trusted ref.

Before freeze inspect the proposed project workflow:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-actions-gate-cli.ts inspect <workflow> <terminal-job> --trigger <push|workflow_dispatch> [--artifact <name>] [--required-job <job>]... [--executor github_ci|github_dev] [--mode stateful --environment <env> --trusted-ref <ref> --concurrency-group <group>]
```

For `local_gate`, `gate-runner-cli` still runs from project root with `shell:false`; one command-array item is one executable plus argv. No `cd`, `&&`, pipes, redirects, `$()` or stage-time dependency bootstrap/resolution. Only local-gate stages require a pipeline `profile` and `gate_profiles[profile][stage_id]`.

Respect the repository package manager for local JS gates. If `package.json#packageManager` or a lockfile declares pnpm/npm/yarn/bun, local JS gates must use that manager. Missing tooling is an environment BLOCK, never a fallback to another manager or dependency-installing `npx --yes`. For a project containing both `pyproject.toml` and `uv.lock`, local pytest gates use `uv run --frozen ...`.

Before presenting owner approval run the **same executable contract that RUN will depend on**, while no state exists yet:

```text
stage-cli.ts plan-run-preflight .tmp/pipelines/{run-id}/manifest.json --environment
git-worktree-cli.ts adopt .tmp/pipelines/{run-id}/manifest.json
git-worktree-cli.ts verify .tmp/pipelines/{run-id}/manifest.json
```

All three must PASS. `plan-run-preflight` rejects schema v1 before the owner can approve it. `verify` must prove that the complete current branch diff is either the frozen preserved baseline or inside writable `allowed_change_paths`; do not defer a baseline/scope mismatch until RUN. V2 preflight verifies planning evidence hashes, source snapshot, frozen work items, project policy/conflict serialization, explicit executor coverage, GitHub gate/bootstrap contracts and package-manager contract only for `local_gate`. Before `init`, deterministic manifest corrections remain the same draft/run-id and are simply revalidated; after `init`, never mutate that manifest.

## Preservation, migration, supersede and refresh

Canonical results stay under `.tmp/pipelines/{run-id}/`. Deterministic tools own `state.json`, locks, candidate and machine evidence. Never manually edit approved manifest/state.

When PLAN intentionally continues existing committed implementation from an older/legacy run, first call:

```text
git-worktree-cli.ts baseline <planning-base-sha>
```

Freeze its exact `head_sha`, sorted `changed_paths[]` and `diff_sha256` as `preserved_baseline`. Those files are allowed to remain exactly as they were at the preserved HEAD, but that does **not** grant the new RUN permission to edit them. Any post-baseline change to such a path must still match `allowed_change_paths`. This is the canonical V1→V2/existing-implementation migration contract.

Distinguish lifecycle changes:
- planning `needs_revision`: same run-id/draft, up to 3 autonomous cycles;
- `technical_fix`: same approved run, max 3 cycles;
- deterministic manifest correction **before init**: same draft/run-id;
- frozen-manifest correction after init: create a lineage-preserving draft through `stage-cli supersede <old> <new> --reason <code>`;
- architecture/scope/main-drift replan: new run with `lineage.change_class=replan` and a reason code.

`stage-cli supersede` copies planning/source/work-item artifacts only; it never copies state, locks, candidate, GitHub/gate/owner evidence. Do not hand-copy pipeline directories.

After another worktree merges relevant main changes, owner invokes `/pipeline-refresh`. Preserve historical evidence, create a NEW run_id/manifest with reason-coded lineage, review affected design/scope/gates and obtain new approval. Never copy old state/locks/candidate into the new run.

## Owner approval — mandatory stop

Present the current gate history/readiness, exact branch/main SHA, manifest, DAG, scope, evidence hashes, risks and run ID. Then STOP.

Only AFTER a separate explicit owner message approving this exact v2 manifest/run ID, with every owner decision resolved and every required planning gate `ready`, run:

```text
stage-cli.ts plan-run-preflight .tmp/pipelines/{run-id}/manifest.json --environment
git-worktree-cli.ts adopt .tmp/pipelines/{run-id}/manifest.json
git-worktree-cli.ts verify .tmp/pipelines/{run-id}/manifest.json
stage-cli.ts init .tmp/pipelines/{run-id}/manifest.json
stage-cli.ts approve {run-id}
node /root/.config/opencode/skills/task-management/scripts/pipeline-github-sync.mjs sync {run-id}
stage-cli.ts validate {run-id} --json
stage-cli.ts next {run-id} --json
```

The initial PLAN invocation never runs init/approve. `--unattended` and reviewer approval are not owner approval. Approval sync for Issue runs must finish with `pending=0`.

Return `/pipeline-run {run-id} --unattended` only after approval; never invoke RUN automatically.
