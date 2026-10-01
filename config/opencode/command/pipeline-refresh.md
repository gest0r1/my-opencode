---
description: Owner-triggered impact-aware refresh of the CURRENT worktree after another branch merged to main
---

# /pipeline-refresh — current worktree only

The owner invokes this command in the **already open B worktree session**, only after another branch was merged to `origin/main` and no RUN is active. This command may refresh Git and revalidate an already-approved schema-v2 PLAN, but it never starts RUN and never infers owner approval for a new bounded/full replan.

Arguments (`$ARGUMENTS`):

- empty = apply refresh and auto-select the single refreshable run for the current branch;
- `<run-id>` = apply refresh to that exact run;
- `--check` or `--check <run-id>` = read-only worktree preflight only;
- anything else = BLOCKED.

Never infer or switch to another worktree. The current session directory is the source of truth. Never run this command in the primary/main checkout.

## 1. Worktree preflight / merge

Use `git-worktree-cli.ts inspect` first. Then resolve the selected run and prove that no RUN is active **before any Git mutation**:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/pipeline-refresh-cli.ts preflight [run-id]
```

Require an owner-created linked worktree, a non-default branch, a clean checkout, and `refresh_preflight: PASS`.

For `--check`, after the CLI preflight execute only:

```bash
bash /root/.config/opencode/skills/task-management/scripts/worktree-refresh.sh --check
```

Then stop. `--check` does not fetch/merge main and therefore does not classify impact.

For apply, after the CLI preflight execute exactly:

```bash
bash /root/.config/opencode/skills/task-management/scripts/worktree-refresh.sh
```

This script owns snapshot + Git mutation only. It snapshots all `.tmp/pipelines`, verifies the archive, fetches `origin/main`, fast-forwards the primary local main, merges that exact main SHA into the current B branch without rewriting B history, and proves pipeline evidence was not changed by the merge.

No free-form Git, `cp`, `mv`, `tar`, `rsync`, script rewriting, stash, reset, rebase, manual merge or manual artifact migration is authorized.

## 2. Deterministic impact classification

After `REFRESH PASS`, invoke the trusted refresh CLI:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/pipeline-refresh-cli.ts apply [run-id]
```

OpenStage must **not** copy planning artifacts itself. The CLI owns any cross-run transfer and machine-owned writes.

The CLI compares the previous effective run base with the new local main and validates the live GitHub Issue **semantic requirements digest**. Pipeline-owned audit comments and fetch timestamps do not count as requirement changes.

It returns exactly one lifecycle class:

### `NO_IMPACT`

Use when changed main paths do not intersect the frozen planning read-set and source requirements are unchanged.

The CLI writes machine-owned `refresh-impact.json` + `git-runtime.json`, updates `state.run_base_sha` when state exists, and keeps the **same run-id/manifest/approval**. Do not create a new PLAN.

Return the existing run command:

```text
/pipeline-run <same-run-id> --unattended
```

Do not start it automatically.

### `BOUNDED_IMPACT`

Use when main changed plan-relevant implementation/technical/CI inputs but did not change requirements, rules/policy or another structural boundary.

The CLI itself creates a deterministic lineage run:

```text
<old-run-id>-refresh-<new-main-short-sha>
```

It is the **only** component allowed to copy artifacts into that run. It may inherit planning/stories/reviews/sources/work-items as draft context, but it never copies runtime state, locks, candidate evidence, Git/GitHub/gate/owner evidence, or deployment-target probe evidence. It updates the draft base SHA, freezes refresh impact evidence, sets lineage `MAIN_DRIFT_REPLAN`, preserves existing committed implementation when present, and marks only affected planning gates `needs_revision`.

Then instruct the owner to run:

```text
/pipeline-plan --refresh <new-run-id>
```

That mode reruns only the affected planning gates recorded by `refresh_revalidation.affected_gates`, recompiles work items when `rebuild_work_items=true`, refreshes affected GitHub execution contracts, and re-runs normal plan preflight. Unaffected ready gates/evidence remain inherited and are not rerun.

A **new owner approval** is required for the bounded run before `/pipeline-run`.

### `STRUCTURAL_IMPACT`

Use when semantic Issue requirements changed, project/distribution rules or frozen project policy changed, schema v1 is involved, history diverged, or deterministic impact cannot prove a bounded revalidation is safe.

No new run is copied automatically. Preserve the old run as history and require a normal new `/pipeline-plan` from the authoritative source.

## Planning read-set requirement

New schema-v2 PLANs freeze `planning_inputs`:

```json
{
  "planning_inputs": {
    "stories": ["apps/web/**"],
    "architecture": ["apps/api/**", "packages/referral-message/**"],
    "contracts": ["apps/api/src/routes/**"],
    "technical_plan": ["pnpm-lock.yaml", ".github/workflows/pipeline-ci.yml"],
    "work_items": ["apps/api/**", "apps/web/**"]
  }
}
```

Keys should correspond to actual planning gate IDs where practical; `work_items` is reserved for TaskManager recompilation. Paths use the same exact-path or `directory/**` syntax as other pipeline scopes.

Legacy v2 manifests without `planning_inputs` use a conservative fallback from their frozen freshness/change scopes, so they remain safe but may require more bounded revalidation than newly planned runs.

## Source snapshot semantics

Raw `source_snapshot_sha256` still protects the local authoritative snapshot file from mutation.

New PLANs also freeze `source_requirements_sha256`, derived from Issue title/body and human comments. The semantic digest excludes:

- `fetched_at`;
- pipeline-generated comments containing `<!-- pipeline-event:... -->`;
- Issue `updated_at` changes caused only by those audit comments.

A human edit to title/body or a human comment still changes the semantic digest and forces `STRUCTURAL_IMPACT`.

## Stop conditions

Any refresh merge conflict, dirty worktree, active RUN, ambiguous run selection, source probe failure, invalid planning read-set, unsafe artifact path, artifact-copy failure, or state/manifest identity mismatch is terminal BLOCKED. Preserve snapshots and partial diagnostics; never repair by manual copying.
