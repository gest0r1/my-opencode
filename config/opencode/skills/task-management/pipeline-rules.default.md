---
document_type: pipeline_rules
rules_version: 2
rules_scope: opencode_default
edit_policy: distribution_only
---

# Default pipeline policy

Universal invariants for OpenStage pipelines. Procedure belongs to
`/pipeline-plan`, `/pipeline-run` and deterministic CLI tools.

## Authority

1. Deterministic CLI/tool safety gates.
2. Command contracts (`/pipeline-plan`, `/pipeline-run`, `/pipeline-status`).
3. Effective pipeline rules.
4. Frozen manifest for one run.
5. Task/work-item instructions inside manifest scope.
6. LLM judgement.

A lower layer cannot weaken a higher layer. Unresolved safety/scope conflict is
fail-closed.

## Effective rules and freeze

- Repository `docs/pipeline-rules.md`, when present and valid, is project policy.
- If absent, this distribution policy is used.
- Invalid existing project rules block; never silently fall back.
- Agents never create/modify project rules automatically.
- Effective rules source/version/SHA and approved manifest SHA are frozen at state initialization.
- Project-local `docs/pipeline-rules.md` remains a live frozen source: mutation after init blocks validation.
- Distribution `pipeline-rules.default.md` is different: `stage-cli init` copies the exact effective content into a machine-owned run-local snapshot and state validation reads only that snapshot. A later OpenCode/distribution update must not invalidate an already initialized RUN.
- Legacy runs created before run-local default snapshots use deterministic `stage-cli rules-refresh <run-id>` exactly once when needed. Refresh is allowed only for `rules_source=opencode_default` and only when the current distribution keeps the same `rules_version`; it records old/new hashes. A version change requires replan. Agents never edit `state.json` manually.

## Planning and scope

- New design-freeze PLANs use manifest schema v2. Schema v1 is legacy-read compatibility only. Before owner approval, `stage-cli plan-run-preflight` plus deterministic Git adopt/verify must prove that canonical RUN would accept the manifest; `stage-cli init` never creates new v1 state.
- PLAN has no implicit backlog-file source. `/pipeline-plan` requires explicit text/file/`#N` input or GitHub Issue refs attached by the current OpenChamber session; missing source is an error.
- GitHub Issue refs are restricted to the current worktree repository. OpenChamber supplies identifiers only; PLAN re-fetches authoritative Issue content/state from GitHub.
- Each Issue story has one stable mutable planning file; review evidence is append-only.
- PLAN does not modify implementation source, Git history, runtime or secrets.
- Decisions requiring owner judgement are explicit before design-freeze approval.
- Open decisions prohibit initialization of an approved design-freeze run.
- Every triggered planning gate is frozen as path+SHA-256 evidence and must be `ready`; `needs_revision` never becomes PASS by orchestrator interpretation.
- A planning gate may self-revise at most 3 cycles when no owner judgement is needed. Owner questions are asked only for the current blocking gate; after an answer the same gate is rerun fresh.
- Reviews are append-only. Stable Issue story files may be revised, but review evidence is never overwritten or translated in place.
- Planning/review agents write their own authorized artifacts and return a uniform status/blockers/artifacts envelope. A parent may not reconstruct missing child evidence from chat text.
- Approved implementation scope is expressed by the frozen manifest, including
  minimal `allowed_change_paths` when source changes are expected.
- Scope expansion requires re-planning and owner approval.
- Atomic work items are compiled before approval and frozen by ID/path/SHA-256. RUN may execute only those frozen work items.
- If `.opencode/pipeline-policy.json` exists, its SHA-256 is frozen. Protected paths and triggered project gates are enforced by preflight.

## DAG and parallelism

- PLAN compiles prerequisites and ordinary source/migration/fixture conflicts
  into an acyclic dependency DAG.
- Shared `exclusive_paths`, `migration_paths`, `fixture_paths` or `conflict_group`
  require dependency serialization; a v2 manifest that declares such a conflict
  without ordering is invalid.
- A pipeline/stage is runnable only when its declared prerequisites are complete.
- Independent runnable work may execute in parallel.
- Do not add runtime conflict detectors for constraints already representable as
  DAG ordering.
- Runtime locks are reserved for shared external mutable targets that cannot be
  serialized purely by the run DAG (for example a shared deployment environment
  used by separate runs).

## Git and source integrity

- Source/base/candidate identity uses exact immutable commit SHA values where Git
  flow applies.
- PLAN freezes the planning main SHA. RUN fetches `origin/main` before execution while the selected worktree is clean. Relevant drift is stale-plan blocking; unrelated drift may be deterministically merged while recording an effective run base outside the frozen manifest.
- Protected/default branches are not directly mutated by working agents.
- Branch/source setup, changed-file scope and candidate publication use the
  deterministic Git gate rather than free-form agent Git commands.
- A changed file outside approved scope, a sensitive path, wrong branch/SHA or
  failed remote-SHA verification is blocking.

## Least privilege and secrets

- Static agent permissions are deny-by-default for capabilities not required by
  the role; working agents receive only their coarse role capability.
- Fine-grained implementation scope is verified by deterministic Git diff/scope
  checks instead of duplicating dynamic ACL logic in every agent.
- Secrets, private keys and protected environment files must not appear in source,
  prompts, logs, manifests or evidence.
- Security/secret/destructive/out-of-scope findings are blocking unless the
  command contract defines a safe deterministic handling route.

## Gates and evidence

- Schema-v2 execution mode is explicit per stage through `executors[stage_id]`; RUN never infers the executor from the stage name. Deployable pipelines also freeze an owner-selected `testing_strategy.mode=github|opencode_host|hybrid`; the model may recommend a mode but cannot choose it.
- Authoritative repository test/build/typecheck/lint validation completes only from deterministic `github-actions-gate-cli` evidence for the exact published candidate SHA, frozen workflow and terminal job. Terminal GitHub FAIL produces canonical job/step evidence; `diagnose`/`log` own redacted per-job logs. Pre-terminal failures produce canonical BLOCKED evidence with deterministic `failure_phase` and available identity. OpenStage never delegates CI-log retrieval or reshaping while GitHub authentication is available. Candidate CI uses explicit read-only GitHub permissions, SHA-pinned actions, no secrets and no `paths`/`paths-ignore` push filters. Every frozen `required_jobs[]` job and the terminal job must complete successfully. Natural-language PASS or a local command cannot satisfy `github_ci`.
- `gate-runner-cli` is authoritative only for stages explicitly frozen as `local_gate` (for example fast/precheck/docs or project/runtime checks). `stage-cli complete` verifies the canonical machine evidence before transitioning a `local_gate`, `github_ci`, `github_dev` or `git_publish` stage.
- Candidate CI uses explicit read-only permissions, no candidate secrets and no path filters that could skip the authoritative candidate push. Missing or incompatible project GitHub CI is planned implementation work: PLAN freezes a bootstrap/adaptation work item and workflow scope, RUN implements and validates that candidate-safe workflow in the target project, then the candidate is published and tested by GitHub. There is no local fallback for authoritative CI. Existing `github_dev` may be disposable or trusted stateful. Both consume the exact source-CI artifact **and its SHA-256 digest**. Stateful DEV additionally requires a verified GitHub Environment/trusted ref and frozen non-cancelling concurrency group. If stateful DEV automation is missing, PLAN may freeze it under `future_github_gates`: RUN authors it now but cannot execute it until it is merged into the trusted ref; current-run fresh+upgrade runtime validation remains in candidate CI.
- Repository package-manager identity is authoritative for local JS gates. A pnpm project must use pnpm/corepack-pnpm local gates; missing pnpm blocks instead of falling back to npm or dependency-installing `npx --yes`.
- Qualitative review gates may be model-driven but blockers must cite an observed
  defect or approved requirement/contract/security rule.
- Required gate that cannot execute or be verified fails closed.
- Evidence identifies run/pipeline/gate, observed result and immutable candidate identity when relevant. GitHub evidence additionally binds workflow, run ID/attempt, event, head SHA, terminal/required jobs, artifact ID and `sha256:` digest; DEV evidence binds its source CI run and the same source artifact digest.

## Candidate provenance and runtime validation

- For deployable runtime with a reproducible installer, validation should trace:

```text
approved base/source -> candidate SHA -> installed candidate/artifact -> evidence
```

- Every v2 pipeline explicitly declares `deployable: true|false`. A deployable pipeline freezes `deployment_validation` with distinct fresh-install and upgrade/repeat-install required jobs; both must PASS against the same candidate artifact/SHA. Runtime validation tests the approved candidate artifact/SHA, not an uncommitted local development tree.
- `git-worktree-cli publish` owns staging, candidate commit creation, non-force push and remote SHA verification; RUN must not ask the owner to perform those Git operations when the CLI is available.
- Planned source-mutating agent/documentation stages precede candidate publication. A source-changing fix after candidate publication produces a new candidate SHA. All prior GitHub CI/artifact/DEV/runtime evidence is stale and affected gates must run again for the new SHA.

## Runtime and rollback

- Concurrent mutation of the same shared external runtime target requires a
  deterministic runtime lock or equivalent external serialization.
- Release-affecting work defines rollback or explicitly records `not_applicable`
  with reason.
- If project policy declares an external SSH CD target, PLAN must freeze a deterministic `deployment-target-cli inspect` reachability/authentication result and RUN must recheck it before deployment. Agents never receive raw SSH permission.
- Deployment/runtime failure cannot be converted to PASS by LLM judgement.

## Review findings and fix cycles

- Review findings are `technical_fix | replan | security_stop | scope_stop | secret_stop | destructive_stop | optional`.
- Only `technical_fix` may be repaired automatically inside frozen scope.
- Before every automatic repair, RUN records the attempt through deterministic `stage-cli fix-cycle`; maximum automatic technical-fix cycles are **3 per stage/work-item**. The fourth call fails closed.
- `replan` and security/scope/secret/destructive findings block immediately and never consume a fix cycle.
- Lifecycle terms are distinct: pre-init planning revision stays on the same run-id; `technical_fix` stays on the same approved run; a frozen-manifest correction after init uses deterministic `stage-cli supersede` with reason-coded lineage and copies no runtime/machine evidence; architecture/scope/main-drift replan creates a new reason-coded run.

## Status semantics

- `ready` means the frozen functional milestone `ready_after_stage` has passed.
- `release_ready` means the frozen release milestone `release_ready_after_stage` has passed.
- `completed` means every frozen stage, including required docs/finalization, has terminal successful evidence.
- Pipelines may continue executing later frozen stages after reaching `ready` or `release_ready`.

## Approval

- Owner approval is required only where PLAN/manifest requires an owner decision
  or design-freeze approval.
- `--unattended` avoids duplicate interaction inside already approved scope; it
  does not waive deterministic gates, scope, security or owner decisions.
- Explicit exceptions are scoped and recorded; they cannot bypass deterministic
  safety controls.

## GitHub Issue audit

- GitHub Issue sourced runs persist each actual pipeline-status transition to a durable outbox and synchronize idempotent Issue comments.
- Failed delivery stays pending and must be drained before publish/PR handoff.
- PR handoff records the exact PR number and uses close keywords for completed Issues; the owner merges the PR.

## Planning evidence integrity

- For schema v2, `planning_readiness.design_freeze=true`, non-empty `required_gates[]`,
  ready gate records, required planning artifacts, work-item hashes and (for Issue runs)
  `source_snapshot_sha256` are mandatory before init.
- Stage validation fails if a frozen Issue snapshot or project policy changes after init.
- GitHub Issue snapshots are immutable evidence. Use the deterministic `github-issue-cli show`
  reader; never temporarily rewrite the snapshot for readability.

## Completion

A run is complete only when all required DAG nodes/stages reach successful
terminal state, required evidence exists, candidate/runtime conditions are
satisfied where applicable, and no blocking decision/risk remains.
