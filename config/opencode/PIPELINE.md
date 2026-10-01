# Pipeline: GitHub Issue → RUN → PR → main

This document describes the canonical GitHub-backed pipeline lifecycle used by
`OpenStageOrchestrator`.

## Owner workflow

The owner-facing flow is intentionally short:

```text
/pipeline-plan #5 #6 #7
# review and approve the exact frozen PLAN

Recommended:
/pipeline-run <run-id> --unattended

Available RUN options:
/pipeline-run <run-id> [--unattended] [--fix-cycles <5..20>] [--no-session-reuse]

# example for a longer unattended window:
/pipeline-run <run-id> --unattended --fix-cycles 10
```

A successful RUN creates or updates the delivery PR automatically. There is no
separate owner command to create the PR. The owner reviews the resulting PR and
merges it to `main` manually.


When a second worktree was planned while another RUN was executing and `main`
moves before that second RUN starts, use:

```text
/pipeline-refresh [run-id]
```

Refresh is impact-aware:

- `NO_IMPACT`: keep the same v2 run, manifest and owner approval; the trusted
  refresh CLI advances only the machine-owned effective `run_base_sha`.
- `BOUNDED_IMPACT`: the refresh CLI creates a lineage draft itself, copies only
  allowed planning/source/work-item context, never runtime evidence, and marks only
  affected planning gates for `/pipeline-plan --refresh <new-run-id>`.
- `STRUCTURAL_IMPACT`: preserve history and perform a normal full PLAN.

OpenStage never copies run artifacts manually. `worktree-refresh.sh` owns the
snapshot/Git merge and `pipeline-refresh-cli` owns impact classification plus any
cross-run transfer.

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

- authoritative GitHub Issue raw snapshot SHA-256 plus semantic requirements SHA-256;
- per-gate `planning_inputs` read-sets used for incremental refresh impact analysis;
- required planning artifacts and reviews;
- atomic TaskManager work items by ID/path/SHA-256;
- per-pipeline decision/research/contract IDs;
- source/migration/fixture conflict metadata;
- explicit stage executors and GitHub gate contracts;
- optional repository policy SHA-256;
- optional `preserved_baseline` exact HEAD/path/diff identity for existing implementation;
- optional reason-coded `lineage` for supersede/replan history.

Runtime effective scope is deliberately separate from the frozen manifest. PLAN freezes
requirements, owner decisions, acceptance criteria and a minimal base implementation scope.
RUN may add exact machine-owned test/support paths inside an already-approved app/package
component. Additional production/config paths require fresh architecture + senior review proving
a decision-free bounded clarification. Protected/security/trust-boundary paths still require
owner/replan. Scope authorization happens before a new automatic repair cycle is counted. The
shared automatic budget covers both `technical_fix` and bounded `security_fix`.

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

## Rules freeze

Project rules and distribution rules have different lifetimes:

- repository `docs/pipeline-rules.md` and OpenCode distribution `pipeline-rules.default.md` use the same live-rules model;
- pipeline commands and their agents never edit either rules source;
- owner/distribution changes made while the pipeline is stopped are valid: the next `stage-cli validate` reads current rules and updates rules version/SHA audit metadata without blocking on the old hash;
- missing, unreadable, malformed rules or invalid `edit_policy` still block.

Never solve rules drift by editing `state.json` or granting the model write permission to machine state.

## Executor and package-manager integrity

Every schema-v2 pipeline explicitly declares `deployable: true|false`, and every stage has an explicit executor. Repository test/build/typecheck/lint/install/runtime checks may use `local_gate`; for a deployable sink PLAN freezes the cost-aware order `git_verify -> local fail-fast -> git_publish -> final github_ci`. `deployment_validation.stage` points to that final exact-SHA GitHub CI. Legacy `fresh_job`/`upgrade_job` metadata is optional. Local JS gates use the package manager declared by `package.json#packageManager` or the repository lockfile. A pnpm repository does not fall back to npm or dependency-installing `npx --yes`; missing pnpm is an environment blocker for that local gate.

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
- treats that snapshot as create-once for a run-id: a repeated `fetch` for the same
  repository/Issue set returns the existing file and never refetches or overwrites
  frozen source evidence; a different Issue set requires a new run-id;
- returns both raw snapshot SHA-256 and semantic requirements SHA-256. The raw
  digest protects the saved file; the semantic digest excludes `fetched_at`,
  Issue `updated_at` bookkeeping, and pipeline-generated `pipeline-event` audit
  comments while retaining human title/body/comment changes.

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
`approved -> in_progress` audit comment. Comments are append-only per distinct
pipeline lifecycle event: sync does not update a single sticky status comment or
coalesce later transitions. Re-running sync does not duplicate the **same** event
because each comment carries a stable hidden marker, but a new transition has a
new event ID and therefore creates a new comment. If one Issue is mapped to
several pipelines, each pipeline may emit its own audit comment for the same run.

Before and after pipeline stages, and before PR handoff, synchronization must
finish with `pending=0`.

## Deployment testing strategy

Every deployable pipeline freezes an explicit owner decision:

- `github`: local fail-fast gates run first, then one final artifactless GitHub CI; no OpenCode-host CD.
- `opencode_host`: local fail-fast + final GitHub CI + the existing trusted GitHub-driven stateful `github_dev` CD. This is the only mode that requires the deployment-target probe.
- `hybrid`: local fail-fast + final GitHub CI + a post-CI `local_gate` that installs/updates the exact `candidate_sha` on the OpenCode/dev host and runs smoke. Owner acceptance is optional.

PLAN builds a capability matrix and may recommend one option, but the owner chooses it. The model must not choose a strategy on the owner's behalf. The GitHub→OpenCode-host probe, protected Environment, trusted ref and Environment secret-name checks are retained only for `opencode_host`. Ordinary `hybrid` uses no trusted GitHub CD workflow and grants no raw SSH/Docker/deployment shell permissions to agents.

## 3. Candidate publication, GitHub CI and DEV

RUN follows the frozen DAG and executor contract. Dependencies between work blocks unlock at the upstream `ready_after_stage` source-ready boundary; a later external CI/CD blocker does not freeze downstream implementation. For several blocks that compose one product, the canonical path is:

```text
block A implementation/review -> source-ready
  -> block B implementation/review -> source-ready
  -> ... all approved blocks source-ready
  -> Git scope verify
  -> deterministic local fail-fast gates
  -> publish ONE cumulative candidate SHA
  -> one lean artifactless GitHub Actions CI for that exact SHA
  -> optional local or trusted remote CD/runtime validation
  -> optional acceptance/handoff
```

`git-worktree-cli publish` **owns the complete candidate publication operation**: it stages approved changes, creates the candidate commit when needed, performs a non-force push of the selected worktree branch, verifies the remote SHA, and writes. OpenStage must not ask the owner to manually add/commit/push during RUN:

```text
.tmp/pipelines/<run-id>/candidate.json
```

For `github_ci`/`github_dev`, `github-actions-gate-cli` structurally validates the frozen project workflow and accepts only a GitHub run tied to the exact `candidate_sha`, candidate branch/trusted ref and frozen event/workflow. Candidate CI must be read-only, secret-free, path-filter-free and artifactless; every frozen required job plus the terminal job must complete successfully. DEV receives the exact candidate SHA plus source-CI run ID, and for OpenCode-host CD repeats the frozen logical `target_id`. Artifactless workflow success is canonical evidence only when frozen job steps consume that candidate/source identity. PASS, terminal FAIL, and pre-terminal BLOCKED evidence are written under:

```text
.tmp/pipelines/<run-id>/github/<pipeline>-<stage>.json
```

Terminal FAIL retains exact run/attempt and job/failed-step identity. `diagnose` writes compact diagnostics plus one bounded redacted multiline `github/*-job-<id>.log` per failed job; `log --job|--job-id` refreshes/prints one exact-run job. Pre-terminal failures write `status=BLOCKED` with deterministic `failure_phase` and available identity. OpenStage never needs raw `gh` or owner-side log conversion.

`stage-cli complete` re-validates canonical machine evidence before allowing a `local_gate`, `git_verify`, `git_publish`, `github_ci` or `github_dev` stage to complete. A model statement that a check passed is insufficient.

If a target project has no compatible final GitHub CI workflow, PLAN freezes the existing bootstrap/adaptation work item and workflow scope. RUN implements and validates that candidate-safe workflow before publication, publishes the candidate branch and waits for the exact-SHA GitHub run. The final CI is deliberately lean: expensive fresh/repeat-install/runtime checks belong in deterministic local gates unless the project has a concrete GitHub-only reason. `github_dev` and `future_github_gates` remain only for the special `opencode_host` remote-CD path.

Any source-changing fix after publication creates a new candidate SHA. `stage-cli fix-cycle` invalidates the completed chain from the preceding `git_verify`, so the repaired source must pass verify → local fail-fast gates → publish → final GitHub CI → affected CD/runtime/acceptance again. Evidence belonging to the previous SHA cannot satisfy final delivery.

Release packaging is outside candidate validation. If the target project has a real package/container/binary release, keep its existing tag/release workflow and publish deliverables directly to GitHub Releases or the package registry. Do not use Actions artifacts as durable release storage and do not create a universal release workflow for projects that do not ship one.

## 4. Automatic PR handoff

After the GitHub-backed run is fully completed, OpenStage invokes only:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/github-pr-cli.ts \
  create <run-id>
```

The PR helper:

1. requires `state.status == completed` and every mapped pipeline completed;
2. verifies that the current origin equals the repository frozen in state;
3. verifies the published non-default candidate branch and SHA, plus PASS deployment-validation evidence for that same final cumulative SHA on every deployable pipeline;
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

## Automatic security repair

RUN distinguishes a bounded implementation defect from a real owner security decision.

- `security_fix`: frozen AC/contracts/security rules already determine the remediation, and deterministic `stage-cli security-fix-check` proves no owner decision, no requirements/AC/external-contract/security-boundary change, no privilege expansion, no secret exposure and no destructive action. It uses the same automatic-repair budget as `technical_fix`.
- `security_stop`: owner must decide security policy, trust or role/access semantics, or the remediation cannot satisfy the bounded security-fix contract.
- `secret_stop`: actual credential/secret exposure or rotation/revocation action is required.
- `destructive_stop`: remediation is irreversible/destructive.
- `scope_stop`: protected/sensitive scope cannot be machine-authorized.

Critical/High severity does not by itself force an owner stop. True stop categories are recorded as resumable `BLOCKED` checkpoints rather than terminal `failed` solely because the finding is security-related.

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
- technical/security fix during RUN → same run-id with an initial five-cycle budget; owner may pre-authorize a higher run-wide ceiling with `--fix-cycles N` (max 20), grant `+N` to one active stage later, or approve a block-local runtime replan; all remain in the same run and are audited without rewriting the manifest;
- frozen V2 manifest correction after init → `stage-cli supersede <old> <new> --reason <code>`;
- architecture/scope/structural main-drift replan → new run with reason-coded `lineage.change_class=replan`;
- bounded main drift → deterministic CLI-created lineage draft plus affected-gate-only `/pipeline-plan --refresh`;
- no-impact main drift → same approved run with machine-owned effective base adoption.

Supersede copies only planning/source/work-item artifacts. Runtime state, locks, candidate and machine evidence are never reused. The old state records `superseded_by` and `supersede_reason`, so every run-id has a deterministic ancestry instead of unexplained v2b/v2c/v2d generations.
