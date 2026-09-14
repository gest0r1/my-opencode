---
document_type: pipeline_rules
rules_version: 1
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
- Effective rules source/version/SHA and approved manifest SHA are frozen at
  state initialization; later mutation blocks validation.

## Planning and scope

- PLAN does not modify implementation source, Git history, runtime or secrets.
- Decisions requiring owner judgement are explicit before design-freeze approval.
- Open decisions prohibit initialization of an approved design-freeze run.
- Approved implementation scope is expressed by the frozen manifest, including
  minimal `allowed_change_paths` when source changes are expected.
- Scope expansion requires re-planning and owner approval.

## DAG and parallelism

- PLAN compiles prerequisites and ordinary source/migration/fixture conflicts
  into an acyclic dependency DAG.
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

- Machine build/test/install/runtime validation completes only from deterministic
  gate-runner results and evidence, not natural-language PASS.
- Qualitative review gates may be model-driven but blockers must cite an observed
  defect or approved requirement/contract/security rule.
- Required gate that cannot execute or be verified fails closed.
- Evidence identifies run/pipeline/gate, observed result and immutable candidate
  identity when relevant.

## Candidate provenance and runtime validation

- For deployable runtime with a reproducible installer, validation should trace:

```text
approved base/source -> candidate SHA -> installed candidate/artifact -> evidence
```

- Runtime validation tests the approved candidate artifact/SHA, not an uncommitted
  local development tree, when the manifest requires candidate installation.
- A fix after candidate publication produces a new candidate identity and reruns
  affected installation/runtime validation.

## Runtime and rollback

- Concurrent mutation of the same shared external runtime target requires a
  deterministic runtime lock or equivalent external serialization.
- Release-affecting work defines rollback or explicitly records `not_applicable`
  with reason.
- Deployment/runtime failure cannot be converted to PASS by LLM judgement.

## Approval

- Owner approval is required only where PLAN/manifest requires an owner decision
  or design-freeze approval.
- `--unattended` avoids duplicate interaction inside already approved scope; it
  does not waive deterministic gates, scope, security or owner decisions.
- Explicit exceptions are scoped and recorded; they cannot bypass deterministic
  safety controls.

## Completion

A run is complete only when all required DAG nodes/stages reach successful
terminal state, required evidence exists, candidate/runtime conditions are
satisfied where applicable, and no blocking decision/risk remains.
