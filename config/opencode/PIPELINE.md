# Pipeline: GitHub Issue → RUN → PR → main

This document describes the canonical GitHub-backed pipeline lifecycle used by
`OpenStageOrchestrator`.

## Owner workflow

The owner-facing flow is intentionally short:

```text
/pipeline-plan #5 #6 #7
# review and approve the exact frozen PLAN
/pipeline-run <run-id> --unattended
```

A successful RUN creates or updates the delivery PR automatically. There is no
separate owner command to create the PR. The owner reviews the resulting PR and
merges it to `main` manually.

## Manifest v2 and planning gates

New design-freeze plans use manifest schema v2. V1 remains readable only for
historical runs and `stage-cli init` no longer creates new V1 state. Before owner
approval PLAN must run `stage-cli plan-run-preflight`, `git-worktree-cli adopt`
and `git-worktree-cli verify`; schema/scope errors therefore fail before approval.
Canonical RUN still begins with `stage-cli run-preflight`; an old V1 state returns
`LEGACY_V1_REPLAN_REQUIRED`. Keep V1 state/evidence for audit and freeze any
already-committed implementation through `git-worktree-cli baseline <base-sha>`
as `preserved_baseline`, so historical source can remain without becoming writable
scope in the V2 run.

Before owner approval, every triggered planning gate must be recorded literally
as `ready` with frozen artifact path + SHA-256. `needs_revision` cannot be
reinterpreted by OpenStage as a pass. A gate may revise/rerun itself up to three
times when no owner judgement is required; otherwise only the current gate's
blocking questions are presented to the owner.

The v2 manifest also freezes:

- authoritative GitHub Issue snapshot SHA-256;
- required planning artifacts and reviews;
- atomic TaskManager work items by ID/path/SHA-256;
- per-pipeline decision/research/contract IDs;
- source/migration/fixture conflict metadata;
- explicit stage executors and GitHub gate contracts;
- optional repository policy SHA-256;
- optional `preserved_baseline` exact HEAD/path/diff identity for existing implementation;
- optional reason-coded `lineage` for supersede/replan history.

Planning/review evidence is append-only. Stable Issue story files are the
exception: owner corrections update the same `stories/issue-N.md` file.

## Optional repository policy

Universal procedure belongs to the distribution rules, commands and deterministic
tools. Repository-specific invariants may live in:

```text
.opencode/pipeline-policy.json
```

A schema example is distributed at
`skills/task-management/pipeline-policy.example.json`.

Current schema supports:

- `protected_paths[]`: scopes that may not enter `allowed_change_paths`;
- `required_gates[]`: a gate stage plus `when_paths[]`; if frozen change scope intersects those paths, the manifest must include that stage;
- optional `github_actions.ci/dev` defaults for workflow path, terminal/required jobs, trigger, artifact, DEV environment/mode/trusted ref/concurrency;
- optional `deployment_target.kind=opencode_host`: GitHub-driven CD target describing either `github_ssh` or `self_hosted_runner`, protected Environment, trusted ref, deterministic probe workflow/job, required Environment secret names and optional runner labels. PLAN validates the GitHub→OpenCode-host path without exposing secret values.

When the policy exists, PLAN freezes its path+SHA-256. Preflight and later state
validation fail if it changes.

## Executor and package-manager integrity

Every schema-v2 pipeline explicitly declares `deployable: true|false`, and every stage has an explicit executor. A deployable pipeline freezes distinct fresh-install and upgrade/repeat-install required jobs. Authoritative test/build/typecheck/lint stages use `github_ci`; only explicitly local fast/precheck/docs/runtime stages use `local_gate`. Local JS gates use the package manager declared by `package.json#packageManager` or the repository lockfile. A pnpm repository does not fall back to npm or dependency-installing `npx --yes`; missing pnpm is an environment blocker for that local gate, not a reason to replace GitHub CI.

## 1. PLAN reads authoritative Issues

GitHub Issue references are identifiers, not requirement content. PLAN resolves
the current worktree repository from `origin` and reads every requested Issue
through the authenticated deterministic reader:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-issue-cli.ts \
  fetch <run-id> <issue-number>...
```

The reader:

- requires authenticated `gh` access;
- accepts only numeric Issues from the current `github.com/owner/repo` origin;
- reads title, body, state, `updated_at`, and comments;
- rejects pull requests, closed Issues, missing/inaccessible Issues, and unsafe
  run identifiers;
- deduplicates Issue numbers;
- writes the authoritative snapshot atomically to
  `.tmp/pipelines/<run-id>/sources/github-issues.json`;
- returns the snapshot SHA-256, which schema v2 freezes.

Read full bodies/comments without modifying the snapshot via:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-issue-cli.ts \\
  show <run-id> [issue-number...]
```

Anonymous GitHub HTML/API requests, `webfetch`, `curl`, and
`github_handoff_probe` are not Issue-reading substitutes. Git transport
visibility does not prove REST Issue access.

The approved manifest freezes both `source_issues[]` and each
`pipelines[].issue_numbers[]`. Every source Issue must be mapped to at least
one pipeline. This frozen mapping is the source of truth used later by status
comments and PR closing keywords.

## 2. Issue status comments

`stage-cli` queues lifecycle transitions for the Issue numbers mapped to each
pipeline. `pipeline-github-sync.mjs` delivers those events as idempotent Issue
comments.

Typical transitions include:

```text
created -> planned
planned -> approved
approved -> in_progress
in_progress -> completed
```

Taking a pipeline into work therefore produces the
`approved -> in_progress` audit comment. Re-running sync does not duplicate a
previously delivered event because each comment carries a stable hidden marker.

Before and after pipeline stages, and before PR handoff, synchronization must
finish with `pending=0`.

## Deployment testing strategy

Every deployable pipeline freezes an explicit owner decision:

- `github`: fresh install, upgrade/repeat install and useful runtime/E2E validation run only in GitHub/disposable infrastructure.
- `opencode_host`: GitHub Actions deploys the exact CI artifact to the machine where OpenCode runs, then validates there automatically, hands it to the owner, or both.
- `hybrid`: GitHub-side automated validation completes first, then the same artifact ID/digest is deployed by trusted GitHub CD to the OpenCode host and the owner performs the final test.

PLAN builds a capability matrix and may recommend one option, but the owner chooses it. The OpenCode-host capability probe is itself trusted automation: it is dispatched from the trusted ref with a correlation ID, uses explicit read-only GitHub permissions and the protected Environment, and must run the frozen probe job. `github_ssh` probes must use strict non-interactive SSH and all required Environment secret names; `self_hosted_runner` probes must execute on the frozen self-hosted runner labels. Local/hybrid requires a READY trusted GitHub→OpenCode-host probe and an already-trusted stateful CD workflow. If those workflows are being introduced in the current candidate, they may be authored as future automation but cannot be consumed as privileged CD until merged to the trusted ref.

## 3. Candidate publication, GitHub CI and DEV

RUN follows the frozen DAG and executor contract. The canonical release path is:

```text
implementation/review
  -> source documentation/finalization
  -> optional local fast gates
  -> Git scope verify
  -> publish exact candidate SHA
  -> GitHub Actions CI for that SHA
  -> immutable artifact/evidence
  -> DEV/runtime validation of the same SHA/artifact
  -> acceptance/handoff
```

`git-worktree-cli publish` **owns the complete candidate publication operation**: it stages approved changes, creates the candidate commit when needed, performs a non-force push of the selected worktree branch, verifies the remote SHA, and writes. OpenStage must not ask the owner to manually add/commit/push during RUN:

```text
.tmp/pipelines/<run-id>/candidate.json
```

For `github_ci`/`github_dev`, `github-actions-gate-cli` structurally validates the frozen project workflow and accepts only a GitHub run tied to the exact `candidate_sha`, candidate branch and frozen event/workflow. Candidate CI must be read-only, secret-free and path-filter-free; every frozen required job plus the terminal job must complete successfully. Required artifacts are bound by GitHub artifact ID and `sha256:` digest. DEV evidence additionally points to the exact source CI run, repeats the same source artifact ID/digest, and for OpenCode-host CD repeats the frozen logical `target_id`. PASS **and terminal FAIL** evidence is written under:

```text
.tmp/pipelines/<run-id>/github/<pipeline>-<stage>.json
```

On FAIL the evidence retains exact run/attempt identity, job and failed-step conclusions, artifacts and a bounded redacted failed-log excerpt. `github-actions-gate-cli diagnose` can refresh a separate diagnostics file without giving OpenStage raw `gh` permission.

`stage-cli complete` re-validates canonical machine evidence before allowing a `local_gate`, `git_verify`, `git_publish`, `github_ci` or `github_dev` stage to complete. A model statement that a check passed is insufficient.

If a target project has no compatible GitHub CI workflow, PLAN freezes a bootstrap/adaptation work item and workflow scope. RUN implements that candidate-safe CI workflow in the target project, validates it before publication, publishes it with the candidate branch and waits for GitHub Actions on that exact SHA. First-time CI workflows use a `push` trigger; there is no local final-build/test fallback. For `github` and `hybrid` testing strategies the GitHub validation stage includes both fresh-install and upgrade/repeat-install required jobs. For `opencode_host`, those required jobs belong to the trusted stateful CD stage on the OpenCode host. Existing disposable `github_dev` is secret-free and runs on the candidate ref. Existing stateful `github_dev` runs from a verified Environment/trusted ref with frozen non-cancelling concurrency. If stateful DEV is missing, PLAN may freeze it under `future_github_gates`; RUN authors that workflow now but cannot execute it until owner merge makes the workflow trusted. A later PLAN can promote it to active `github_dev`.

Any source-changing fix after publication creates a new candidate SHA. `stage-cli fix-cycle` invalidates the completed chain from the preceding `git_verify` through publish/CI/DEV, making `git_verify` runnable again while preserving old evidence as audit history. The repaired source must then pass verify → publish → GitHub CI → DEV again; CI/artifact/DEV evidence belonging to the previous SHA cannot complete the reopened stages.

## 4. Automatic PR handoff

After the GitHub-backed run is fully completed, OpenStage invokes only:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-pr-cli.ts \
  create <run-id>
```

The PR helper:

1. requires `state.status == completed` and every mapped pipeline completed;
2. verifies that the current origin equals the repository frozen in state;
3. verifies the published non-default candidate branch and SHA;
4. flushes pending Issue status comments;
5. takes Issue numbers only from the frozen source/mapping;
6. creates or updates exactly one open PR from the candidate branch to `main`;
7. preserves human-written PR body text outside the pipeline-managed block;
8. places one closing keyword per completed mapped Issue, for example:

   ```text
   Closes #5
   Closes #6
   ```

9. records the exact PR number in run state and posts an idempotent PR-link
   comment to each mapped Issue;
10. returns the ready PR and stops with `merged: false`.

The helper has no merge operation.

## 5. Merge and Issue closure

The owner merges the ready PR to `main` through GitHub. Because the PR targets
the default branch and contains `Closes #N`, GitHub closes those mapped Issues
when the PR is merged.

The intended audit chain is:

```text
Issue
  -> authenticated PLAN snapshot
  -> frozen run + pipeline mapping
  -> status comments
  -> tested/published candidate SHA
  -> PR link comment
  -> owner merge to main
  -> GitHub closes mapped Issue
```

The pipeline tools never close an Issue directly through `PATCH /issues/N`.

## Required repository permissions

The GitHub identity used by the installed `gh` CLI needs access only to the
selected repositories with these capabilities:

| Capability | Required level | Used for |
| --- | --- | --- |
| Metadata | Read | repository identity |
| Contents | Read/write | branch/candidate publication |
| Issues | Read/write | requirement reads and audit comments |
| Pull requests | Read/write | create/update delivery PR |
| Actions | Read/write | inspect candidate workflow runs and dispatch trusted `workflow_dispatch` gates when frozen by the project contract |
| Environments | Read | validate DEV/OpenCode-host Environment, deployment branch policy and configured secret names without reading secret values |

`Issues: write` is needed because GitHub does not provide a separate
comment-only write permission. The deterministic tools therefore enforce the
narrower policy in code: they read Issues and post comments, but do not expose an
Issue state-change/close command.

The pipeline engine has no generic secrets-management or PR-merge operation. Stateful DEV deployment credentials remain inside the target repository's protected GitHub Environment/workflow. When the selected target is the machine where OpenCode runs, PLAN uses `deployment-target-cli inspect` to dispatch the trusted GitHub probe workflow and prove GitHub→host reachability/authentication; RUN repeats that probe immediately before CD. The CLI inspects only required Environment secret **names**, never secret values, and OpenStage/subagents never receive raw `gh` or SSH capability.

## Failure behavior

The lifecycle fails closed when any of these is true:

- `gh` is missing or unauthenticated;
- an explicit Issue is inaccessible, missing, closed, or is actually a PR;
- the current origin differs from the frozen repository;
- the run or any mapped pipeline is not completed;
- GitHub comment outbox delivery remains pending;
- candidate evidence is missing or its remote SHA does not match;
- a required project workflow is missing without an approved bootstrap/adaptation work item;
- GitHub Actions evidence references a different SHA, branch, workflow, required/terminal job, artifact ID/digest or source CI run;
- stateful DEV Environment/trusted-ref/concurrency validation fails;
- an external CD target loses deterministic reachability/authentication;
- more than one open PR exists for the same candidate branch and `main`;
- the existing PR contains a malformed pipeline-managed body block.

Retrying after a transient GitHub failure is safe: status and PR-link comments
are idempotent, and PR creation reuses the existing branch PR instead of opening
a duplicate.


## Run lineage and supersede

Use different mechanisms for different changes:

- planning revision before init → same run-id;
- technical fix during RUN → same run-id, maximum three cycles;
- frozen V2 manifest correction after init → `stage-cli supersede <old> <new> --reason <code>`;
- architecture/scope/main-drift replan → new run with reason-coded `lineage.change_class=replan`.

Supersede copies only planning/source/work-item artifacts. Runtime state, locks, candidate and machine evidence are never reused. The old state records `superseded_by` and `supersede_reason`, so every run-id has a deterministic ancestry instead of unexplained v2b/v2c/v2d generations.
