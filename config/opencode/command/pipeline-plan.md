---
description: Design-freeze PLAN in the worktree selected by its owner; no session or branch creation
tags:
  - pipeline
  - planning
  - design-freeze
---

# Pipeline Planning — manually selected worktree

Build a design-freeze PLAN only. Never implement source changes, create a worktree/branch/session, switch checkout, rebase, merge, clean, reset or invoke `openchamber session.create`. The owner opens an existing worktree-session and invokes this command **inside that session**. Other worktrees may PLAN concurrently, but only one RUN may execute at a time (owner-managed policy).

`$ARGUMENTS` is the task description or a path to a previous plan. Defaults: `docs/plan.md` for project context and `docs/pipeline-rules.md` for rules. Existing project rules take precedence; invalid project rules block. Never create or modify rules automatically.

## Preflight: inspect only

1. Run `git-worktree-cli.ts inspect` from the current selected session. Require `linked_worktree=true`, non-default branch, a valid main SHA and clean tracked checkout. Do not use shell `cd` to pretend to switch the session directory. Verify `.tmp/pipelines/` is ignored in **this project** (`git check-ignore -q .tmp/pipelines/__probe__`); if not, block and ask the owner to configure the project ignore safely. Existing tracked `.tmp/pipelines` must block.
2. Record the current worktree path, branch, its HEAD, and exact current local `main` commit as `git_setup.base_sha`. Verify that the main commit is an ancestor of branch HEAD. Use `stage-cli.ts rules docs/pipeline-rules.md --json` and require PASS. Never mutate Git during PLAN.
3. `git_setup` must contain `base_sha` and `branch`, plus optional `must_absent`; do not generate `source_sha`/`checkout_paths`, which implied automatic branch preparation. Source transplantation, if required, is an owner decision *before* planning.

## Design-freeze

1. Read project context once through ContextScout. Produce one compact context packet with exact paths; repeat retrieval only on a documented gap.
2. Select agents by actual triggers: StoryMapper and SeniorStoryReviewer for user-facing acceptance criteria; ArchitectureAnalyzer for architecture or cross-module changes; ContractManager for API/event/CLI contracts; ExternalScout for new external technology, security or migrations; SeniorTechnicalPlanReviewer for material risk. PrioritizationEngine only when owner explicitly requests prioritization of competing product items. Skip irrelevant agents.
3. Planning agents write to `.tmp/pipelines/{run-id}/planning/`. PLAN must not change source or implementation code. Record unresolved owner decisions in one decision packet.
4. Compile prerequisites, overlapping files and migrations into a DAG. Independent stages can be parallel within the single RUN. Runtime locks are only for genuinely shared external mutable targets; do not invent cross-worktree RUN scheduling.
5. Create binary acceptance criteria, scoped implementation tasks and minimal top-level `allowed_change_paths`. Protect `.git`, secrets and protected environment files. Gate profiles must be actual executable+argv commands, without shell pipes or chaining.
6. For deployable projects with reproducible installer, preserve `implementation -> fast gates -> Git scope verify -> publish candidate SHA -> install from GitHub SHA -> runtime validation`. Record `not_applicable` explicitly where justified.
7. Manifest must define schema_version, unique run_id, planning_mode `design-freeze`, frozen rules source/version, `git_setup`, allowed_change_paths, pipelines/DAG, gate_profiles and open_decisions. Do not call `git-worktree-cli setup` or `capability`.
8. Before asking for approval, validate references, DAG, scope, rules and machine commands; require no open decisions and `git-worktree-cli.ts adopt .tmp/pipelines/{run-id}/manifest.json` PASS. `adopt` does not change Git.

## Preservation and main refresh

Canonical results live inside this worktree under `.tmp/pipelines/{run-id}/`: `manifest.json`, planning/**, decision-register.md, technology-evidence.md, contract-inventory.md, test-strategy.md, accepted-risks.md. `state.json`, locks, candidate and gate evidence belong to deterministic tools. Never manually edit an approved manifest or state.

When A has merged into main and owner updates worktree B, retain the entire old run as immutable historical evidence, including the old manifest. Before Git rebase/merge, owner MUST snapshot **all** `.tmp/pipelines` to a location outside B and verify it afterward; see `project/manual-worktree-flow.md`. Git does not version ignored research. Neither `git clean -fdx`, `git reset --hard` nor worktree deletion is permitted as a shortcut.

After refreshing B, create a **new run_id** and NEW manifest under its own directory using retained research as input. Check the actual diff against new main and update only affected design, dependencies, scopes and gates. Cite the previous run as evidence; do not copy its approved `state.json`, lock or candidate into the new run. Even when no design impact is found, new `base_sha` requires new manifest validation and explicit owner approval; RUN of the old run remains blocked by `STALE_PLAN`.

## Approval boundary

Show one decision packet, current branch/main SHA, manifest, DAG, relevant risks, gates, and run ID. Do not initialize approved state before owner approval. After explicit approval only:

```text
stage-cli.ts init .tmp/pipelines/{run-id}/manifest.json
stage-cli.ts approve {run-id}
stage-cli.ts validate {run-id} --json
stage-cli.ts next {run-id} --json
```

Return the ready command `/pipeline-run {run-id} --unattended`. Do not invoke it automatically. Owner may prepare 2–3 PLANs, but only one approved RUN executes at a time, and owner merges completed work into main.
