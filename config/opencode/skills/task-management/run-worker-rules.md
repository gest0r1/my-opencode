# RUN worker stage — on-demand instructions

Only read this file when the **validated RUN dispatch packet** includes `run_stage_rules_path`. This is **not** the universal prompt for CoderAgent, TestEngineer or BuildAgent; standalone tasks do not depend on it.

## Source of truth and rights

- Read the complete current dispatch packet `pipeline_dispatch_packet` and frozen work-item file by path. `effective_scope`, `write_scope`, `work_item_scope`, `repair_paths`, `reference_paths` and the exact tool permission rules constrain the work. They are not an invitation to widen scope. Only `write_scope` authorizes writes, and only an existing runtime/owner decision can enlarge it.
- The role's configured permissions are already available. Do not probe random shell commands to infer rights, add an extra permission-check call, or call a parent-owned stage-cli operation. A command with `ask` requires actual owner confirmation; describing it as permitted is not confirmation.
- Universal agent instructions still apply; this file gives only the additional constraints of this RUN stage.

## Machine evidence and recovery

- Execute supplied tests only as the **role's own instruction** and exact dispatch packet prescribe. The CLI, not this supplemental prompt, verifies bound PASS/freshness; advisory failures are not chargeable fix-cycles.
- `DIAGNOSTIC_NO_PROGRESS` needs a real change or a recorded new hypothesis in the current RUN's `checks/`; ask for independent review if the root cause remains unknown. Do not repeatedly retry the same hypothesis.

## Edit and evidence economy

- Prefer precise edits against the recently read fragment. If an edit fails because the old text is not found/ambiguous, re-read **only that fragment once** and retry with a unique anchor. Do **not** re-read every entire file before each otherwise successful edit.
- Unknown paths are corrected by looking at the frozen work item, local path list and parent dispatch evidence; do not enumerate the entire repository without reason.
- For each completed work item return only status, blocker (if any) and evidence/changed file paths. Full logs and machine evidence remain in files; do not paste them back into the coordinator conversation.

These rules add **zero** new happy-path tool calls. The existing machine-owned dispatcher, permission guards and final gate are authoritative.
