---
description: Design-freeze PLAN in the worktree selected by its owner; no session or branch creation
tags:
  - pipeline
  - planning
  - design-freeze
---

# Pipeline Planning — manually selected worktree

Build a design-freeze PLAN only. Never implement source changes, create a worktree/branch/session, switch checkout, rebase, merge, clean, reset or invoke `openchamber session.create`. Owner opens an existing worktree-session and invokes this command inside that session. Other worktrees may PLAN concurrently; only one RUN executes at a time.

`$ARGUMENTS` selects exactly one source mode: same-repository Issue refs such as `#51 #47`; an existing task/plan file path; or free task text. Empty arguments are allowed only when OpenChamber attached synthetic context contains `Linked GitHub issues for this session:` with at least one `owner/repo#N` ref. There is NO fallback to `docs/plan.md`. Explicit `#N` arguments override linked refs. `docs/pipeline-rules.md` remains the rules path; project rules take precedence and invalid rules BLOCK.

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
3. If `.opencode/pipeline-policy.json` exists, treat it as repository policy. Freeze its path+SHA-256 in `project_policy`; v2 preflight enforces protected paths and triggered project gates.
4. `git_setup` contains `base_sha` and `branch`, optional `must_absent`, but no `source_sha` or `checkout_paths`.

## Planning gate protocol

Planning gates are sequential. A later gate never makes an earlier `needs_revision` gate pass.

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
7. Preserve deployable release flow: implementation → functional gates → Git scope verify → publish candidate SHA → GitHub SHA installation → runtime validation → docs/finalization. Define `ready_after_stage` and `release_ready_after_stage` when applicable.
8. Before manifest freeze call TaskManager. It writes atomic work items under `.tmp/pipelines/{run-id}/work-items/**`; freeze every work-item ID, path and SHA-256 in the manifest. Each pipeline maps its own work-item IDs and defines `decision_ids`, `research_ids`, `contract_ids`.
9. Canonical planning artifacts are `decision-register.md`, `technology-evidence.md`, `contract-inventory.md`, `test-strategy.md`, `accepted-risks.md` and the work-item index. Freeze path+SHA-256 for all of them.

## Manifest schema v2

New PLANs MUST use `schema_version: 2`, `planning_mode: "design-freeze"` and:

- frozen rules version;
- `git_setup`, `allowed_change_paths`, `freshness_sensitive_paths`;
- pipelines/DAG, machine `gate_profiles`, conflict metadata and work-item mappings;
- `planning_readiness.design_freeze: true`;
- `planning_readiness.required_gates[]` and a `ready` evidence record for every required gate;
- path+SHA-256 for every gate artifact/review and required planning artifact;
- `open_decisions: []` before init;
- frozen `work_items[]` with path+SHA-256;
- optional frozen `project_policy` reference when repository policy exists.

GitHub Issue mode additionally freezes `repository`, `source_issues[]`, `planning_base_sha`, per-pipeline `issue_numbers[]` and `source_snapshot_sha256`.

Schema v1 is legacy-read compatibility only; never create a new v1 PLAN.

## Mandatory machine gate contract

`gate-runner-cli` runs from project root with `shell:false`; one command-array item is one executable plus argv. No `cd`, `&&`, pipes, redirects, `$()` or shell composition. No stage-time dependency bootstrap/resolution.

Respect the repository package manager. If `package.json#packageManager` or a lockfile declares pnpm/npm/yarn/bun, JS gates must use that manager. In particular, a pnpm workspace uses `pnpm run ...` / `pnpm exec ...`; missing pnpm is an environment BLOCK, never a fallback to npm/`npx --yes`. `npx --yes` is forbidden in schema v2 gates.

For a project containing both `pyproject.toml` and `uv.lock`, use `uv run --frozen pytest ...` (or `uv run --frozen python -m pytest ...`). Otherwise use the approved project Python contract; never `cd backend && ...`.

Every machine stage has a pipeline `profile`, and `gate_profiles[profile][stage_id]` is a nonempty command list with the exact stage ID key. Qualitative review, implementation, Git verification and publication are not fake machine gates.

Before presenting owner approval run:

```text
stage-cli.ts preflight .tmp/pipelines/{run-id}/manifest.json --environment
git-worktree-cli.ts adopt .tmp/pipelines/{run-id}/manifest.json
```

Both must PASS. V2 preflight verifies planning evidence hashes, source snapshot, frozen work items, project policy/conflict serialization and package-manager contract. Never change the frozen manifest after init.

## Preservation and refresh

Canonical results stay under `.tmp/pipelines/{run-id}/`. Deterministic tools own `state.json`, locks, candidate and machine evidence. Never manually edit approved manifest/state.

After another worktree merges relevant main changes, owner invokes `/pipeline-refresh`. Preserve historical evidence, create a NEW run_id/manifest, review affected design/scope/gates and obtain new approval. Never copy old state/locks/candidate into the new run.

## Owner approval — mandatory stop

Present the current gate history/readiness, exact branch/main SHA, manifest, DAG, scope, evidence hashes, risks and run ID. Then STOP.

Only AFTER a separate explicit owner message approving this exact v2 manifest/run ID, with every owner decision resolved and every required planning gate `ready`, run:

```text
stage-cli.ts preflight .tmp/pipelines/{run-id}/manifest.json --environment
stage-cli.ts init .tmp/pipelines/{run-id}/manifest.json
stage-cli.ts approve {run-id}
node /root/.config/opencode/skills/task-management/scripts/pipeline-github-sync.mjs sync {run-id}
stage-cli.ts validate {run-id} --json
stage-cli.ts next {run-id} --json
```

The initial PLAN invocation never runs init/approve. `--unattended` and reviewer approval are not owner approval. Approval sync for Issue runs must finish with `pending=0`.

Return `/pipeline-run {run-id} --unattended` only after approval; never invoke RUN automatically.
