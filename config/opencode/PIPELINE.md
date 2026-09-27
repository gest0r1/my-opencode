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
historical runs.

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
- optional repository policy SHA-256.

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
- `required_gates[]`: a gate stage plus `when_paths[]`; if frozen change
  scope intersects those paths, the manifest must include that stage.

When the policy exists, PLAN freezes its path+SHA-256. Preflight and later state
validation fail if it changes.

## Package-manager integrity

JS gates use the package manager declared by `package.json#packageManager` or
the repository lockfile. A pnpm repository does not fall back to npm or
dependency-installing `npx --yes`; missing pnpm is an environment blocker.

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

## 3. Candidate publication and tests

RUN follows the frozen DAG and uses only deterministic gates. Machine tests,
builds, lint/type checks, runtime gates, and reviews must reach their required
PASS/completed states before delivery.

`git-worktree-cli publish` commits any approved scoped changes, performs a
non-force push of the selected worktree branch, verifies the remote SHA, and
writes:

```text
.tmp/pipelines/<run-id>/candidate.json
```

PR creation is blocked unless `candidate.json` records `status: PASS` and
`candidate_sha == remote_sha`.

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

`Issues: write` is needed because GitHub does not provide a separate
comment-only write permission. The deterministic tools therefore enforce the
narrower policy in code: they read Issues and post comments, but do not expose an
Issue state-change/close command.

No pipeline tool requires repository administration, secrets, deployments, or a
PR merge permission path.

## Failure behavior

The lifecycle fails closed when any of these is true:

- `gh` is missing or unauthenticated;
- an explicit Issue is inaccessible, missing, closed, or is actually a PR;
- the current origin differs from the frozen repository;
- the run or any mapped pipeline is not completed;
- GitHub comment outbox delivery remains pending;
- candidate evidence is missing or its remote SHA does not match;
- more than one open PR exists for the same candidate branch and `main`;
- the existing PR contains a malformed pipeline-managed body block.

Retrying after a transient GitHub failure is safe: status and PR-link comments
are idempotent, and PR creation reuses the existing branch PR instead of opening
a duplicate.
