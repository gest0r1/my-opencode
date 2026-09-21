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

1. `git-worktree-cli.ts inspect`: require owner-created linked worktree, non-default branch, valid local main and clean tracked checkout. Verify `.tmp/pipelines/` ignored with `git check-ignore -q .tmp/pipelines/__probe__`; existing tracked `.tmp/pipelines` BLOCK. Do not shell `cd` to change session directory.
2. Record exact worktree directory, branch, HEAD, and local main SHA in `git_setup.base_sha`; require main ancestor of HEAD. `stage-cli.ts rules docs/pipeline-rules.md --json` must PASS. Never mutate Git in PLAN.
3. `git_setup` contains `base_sha` and `branch`, optional `must_absent`, but no source transplantation (`source_sha` or `checkout_paths`).

## Design-freeze

1. Collect project context once through ContextScout into one compact packet of exact relevant paths. Fetch again only on documented gap.
2. Select triggered planning agents only: StoryMapper + SeniorStoryReviewer for user-facing acceptance, ArchitectureAnalyzer for architecture/cross-module, ContractManager for contracts, ExternalScout for external technology/security/migration, SeniorTechnicalPlanReviewer for material risks. PrioritizationEngine only for explicit owner-requested prioritization.
3. Planning agents write only `.tmp/pipelines/{run-id}/planning/`. PLAN must not change implementation source. Collect ALL unresolved owner decisions (including any superseded-rule policy, e.g. D1) in decision-register.md. Never omit a decision to make validation pass, invent owner authorization, or self-approve. `open_decisions` reflects the real register; readiness remains BLOCKED until each decision is answered by the owner.
4. Compile prerequisites, overlaps and migrations into DAG. Independent stages may run concurrently within the one RUN. Runtime locks only for genuinely shared external mutable targets.
5. Create binary acceptance criteria, scoped implementation tasks and minimal `allowed_change_paths` covering source/test/docs AND any needed new helper scripts. Never let TestEngineer create unscoped bootstrap helpers. Protect `.git`, secrets and env files.
6. Preserve deployable release path: implementation → fast gates → Git scope verify → publish candidate SHA → GitHub SHA installation → runtime validation. Mark genuinely inapplicable parts explicitly in planning evidence.
7. Manifest defines schema_version, unique run_id, planning_mode design-freeze, frozen rules source/version, git_setup, allowed_change_paths, pipelines/DAG, gate_profiles and open_decisions. Never call worktree setup or create sessions.

## Machine gate contract (mandatory before owner approval)

`gate-runner-cli` operates from project root, with `shell:false`. A command array element is ONE allowed executable and argv. No `cd`, `&&`, pipes, redirects, `$()` or other shell composition. Use `python -m pytest backend/tests/... -q`, not `cd backend && python -m pytest ...`. The exact Python executable must be available in runner PATH with pytest installed; dependencies must be prepared through the project/distro installer, never silently bootstrapped by a stage agent.

For a machine stage such as `test-rule-actions`, declare a pipeline `profile` and a gate command keyed by the EXACT stage ID. Example:

```json
{
  "pipelines": [{"id":"app","stages":["implementation","test-rule-actions"],"profile":"default"}],
  "gate_profiles": {"default":{"test-rule-actions":["python -m pytest backend/tests/test_selection_rule_actions.py -q"]}}
}
```

Implementation, qualitative review, Git scope verification and publish need no machine gate profile unless they actually dispatch via gate-runner. Do not introduce fake gates for such stages. For machine stages, `gate_profiles[profile][stage_id]` must be a nonempty array and every command runner-safe.

Before presenting the plan invoke exactly:

```text
stage-cli.ts preflight .tmp/pipelines/{run-id}/manifest.json --environment
```

Require PASS. This command validates the executable gate contract and probes Python/pytest via `--version` without executing actual tests. `stage-cli init` repeats it BEFORE creating state, and `stage-cli approve` repeats it before approval. An interpreter/import/dependency problem must BLOCK planning for the owner to resolve; never change the frozen manifest after init. Python preflight cannot prove every project dependency import; additional actual gate tests remain mandatory during RUN.

Then run read-only `git-worktree-cli.ts adopt .tmp/pipelines/{run-id}/manifest.json`; require PASS. Validate references, DAG, scope, rules and no open owner decisions; never create state while a blocker exists.

## Preservation and main refresh

Canonical results stay in this worktree under `.tmp/pipelines/{run-id}/`: manifest.json, planning/**, decision-register.md, technology-evidence.md, contract-inventory.md, test-strategy.md, accepted-risks.md. Deterministic tools own state.json, locks, candidate and gate evidence. Never manually edit approved manifest or state.

When A merges to main, owner invokes `/pipeline-refresh` inside B. Preserve ALL previous run files as immutable evidence; archive outside B and verify. No `git clean -fdx`, `reset --hard`, or worktree deletion. After refresh create a NEW run_id and new manifest based on preserved research, check impacted design/scope/gates and obtain fresh explicit approval. Never copy old state/locks/candidate into new run.

## Owner approval boundary — mandatory

Present one decision packet, explicit decisions and answers, exact branch/main SHA, manifest, DAG, scope, executable gate evidence, risks and run ID. Then STOP. The PLAN command must not call `stage-cli init` or `stage-cli approve` as part of its initial execution, and `--unattended` has no approval meaning here. A reviewer's or agent's statement "approved" is not owner approval.

ONLY after a NEW explicit owner message approving this exact manifest/run ID AND explicitly resolving every decision, the orchestrator may run:

```text
stage-cli.ts preflight .tmp/pipelines/{run-id}/manifest.json --environment
stage-cli.ts init .tmp/pipelines/{run-id}/manifest.json
stage-cli.ts approve {run-id}
stage-cli.ts validate {run-id} --json
stage-cli.ts next {run-id} --json
```

If the owner requests changes or a decision remains unresolved, revise a not-yet-frozen manifest and re-present it; do NOT approve, drop a decision, forge an owner response or bypass validation. This permission boundary is procedural: the CLI cannot cryptographically distinguish an agent-issued command from an owner action under the same OS account. The explicit owner message is the authority.

Return `/pipeline-run {run-id} --unattended` only after approval. Never automatically invoke it.
