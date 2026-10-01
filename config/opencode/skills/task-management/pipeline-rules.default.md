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
- Effective rules source/version/SHA are recorded in state for audit, but rules remain live external policy rather than frozen RUN input.
- Project-local `docs/pipeline-rules.md` and distribution `pipeline-rules.default.md` follow the same lifecycle: pipeline commands/agents never edit them, while owner/distribution changes made between pipeline commands are valid.
- On the next RUN continuation, `stage-cli validate` reads the current rules file. A changed rules version/SHA updates machine-owned state metadata/history and does not BLOCK by itself.
- Missing, unreadable, malformed rules or an invalid `edit_policy` still BLOCK. Agents never edit `state.json` manually.

## Planning and scope

- PLAN freezes requirements, owner decisions, acceptance criteria and a minimal base implementation scope; it is not required to predict every future test/fixture/mock file.
- Base scope supports only exact repository-relative paths or `directory/**`; other wildcard syntax is invalid before approval.
- RUN may maintain machine-owned effective scope in state without mutating the frozen manifest. Concrete test/support paths inside an already-approved `apps/<name>` or `packages/<name>` component may be added automatically.
- Additional production/config paths require fresh ArchitectureAnalyzer + SeniorTechnicalPlanReviewer evidence proving a bounded implementation clarification with no owner decision, requirements/acceptance/external-contract/security-boundary/destructive change.
- Runtime scope never auto-authorizes protected project-policy paths, `.github/workflows/**`, `.opencode/**`, rules, secrets or environment files.
- Scope preflight happens before `technical_fix` is counted. A path discovered by Git verify after a cycle starts is resolved inside the same cycle; never edit manifest/state manually to bypass scope.


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
- Repository test/build/typecheck/lint/install/runtime validation may execute locally when the stage is frozen as `local_gate`; `gate-runner-cli` evidence is authoritative for that stage. For deployable sinks, PLAN places the deterministic fail-fast set after `git_verify` and before `git_publish`, then requires one independent artifactless `github_ci` for the exact published candidate SHA. Terminal GitHub FAIL produces canonical job/step evidence; pre-terminal GitHub failures produce canonical BLOCKED evidence with deterministic `failure_phase`; `diagnose`/`log` own redacted per-job logs. Natural-language PASS cannot satisfy either executor.
- `gate-runner-cli` is authoritative for every stage explicitly frozen as `local_gate`, including test/lint/typecheck/build, fresh/repeat-install and runtime/smoke checks. `stage-cli complete` verifies canonical machine evidence before transitioning a `local_gate`, `github_ci`, `github_dev` or `git_publish` stage.
- Final candidate CI uses explicit read-only permissions, no candidate secrets and no path filters that could skip the candidate push. Canonical v2 candidate CI is artifactless: no `actions/upload-artifact`/`download-artifact`; provenance is exact `candidate_sha` + GitHub workflow run/attempt + required-job results. Keep this final CI lean and independent; do not duplicate expensive fresh/upgrade/runtime work already covered by deterministic local gates without a concrete reason. Missing or incompatible final CI remains planned bootstrap/adaptation work and cannot be replaced by local-only delivery validation. `github_dev` remains available for the special GitHub-initiated `opencode_host` strategy; ordinary `hybrid` post-CI CD uses `local_gate`.
- Repository package-manager identity is authoritative for local JS gates. A pnpm project must use pnpm/corepack-pnpm local gates; missing pnpm blocks instead of falling back to npm or dependency-installing `npx --yes`.
- Qualitative review gates may be model-driven but blockers must cite an observed
  defect or approved requirement/contract/security rule.
- Required gate that cannot execute or be verified fails closed.
- Evidence identifies run/pipeline/gate, observed result and immutable candidate identity when relevant. Artifactless GitHub evidence binds workflow, run ID/attempt, event, exact candidate/head SHA and terminal/required jobs; DEV evidence additionally binds the exact source-CI run and installed candidate SHA.

## Candidate provenance and runtime validation

- For deployable runtime with a reproducible installer, validation should trace:

```text
approved base/source -> final cumulative candidate SHA -> installed candidate SHA -> evidence
```

- Every v2 pipeline explicitly declares `deployable: true|false`. Pipelines that are prerequisites for other blocks define a source-ready `ready_after_stage`; downstream work may start once that milestone is complete even if the upstream later hits an external CI/CD blocker. For one delivered product, upstream feature blocks should be non-deployable and the terminal DAG sink owns the single integrated publish/validation chain. A deployable sink freezes `deployment_validation.stage` as the final `github_ci` exact-SHA gate. Legacy `fresh_job`/`upgrade_job` metadata may remain in old manifests but is not required; fresh/repeat-install belongs in local gates unless the project has a specific GitHub-only constraint.
- `git-worktree-cli publish` owns staging, candidate commit creation, non-force push and remote SHA verification; RUN must not ask the owner to perform those Git operations when the CLI is available.
- Planned source-mutating agent/documentation stages precede candidate publication. A source-changing fix after candidate publication produces a new candidate SHA. All prior GitHub CI/DEV/runtime evidence is stale and affected gates must run again for the new SHA. PR handoff is forbidden until deployment-validation evidence matches the final cumulative candidate SHA.

## Runtime and rollback

- Concurrent mutation of the same shared external runtime target requires a
  deterministic runtime lock or equivalent external serialization.
- Release-affecting work defines rollback or explicitly records `not_applicable`
  with reason. Release packaging is separate from candidate CI: if the project has an actual release product, publish it only on the project release/tag event and prefer GitHub Release/package-registry assets over durable Actions artifacts.
- Only the GitHub-initiated `opencode_host` strategy requires a deterministic `deployment-target-cli inspect` reachability/authentication result and RUN recheck. Local `hybrid` CD uses the existing gate runner and never grants agents raw SSH/Docker/deployment shell permission.
- Deployment/runtime failure cannot be converted to PASS by LLM judgement.

## Review findings and fix cycles

- Review findings are `technical_fix | security_fix | replan | security_stop | scope_stop | secret_stop | destructive_stop | optional`.
- `technical_fix` and bounded `security_fix` may be repaired automatically. `security_fix` is allowed only when deterministic `stage-cli security-fix-check` validates machine-readable review evidence proving: bounded remediation, no owner decision, no requirements/AC/external-contract/security-boundary change, no privilege expansion, no secret exposure and no destructive change.
- Severity alone never forces a stop. A Critical/High security defect may remain `security_fix` when the frozen policy already determines the least-privilege/fail-closed remediation.
- Before every automatic repair, RUN records the attempt through deterministic `stage-cli fix-cycle`; `security_fix` additionally uses `--repair-class security_fix`. Both classes consume the same budget. The initial automatic fix budget is **5 per stage/work-item**.
- Owner may raise the run-wide ceiling at RUN start with `--fix-cycles N`; OpenStage maps that explicit owner option to deterministic `stage-cli fix-budget-set --cycles N`. The command only raises ceilings (maximum 20) and never lowers an existing stage budget. Per-stage `fix-budget-add` remains available during RUN.
- Exhausting the current budget does not interrupt an already-started repair. That cycle continues through its frozen review/gates (executor=`review` runs CodeReviewer); the owner checkpoint occurs only if the resulting finding requires another automatic repair beyond the current limit.
- At that checkpoint runtime replan may be offered, but ArchitectureAnalyzer/SeniorTechnicalPlanReviewer run only on explicit owner request. A plain `+N` grant means continue the current approach through deterministic `fix-budget-add`, without implicit architecture review. The owner may also grant `+N` cycles or request/approve runtime replan before exhaustion; deterministic owner commands update the current ceiling immediately.
- A runtime replan stays in the same RUN and current pipeline/stage/work-item. Fresh architecture + senior review may iterate with owner clarification, but implementation remains stopped. The final local plan must reach `awaiting_owner_approval` and receive explicit owner approval through deterministic `runtime-replan-approve --cycles N` before any new fix cycle is allowed.
- `--unattended` never supplies runtime-replan approval and never bypasses true security/secret/destructive owner checkpoints. A pending runtime replan cannot be bypassed by a direct budget grant.
- Runtime replan is only for a changed technical approach inside existing requirements/acceptance/contracts/security boundaries. If those boundaries change, use normal full replan/supersede.
- `security_stop` is reserved for a real owner security-policy/trust/access decision or a remediation that cannot satisfy the bounded `security_fix` contract. When such a stop is unavoidable, ask the owner only for the policy/business decision in plain language; provide the safest fail-closed default, concrete choices/consequences and a recommendation instead of asking the owner to design the security implementation. `secret_stop` covers actual secret/credential exposure or rotation/revocation decisions. `destructive_stop` covers irreversible/destructive remediation. `scope_stop` covers protected/sensitive or otherwise non-authorizable scope. These conditions use BLOCKED/resumable owner checkpoints rather than being reported as terminal implementation failure merely because the finding is security-related.
- `replan` and true security/scope/secret/destructive stops do not consume a fix cycle.
- Lifecycle terms are distinct: pre-init planning revision stays on the same run-id; `technical_fix`, bounded `security_fix` and approved runtime replan stay on the same approved run; a frozen-manifest correction after init uses deterministic `stage-cli supersede` with reason-coded lineage and copies no runtime/machine evidence; architecture/scope/main-drift replan creates a new reason-coded run.

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
