# Pipeline разработки My OpenCode

Канонические команды: `config/opencode/command/pipeline-*.md`. Deterministic state/Git gates: `config/opencode/skills/task-management/scripts/`.

## Ответственный агент
Конвейером управляет основной агент **OpenStageOrchestrator** в роли StageOrchestrator. Это только фиксация ответственности; специализированные planning/implementation/review/test/build субагенты остаются без изменений.

## Источник PLAN
`/pipeline-plan #51 #47`, файл, текст или пустая команда с linked GitHub Issue refs из OpenChamber. Fallback на `docs/plan.md` отсутствует. `#N` относится только к repository текущего worktree. OpenChamber передаёт refs; PLAN заново читает Issue из GitHub.

## Stories
Один стабильный `.tmp/pipelines/<run-id>/stories/issue-N.md` на Issue; корректировки переписывают его. Reviews append-only.

## Main freshness
Manifest фиксирует `planning_base_sha` и `freshness_sensitive_paths`. `git-worktree-cli freshness` в начале RUN, пока worktree чистый, fetch'ит `origin/main`: релевантный drift → `STALE_PLAN` и replan; нерелевантный → deterministic merge и `run_base_sha` в `git-runtime.json`/state; frozen manifest не меняется.

## GitHub audit
Каждый реальный pipeline-status transition попадает в durable `github_outbox` и публикуется idempotent comment в mapped Issues. Перед publish/PR pending должен быть ноль. После успешного run PR содержит `Closes #N`, а `pipeline-github-sync.mjs link-pr <run-id> <pr-number>` фиксирует точный PR в Issue/state. Merge в main выполняет владелец.

## Команды
- `/pipeline-plan`
- `/pipeline-run <run-id>`
- `/pipeline-status <run-id>`
- `/pipeline-refresh` при релевантном main drift

Общая `/pipeline` не используется.
