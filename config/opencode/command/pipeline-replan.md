---
description: Update the plan of a not-yet-started run after main moved (typically after the previous run merged)
---

# /pipeline-replan

Arguments: `<run-id>` or empty to select the single unfinished run in the current linked worktree; `--check [run-id]` performs read-only preflight and delta.

Replans the same run folder; no new run, no copied planning gates. OpenStage executes the trusted commands below itself; do not delegate them to `OpenDevopsSpecialist` merely because arbitrary shell probes are denied.

1. Refuse when a source `agent` stage of this run already started (`implementation_started`): compatible main changes then use owner amendment in `/pipeline-run`, incompatible ones `pipeline-reconcile-cli.ts inherit-replan`.
2. Trusted sync: `$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/pipeline-replan-cli.ts preflight [run-id]` (clean owner-created linked worktree, no active stage), then `bash $HOME/.config/opencode/skills/task-management/scripts/worktree-refresh.sh` (for `--check` run `bash $HOME/.config/opencode/skills/task-management/scripts/worktree-refresh.sh --check`, then continue to step 3 read-only). It snapshots all `.tmp/pipelines`, verifies the archive, merges main and proves the pipeline tree unchanged. Never free-form merge, stash, reset, rebase or copy artifacts.
3. `$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/pipeline-replan-cli.ts delta <run-id> --json`: changed files since the effective base, their intersection with `planning_scope`, `allowed_change_paths`, `test_rework[].path`, gate-testing source maps and work-item scopes, and `affected_gates` (`stories`/`architecture`/`contracts`, `work_items`, `gate_probes`). Empty `changed_files` ends the command.
4. Run only the affected planning gates fresh, through the existing `pipeline-reconcile-cli.ts apply` / `revise-plan` lifecycle (`REVIEW_REQUIRED` input, review evidence inside this run): ContextScout delta for the changed paths plus one level up, architecture/contracts/test-rework review (fresh ArchitectureAnalyzer and SeniorTechnicalPlanReviewer only where their expertise is needed), TaskManager for work items. Unaffected gates keep their artifacts. A `COMPATIBLE` reconcile adopts the new base; `PLAN_INVALID` before implementation revises this folder.
5. Re-run every plan probe (`gate-runner-cli.ts --plan-probe`) and the PLAN preflight trio (`stage-cli plan-run-preflight`, `git-worktree-cli adopt`, `git-worktree-cli verify`).
6. Owner approval only when owner-visible behavior/scope/constraints changed (`owner_contract_changed`): reset approval and ask in plain functional language. Otherwise technical corrections keep approval; report a short delta summary in Russian.

Return `/pipeline-run <same-run-id>`; replan never starts execution itself. Compatibility evidence or a hash mismatch alone spends no fix cycle.
