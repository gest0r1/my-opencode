---
description: Synchronize current worktree main and reconcile the existing PLAN without starting stages
---

# /pipeline-refresh

Arguments: `<run-id>` or empty to select the single unfinished run in the current linked worktree; `--check [run-id]` performs read-only preflight.

Use the same reconciliation as `/pipeline-run`; no separate refresh lifecycle or copied planning gates.

1. `pipeline-refresh-cli.ts preflight [run-id]`: require a clean owner-created linked worktree and no actually active stage. Aggregate `state.status=in_progress` alone is not activity.
2. For `--check`, run `worktree-refresh.sh --check` and return. Otherwise run trusted `worktree-refresh.sh`: snapshot all `.tmp/pipelines`, verify archive, fetch/merge main and prove the pipeline tree is unchanged. Never free-form merge, stash, reset, rebase or copy artifacts.
3. `pipeline-refresh-cli.ts apply <run-id>` delegates to `pipeline-reconcile-cli.ts`. `REVIEW_REQUIRED` means read its exact diff and live source against approved stories/AC/architecture/contracts; use fresh ArchitectureAnalyzer and SeniorTechnicalPlanReviewer only when their expertise is required. Persist their review inside this run, then apply with `--evidence <path>`.
4. Semantic outcomes are only `COMPATIBLE` and `PLAN_INVALID`. A changed hash detects drift, never proves a contradiction. A `COMPATIBLE` decision adopts the live source digest/base and appends `reconcile/NNN.json`; manifest and owner approval remain unchanged. Do not create a new run.
5. Compatible changes requiring code use the same clarification mechanism as owner feedback: before implementation revise the current PLAN; after implementation apply an approved owner amendment, including runtime work units when necessary. Then reconcile again against the effective contract.
6. `PLAN_INVALID` before the first source-changing `agent` stage: revise PLAN in this folder, invalidate affected gates and repeat only those checks. If owner-approved behavior/scope/constraints changed, reset approval; technical corrections retain approval. After implementation began, create a new PLAN directory through `inherit-replan`; old run remains unchanged and only reusable context goes to `planning/inherited/`.

No `BOUNDED_IMPACT`, `affected_gates` refresh lifecycle, refresh lineage run, `refresh_revalidation`, or `/pipeline-plan --refresh`. Return the command `/pipeline-run <same-run-id>` when compatible; refresh never starts execution itself.


After refresh, RUN completion redispatch and advisory checks remain free; only a fresh negative review/final machine gate initiates an existing fix cycle. Compatibility evidence or a hash mismatch alone spends no cycle. See `pipeline-run.md` for the single accounting contract; refresh does not create another budget.
