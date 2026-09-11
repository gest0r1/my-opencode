# Active agent set

This file documents the **active** `my-opencode` roles. Historical OAC agents are preserved in branch `archive/legacy-oac-agents-2026-09-11` and are intentionally not installed by the current runtime.

Model assignment is **not part of the role contract**. Models may be changed independently after role/harness validation.

## Primary agents

| Agent | Purpose | Escalation / boundary |
|---|---|---|
| `OpenAgent` | Universal questions, operational tasks, research, documents, integrations and light coordination | Coding workflow → OpenCoder; complex/risky development → OpenStageOrchestrator |
| `OpenCoder` | Short/local code changes with targeted validation | Architecture/contracts/schema/auth/security/deployment/cross-component scope → OpenStageOrchestrator |
| `OpenStageOrchestrator` | Full controlled development pipeline | Owns stages; does not implement product code directly |

## OpenStage pipeline roles

| Agent | Role | Writes product source? | Session policy |
|---|---|---:|---|
| `ContextScout` | Minimal internal context discovery | No | Fresh/on-demand |
| `ExternalScout` | Current version-specific external docs | No | Fresh/on-demand |
| `StoryMapper` | Stories/scenarios/acceptance criteria | No | Always fresh |
| `SeniorStoryReviewer` | Independent story quality gate | No | Always fresh |
| `ArchitectureAnalyzer` | Components/boundaries/integration/risks | No | Always fresh |
| `ContractManager` | API/data/event/module contracts | No | Always fresh |
| `PrioritizationEngine` | Dependency order, MVP, parallel-safe slices | No | Always fresh |
| `ADRManager` | Records durable decisions already approved by planning | ADR only | Always fresh |
| `SeniorTechnicalPlanReviewer` | Independent architecture/contract/ADR/readiness gate | No | Always fresh |
| `TaskManager` | Atomic work-item graph + stable IDs + validation expectations | `.tmp` task artifacts only | Always fresh |
| `BatchExecutor` | Coordinates independent parallel work items | No | Fresh coordinator |
| `CoderAgent` | One bounded implementation work item | Yes, within task scope | Reuse only for same-item technical fix |
| `BuildAgent` | Build/typecheck/lint sanity gate | No | Reuse only for same-item technical fix |
| `CodeReviewer` | Independent correctness/security/architecture review | No | Always fresh |
| `TestEngineer` | Independent acceptance/integration testing | Tests/fixtures only | Reuse only for same-item technical fix |
| `OpenDevopsSpecialist` | Non-destructive release/runtime validation | No | Always fresh |
| `DocWriter` | Documentation affected by validated change | Docs only | Always fresh |
| `WebResearcher` | Broad current public research | No | Fresh/on-demand |
| `OpenFrontendSpecialist` | Optional bounded UI implementation specialist | Yes, within supplied UI task | Same boundaries as implementation task |

## OpenStage order

```text
Intake / Context
  → StoryMapper
  → SeniorStoryReviewer
  → optional user story verification
  → ArchitectureAnalyzer + ContractManager + PrioritizationEngine
  → ADRManager
  → SeniorTechnicalPlanReviewer
  → TaskManager
  → CoderAgent / BatchExecutor
  → BuildAgent
  → CodeReviewer
  → technical fix loops if needed
  → TestEngineer
  → OpenDevopsSpecialist when relevant
  → DocWriter when relevant
  → Handoff
```

Required stages are never silently skipped. A stage may return `not_required` only when its own contract permits it.

## Session routing

Stock OpenCode provides native `task_id` session resume. The local `pipeline-runtime` plugin only decides **which exact logical work item may safely reuse which native task_id**, including multiple parallel children of the same role.

Identity:

```text
{run_id, pipeline_id, stage, role, work_item_id}
```

Only `CoderAgent`, `BuildAgent` and `TestEngineer` may reuse a prior child session, and only for a technical fix of the same exact work item. Review/planning roles are always fresh.

## Hard boundaries

- Permissions/tools, not prose, are the security boundary.
- Planning/review/build agents cannot modify product source.
- TestEngineer cannot silently repair product implementation.
- DevOps does not execute arbitrary/destructive model-generated commands.
- Business MCP integrations are denied globally and explicitly exposed to OpenAgent only.
- Secret files are not writable by development agents.
- No custom model fallback layer and no OpenCode core patch for fallback.
