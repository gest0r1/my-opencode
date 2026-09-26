---
description: Design-freeze PLAN in the worktree selected by its owner; no session or branch creation
tags:
  - pipeline
  - planning
  - design-freeze
---

# Pipeline Planning — manually selected worktree

Build a design-freeze PLAN only. Never implement source changes, create a worktree/branch/session, switch checkout, rebase, merge, clean, reset or invoke `openchamber session.create`. Owner opens an existing worktree-session and invokes this command inside that session. Other worktrees may PLAN concurrently; only one RUN executes at a time.

`$ARGUMENTS` is the task description or path to a previous plan. Defaults: `docs/plan.md` for context and `docs/pipeline-rules.md` for rules. Project rules take precedence. Invalid rules BLOCK; never rewrite them automatically.

## Preflight: inspect only

1. `git-worktree-cli.ts inspect`: require owner-created linked worktree, non-default branch, valid local main and clean tracked checkout. Verify `.tmp/pipelines/` ignored in this project; existing tracked `.tmp/pipelines` BLOCK. Do not shell `cd` to change session directory.
2. Record exact worktree directory, branch, HEAD and local main SHA in `git_setup.base_sha`; require main ancestor of HEAD. `stage-cli.ts rules docs/pipeline-rules.md --json` must PASS. Never mutate Git in PLAN.
3. `git_setup` contains `base_sha` and `branch`, optional `must_absent`, but no `source_sha` or `checkout_paths`.

## Design-freeze

1. Collect project context once through ContextScout into a compact packet of exact relevant paths. Fetch again only on documented gap.
2. Select triggered planning agents only: StoryMapper + SeniorStoryReviewer for user-facing acceptance; ArchitectureAnalyzer for architecture/cross-module; ContractManager for contracts; ExternalScout for external technology/security/migration; SeniorTechnicalPlanReviewer for material risks. PrioritizationEngine only upon explicit owner prioritization request.
3. Planning agents write only `.tmp/pipelines/{run-id}/planning/`. PLAN must not change implementation source. Collect ALL unresolved owner decisions (including a superseded-rule policy such as D1) in `decision-register.md`. Never omit a decision to make validation pass, invent owner authorization or self-approve. `open_decisions` must agree with the real register and remain nonempty until the owner decides.
4. Compile prerequisites, overlaps and migrations into a DAG. Independent stages may run concurrently within one RUN. Runtime locks only for genuinely shared external targets.
5. Create binary acceptance criteria, scoped tasks and minimal `allowed_change_paths` including needed source, tests, documentation AND new helper scripts. Never allow unscoped TestEngineer bootstrap files. Protect `.git`, secrets and environment files.
6. Preserve deployable release path: implementation → fast gates → Git scope verify → publish candidate SHA → GitHub SHA installation → runtime validation. Mark genuinely inapplicable parts with a reason in planning evidence.
7. Manifest defines schema_version, unique run_id, planning_mode design-freeze, frozen rules version, git_setup, allowed_change_paths, pipelines/DAG, gate_profiles and open_decisions. Never call worktree setup or create sessions.

## Mandatory machine gate contract

`gate-runner-cli` runs from the project root with `shell:false`; one command-array item equals ONE allowed executable plus argv. No `cd`, `&&`, pipes, redirects, `$()` or shell composition. For a project that contains both `pyproject.toml` and `uv.lock`, use `uv run --frozen pytest backend/tests/... -q` (or `uv run --frozen python -m pytest ...`) so tests run in the locked project environment. Otherwise use `python -m pytest backend/tests/... -q`; never use `cd backend && ...`. No unapproved stage-time bootstrap, dependency resolution or global pytest fallback.

If a stage is a machine gate (for example `test-rule-actions`), its pipeline MUST define `profile`, and `gate_profiles[profile][stage_id]` MUST be a nonempty list of executable commands. Gate key and machine stage ID must match exactly. Example:

```json
{
  "pipelines": [{"id":"app","stages":["implementation","test-rule-actions"],"profile":"default"}],
  "gate_profiles": {"default":{"test-rule-actions":["python -m pytest backend/tests/test_selection_rule_actions.py -q"]}}
}
```

Implementation, qualitative review, Git verification and publication use their own tools and need no fake gate profile. Validate all commands, even on other declared profiles, without executing them. Before presenting a plan invoke:

```text
stage-cli.ts preflight .tmp/pipelines/{run-id}/manifest.json --environment
```

Require PASS. This checks the gate contract, the executables, and Python/pytest via `--version`, but does NOT run tests or prove all application dependency imports. `stage-cli init` repeats preflight BEFORE any state is created and `stage-cli approve` repeats it before approval. Interpreter/pytest readiness failures BLOCK pending installation/owner resolution. Never change the frozen manifest after init.

Run read-only `git-worktree-cli.ts adopt .tmp/pipelines/{run-id}/manifest.json`; require PASS. Check references, DAG, scope, rules and decisions. Never create state with blockers.

## Preservation and main refresh

Canonical results stay in `.tmp/pipelines/{run-id}/`: manifest.json, planning/**, decision-register.md, technology-evidence.md, contract-inventory.md, test-strategy.md, accepted-risks.md. Deterministic tools own state.json, locks, candidate and gate evidence. Never manually edit approved manifest or state.

After A merges to main, owner invokes `/pipeline-refresh` inside B. Preserve all historical evidence and archive outside B. No `git clean -fdx`, `reset --hard` or worktree deletion. After refresh create a NEW run_id and manifest based on saved research, review affected design/scope/gates and obtain new approval. Never copy old state/locks/candidate into new run.

## Owner approval — mandatory stop

Present one decision packet, explicit decision statuses, exact branch/main SHA, manifest, DAG, scope, preflight evidence, risks and run ID. Then STOP. The initial PLAN invocation must NEVER run `stage-cli init` or `stage-cli approve`. Neither `--unattended` nor an agent/reviewer saying approved constitutes owner approval.

Only AFTER a separate explicit owner message approving this exact manifest/run ID AND resolving every owner decision, run:

```text
stage-cli.ts preflight .tmp/pipelines/{run-id}/manifest.json --environment
stage-cli.ts init .tmp/pipelines/{run-id}/manifest.json
stage-cli.ts approve {run-id}
stage-cli.ts validate {run-id} --json
stage-cli.ts next {run-id} --json
```

On a requested change or unresolved decision, revise the not-yet-frozen plan and re-present it. Do not forge an owner answer, delete decisions, bypass validation or approve on your own. The owner-message boundary is procedural, not cryptographic: same-OS-account commands cannot authenticate whether agent or owner invoked them.

Return `/pipeline-run {run-id} --unattended` only after approval; never automatically invoke RUN.
