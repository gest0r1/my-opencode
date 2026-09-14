---
document_type: pipeline_rules
rules_version: 1
rules_scope: opencode_default
edit_policy: distribution_only
---

# Default pipeline policy

This file defines universal policy invariants for OpenStage pipelines. It does not define the procedural workflow of `/pipeline-plan`, `/pipeline-run`, or `/pipeline-status`.

## Authority and conflict handling

1. Deterministic CLI safety gates have highest authority.
2. Command contracts (`/pipeline-plan`, `/pipeline-run`, `/pipeline-status`) define procedure and cannot be overridden by project policy.
3. Effective pipeline rules define project-independent policy invariants.
4. The approved manifest defines the frozen scope, stages, dependencies, gates and allowed paths for one run.
5. Task/subtask instructions may refine work inside the approved scope but cannot weaken higher-level constraints.
6. LLM judgement cannot override deterministic failures, security restrictions, Git integrity, runtime locks, approvals, or evidence requirements.

Any unresolved conflict is fail-closed: mark the run `blocked` and do not continue implementation or release.

## Effective rules

- If repository-local `docs/pipeline-rules.md` exists, it is the effective project policy.
- If it does not exist, this default policy is the effective policy.
- An existing but malformed or invalid project policy must block; do not silently fall back to the default policy.
- Agents must never create, copy, rewrite, or bootstrap `docs/pipeline-rules.md` automatically during planning or execution.
- The effective rules source, version and SHA256 are frozen when pipeline state is initialized. Any later change blocks validation.

## Planning and scope

- Planning may create planning/state artifacts only in explicitly permitted runtime locations.
- Planning must not modify implementation source code, Git history, secrets, runtime environments, or deployment state.
- Functional, architectural, security, migration, contract, release or rollback decisions that require owner judgement must be explicit before approval.
- Open decisions prohibit approval of a design-freeze manifest.
- Approved scope must not be expanded implicitly during execution. Scope expansion requires re-planning and owner approval.

## Pipeline decomposition and parallelism

- Dependencies must be explicit in the manifest.
- Parallel execution is allowed only when dependencies are complete and there is no shared `exclusive_path`, conflict group, migration/fixture collision, or deployment/runtime lock.
- A declared `parallel` capability is advisory; deterministic conflict constraints win.
- A dependent pipeline must not start before its declared dependency is complete.

## Git and source integrity

- Source identity must be tied to exact immutable commit SHA values where Git setup or external handoff is used.
- Protected/default branches must not be mutated directly by pipeline automation unless an explicit deterministic gate authorizes the operation.
- Branch/source checkout may modify only the allowlisted paths from the approved manifest or handoff contract.
- Clean-worktree, branch, source SHA, repository and path-scope failures are blocking.
- Arbitrary Git commands must not be used to bypass Git gate tooling.

## Least privilege and secrets

- Agent permissions are deny-by-default outside the scope required for their stage.
- Secrets, credentials, private keys and protected environment files must not be written into source, prompts, logs, evidence, manifests or runtime artifacts.
- Security, destructive, secret or out-of-scope findings are blocking unless an explicit higher-authority contract defines a safe deterministic handling path.

## Gates and evidence

- A stage is successful only after its deterministic gate and required evidence succeed; a natural-language agent report alone is not completion.
- If a required build, test, review, security, release or runtime gate cannot be executed or its result cannot be verified, the gate fails closed.
- Evidence must identify the relevant stage and be sufficient to verify the claimed result without relying on model memory.
- Failed or blocked stages may resume only after the blocking cause is addressed and scope remains valid.

## Build, artifacts and provenance

- Release artifacts must be traceable to the source revision that produced them.
- Tags or mutable names alone are insufficient provenance when an immutable digest/image ID/artifact identity is available.
- Release validation must verify the artifact actually intended for deployment, not merely a similarly named build.

## Runtime, deployment and rollback

- Concurrent mutation of the same deployment/runtime target requires an explicit lock or equivalent deterministic exclusion.
- Release-ready status requires applicable release/runtime validation from the approved gate profile.
- A release-affecting pipeline must define rollback or explicitly record why rollback is not applicable.
- Deployment or release failure must not be converted to PASS by LLM judgement.

## Approval and exceptions

- Owner approval is required where the command contract or manifest requires it.
- `--unattended` removes unnecessary interaction only inside already approved scope; it does not waive approvals, gates, evidence or safety constraints.
- Exceptions/waivers must be explicit, scoped, attributable and recorded as durable evidence. An exception must never silently weaken deterministic safety gates.

## Completion

A pipeline is complete only when all required stages in the approved manifest reach their terminal successful state, required evidence is recorded, dependencies and release conditions are satisfied, and no blocking risk or open decision remains.
