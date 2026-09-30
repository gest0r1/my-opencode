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
4. If project policy declares `deployment_target.kind=opencode_host`, run `deployment-target-cli.ts inspect {run-id} --policy .opencode/pipeline-policy.json` as a **capability probe**. It dispatches the trusted GitHub probe workflow, validates the protected Environment/trusted ref, verifies required Environment secret names without reading values, and requires the configured probe job to PASS. On READY freeze `planning/deployment-target.json` path+SHA-256 as `deployment_target_check`. Probe failure does not by itself kill PLAN: it makes only GitHub-initiated `opencode_host` CD unavailable for this run and must be shown to the owner. Local `hybrid` CD does not depend on this probe. Agents never receive raw `gh`/SSH credentials or SSH permission.

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
5. Compile prerequisites and conflicts into a DAG. Freeze `exclusive_paths`, `migration_paths`, `fixture_paths` and/or `conflict_group` where relevant. Pipelines sharing such conflict metadata must be serialized by dependencies. A pipeline referenced by another pipeline's `depends_on` MUST define `ready_after_stage` at the source-ready boundary: all source-mutating `agent` work and its required CodeReviewer/review must be complete by that stage, and no source-mutating `agent` stage may appear after it. Runtime dependency satisfaction uses this milestone, not full CI/CD completion. Runtime locks are only for genuinely shared external mutable targets.
6. Create binary acceptance criteria and minimal **base** `allowed_change_paths` for the approved implementation components/config/docs. Do not attempt to enumerate every future test/fixture/mock path: RUN may add concrete test/support paths inside an already-approved `apps/<name>` or `packages/<name>` component as machine-owned runtime scope. Base scope syntax is exact path or `directory/**` only; wildcard forms such as `eslint.config.*` are invalid. Protect `.git`, rules, secrets, workflow trust boundaries and environment files.
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

   Build a capability matrix and present exactly three owner choices with an advisory recommendation:
   1. `github` — local fail-fast first, then final GitHub CI; no OpenCode-host CD stage;
   2. `opencode_host` — local fail-fast, final GitHub CI, then the existing trusted GitHub-driven stateful `github_dev` CD to the OpenCode host; this special mode requires the READY deployment-target probe;
   3. `hybrid` — local fail-fast, final GitHub CI, then a frozen post-CI `local_gate` installs/updates the exact `candidate_sha` on the OpenCode/dev host and runs smoke; owner acceptance is added only when requested.

   The LLM may recommend a mode and explain the trade-offs, but **must not choose it**. Record the owner's choice as a resolved decision ID and freeze `testing_strategy` with `mode`, `owner_decision_id`, `github_validation_stage`, optional `opencode_host_stage`, and `post_deploy_test=automated|user|automated_then_user` when runtime validation exists. Only `opencode_host` requires `deployment_target_check` and an active trusted stateful `github_dev` workflow.

   Every deployable sink freezes `deployment_validation.stage` as the final artifactless `github_ci` stage for the exact published candidate SHA. `fresh_job`/`upgrade_job` are legacy optional metadata only; fresh/repeat-install validation belongs in deterministic local gates unless the project has a concrete reason to keep it in GitHub. If owner testing is selected, append an `owner_acceptance` stage after successful CD/runtime validation; generic `complete` cannot satisfy it.
8. Freeze one concrete **artifactless** GitHub Actions contract for the final CI. Prefer `.opencode/pipeline-policy.json#github_actions.ci` when present; otherwise inspect an existing compatible workflow. Candidate CI must have explicit read-only permissions, no repository/environment secrets, no `paths`/`paths-ignore` trigger filters, SHA-pinned third-party actions, an exact terminal job and only the `required_jobs[]` needed for independent CI assurance. Do not duplicate expensive fresh/upgrade/runtime work merely because it already ran locally. Canonical candidate CI MUST NOT use `actions/upload-artifact` or `actions/download-artifact`; provenance is the exact `candidate_sha`, workflow run/attempt and required-job evidence. If final CI is missing/incompatible, use the existing bootstrap/adaptation mechanism (`.github/workflows/pipeline-ci.yml` + `pipeline_ci`) and keep it lean.

   `github_dev`, `deployment-target-cli`, trusted Environment/ref and deferred `future_github_gates` remain supported only for the special GitHub-initiated `opencode_host` path. Ordinary `hybrid` post-CI CD is a `local_gate` and needs no new CLI, raw SSH/Docker permission or deployment-target probe.

   Release packaging is separate from candidate CI/CD. If the target project already produces a releasable package/container/binary, preserve its release workflow and run it only for the actual release/tag/explicit release event; publish deliverables directly as GitHub Release/package-registry assets rather than using Actions artifacts as durable storage. Do not invent a universal release workflow when the project has no release product.
9. Before manifest freeze call TaskManager. It writes atomic work items under `.tmp/pipelines/{run-id}/work-items/**`; freeze every work-item ID, path and SHA-256 in the manifest. Each pipeline maps its own work-item IDs and defines `decision_ids`, `research_ids`, `contract_ids`. A candidate CI bootstrap/adaptation work item and any deferred future stateful DEV workflow work item must be mapped to the same pipeline and their exact workflow paths must be inside `allowed_change_paths`; prefer narrow paths over `.github/workflows/**`. An **active** trusted stateful DEV workflow must remain outside candidate change scope. A `future_github_gates` workflow is allowed in change scope only because it cannot execute in the current run.
10. Canonical planning artifacts are `decision-register.md`, `technology-evidence.md`, `contract-inventory.md`, `test-strategy.md`, `accepted-risks.md` and the work-item index. Obtain hashes only through:

```text
stage-cli.ts artifacts {run-id} <run-relative-path>... --json
```

Freeze exactly the returned path+SHA-256 pairs. Do not use free-form `sha256sum` or model-computed hashes.

## Manifest schema v2

New PLANs MUST use `schema_version: 2`, `planning_mode: "design-freeze"` and:

- rules version recorded at approval for initial consistency; RUN later adopts externally changed live rules metadata without rewriting the manifest;
- `git_setup`, base `allowed_change_paths`, `freshness_sensitive_paths`; runtime scope extensions are machine-owned RUN state and are never written back into the manifest;
- pipelines/DAG, source-ready `ready_after_stage` on every depended-on pipeline, explicit `deployable`, one integrated delivery sink per delivered product where practical, mandatory `deployment_validation` + owner-selected `testing_strategy` for deployable sinks, artifactless active `github_gates[stage_id]`, deferred `future_github_gates`, explicit `executors[stage_id]` including `owner_acceptance`, local-only `gate_profiles`, conflict metadata and work-item mappings;
- `planning_readiness.design_freeze: true`;
- `planning_readiness.required_gates[]` and a `ready` evidence record for every required gate;
- path+SHA-256 for every gate artifact/review and required planning artifact;
- `open_decisions: []` before init;
- frozen `work_items[]` with path+SHA-256;
- optional frozen `project_policy` reference when repository policy exists;
- frozen `deployment_target_check` evidence only for GitHub-initiated `opencode_host` CD.

GitHub Issue mode additionally freezes `repository`, `source_issues[]`, `planning_base_sha`, per-pipeline `issue_numbers[]` and `source_snapshot_sha256`.

Schema v1 is legacy-read compatibility only; never create a new v1 PLAN.

## Mandatory execution-gate contract

Every schema-v2 stage has exactly one explicit executor: `agent | review | local_gate | git_verify | git_publish | github_ci | github_dev | owner_acceptance`. Never infer execution mode from the stage name during RUN.

Repository test/build/typecheck/lint/install/runtime checks may use `local_gate`; for deployable sinks PLAN should place the deterministic fail-fast set after `git_verify` and before `git_publish`. The deployable sink still requires one final `github_ci` stage after publication for the exact candidate SHA. When that final CI is unavailable, PLAN must bootstrap/adapt the project workflow rather than fall back to local-only delivery validation.

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
