# Pipeline prompt audit — 2026-11-05

Scope: instruction ownership, loader evidence, and prep-lane wording only. Read-only source review at branch head 086703269957a3adcc9aa74555cdc9b7f846a040; no live OpenCode process or installed runtime was inspected.

## Loader boundary and role/call map

| Contract | Canonical source and callers | What source proves |
|---|---|---|
| Selected workflow | config/opencode/command/pipeline-plan.md, pipeline-run.md; OpenStage entry contract at config/opencode/agent/core/openstage-orchestrator.md:119. Installer stages command files at scripts/install-opencode-generation.sh:122-124. | The source installer copies commands to installed commands/; the orchestrator says it loads only the active command. It does not prove a live process loaded a command in this environment. |
| Parent invariants and context transport | agent/core/openstage-orchestrator.md:121-145,151-175; selected plan/run command is its caller. | Owns shared authority boundaries, compact/file-backed handoffs, pre-dispatch validation, and parent routing. |
| ContextScout | agent/subagents/core/contextscout.md:8-24,40-74; /pipeline-plan dispatches it at command/pipeline-plan.md:169-176; OpenStage validates each destination at agent/core/openstage-orchestrator.md:130. | Role permits the full run-scoped .tmp/pipelines/<run-id>/planning/** subtree with machine-artifact denies; multiple support artifacts and one navigation index are compatible. Parent validation is a separate enforcement boundary. |
| TaskManager | Role/task contract agent/subagents/core/task-manager.md:62-64,84-97; called before freeze by command/pipeline-plan.md:217; RUN consumes frozen results at command/pipeline-run.md:46-48. | TaskManager owns work-item generation; the RUN command owns execution and uses stage-cli next as the only queue. |
| Code review | agent/subagents/code/reviewer.md:19-30,42-56; dispatch via command/pipeline-run.md:63. | Registered role prompt is passed for the review stage; it is not a global OpenStage prompt. |
| Story review / architecture | agent/subagents/code/senior-story-reviewer.md:19-58, agent/subagents/planning/architecture-analyzer.md:93-121; selected by command/pipeline-plan.md:174-177. | Distinct role contracts are invoked only for their selected planning gates. |
| Generic coding entry points | agent/core/opencoder.md:43-52, agent/core/openagent.md:39-46. | Both route /pipeline-* to OpenStage; generic coding workflow is outside canonical pipeline execution. |
| Agent install identity | scripts/install-opencode-agents.sh:58-83,90-110; full generation calls it at scripts/install-opencode-generation.sh:139-141. | Source role files are recursively found, then installed by frontmatter name as flat IDs; permissions normalize from Markdown. Installed IDs are the names used in task dispatch. |

## Duplication and drift found

- No identical full rule paragraph was confirmed in this scoped review. Prompt/token loading size and actual runtime prompt composition are unavailable.
- Prep semantics recur in the PLAN test-rework contract (pipeline-plan.md:183,217), TaskManager work generation (task-manager.md:62), RUN scheduler instructions (pipeline-run.md:46,68) and the parent reminder (openstage-orchestrator.md:143). These serve authoring, execution and invariant audiences. The parent phrase “lane runs first” was the one ambiguous/conflicting fragment: it could imply global serialization despite the explicit consumer dependencies and independent runnable lanes. It now says only declared consumers are preceded and keeps stage-cli next authoritative.
- The ContextScout “single compact context-packet” reminder at contextscout.md:73 means one navigation index, not one writable artifact; the permission and body at :8-24,42-60 explicitly permit multiple planning artifacts. The plan command at pipeline-plan.md:172 already records the same distinction. No contradictory single-file grant remains in these current sources.
- PLAN approval, RUN decision checkpoints, and replan approval retention refer to different lifecycle cases (pipeline-plan.md:294-310, pipeline-run.md:304-306, pipeline-replan.md:16). Keep them. Approval is a workflow audit, not cryptographic user provenance; no new identity or approval store is warranted.
- No broad prompt cleanup is supported by this scope. Preserve role permissions, dispatch boundaries, and required full-review gates.

## Change and checks

- Changed only the parenthetical in config/opencode/agent/core/openstage-orchestrator.md:143: prep precedes declared consumers only; independent lanes remain runnable under stage-cli next.
- Source check: inspected current remote files at 086703269957a3adcc9aa74555cdc9b7f846a040; target phrase existed once; replacement phrase is scoped to that phrase only.
- Tests were not run; this was an instruction-only wording correction. The branch ref was updated with expected-head 086703269957a3adcc9aa74555cdc9b7f846a040 (non-force lease).
