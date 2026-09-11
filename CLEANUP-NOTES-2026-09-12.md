# my-opencode cleanup notes

Working branch: `cleanup/upstream-aligned-2026-09-11`

## Design boundary

- Stock OpenCode core is used unchanged.
- `OpenStageOrchestrator` remains the owner of the full development pipeline.
- `OpenAgent` remains the universal primary agent.
- `OpenCoder` remains the short/local coding path and escalates complex/risky work to OpenStage.
- `ADRManager` is an explicit OpenStage planning stage.
- Legacy OAC agents remain recoverable from `archive/legacy-oac-agents-2026-09-11` but are removed from the active configuration.

## Session reuse decision

Do **not** remove `plugins/pipeline-runtime.ts` yet.

OpenCode's native `task_id` resumes a child session when the caller supplies that ID. Native OpenCode does not decide whether a logical work item is eligible for reuse and does not map parallel same-role work items to their correct prior `task_id`.

The local runtime plugin therefore remains a thin semantic safety/router layer around the native mechanism. Identity is `{run_id,pipeline_id,stage,role,work_item_id}` and reuse is limited to approved technical-fix loops for the same logical item. It must never implement its own model fallback or patch OpenCode core.

## Model fallback

Do not implement a custom model fallback chain. Revisit only if stock OpenCode adds explicit supported fallback semantics.

## Runtime agent path

Installer migrates managed agents to `~/.config/opencode/agents/`, which is the canonical shared path for modern OpenCode and OpenChamber. The former managed `~/.opencode/agent/` copy is removed to prevent duplicates.

## Secrets

Active config references MCP credentials through environment variables. Old values present in Git history remain compromised until revoked/reissued in the external providers; repository changes cannot perform that external rotation.
