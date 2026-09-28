# Универсальный pipeline target-проектов

Канонические команды живут в `config/opencode/command/pipeline-*.md`, deterministic state/Git/GitHub gates — в `config/opencode/skills/task-management/scripts/`.

OpenCode и OpenChamber являются средой запуска pipeline. Они не являются обязательным предметом `/pipeline-*`: их собственная разработка может выполняться отдельно через GPT/PR-процесс.

## Ответственный агент

Конвейером управляет основной агент **OpenStageOrchestrator**. Planning/implementation/review/test/build/DevOps субагенты выполняют только замороженные work items и не оркестрируют pipeline самостоятельно.

## Источник PLAN

`/pipeline-plan #51 #47`, файл, текст или пустая команда с linked GitHub Issue refs из OpenChamber. Fallback на `docs/plan.md` отсутствует. `#N` относится только к repository текущего worktree. OpenChamber передаёт refs; PLAN заново читает Issue из GitHub.

## Authoritative CI/CD

Schema v2 фиксирует явный executor каждой стадии. Финальные test/build/typecheck/lint подтверждаются только `github_ci` для exact published candidate SHA. Local gates допустимы только как явно замороженные fast/precheck/docs проверки и не заменяют GitHub CI.

Для deployable pipeline PLAN строит capability matrix и владелец выбирает один режим:

- `github` — install/runtime validation в GitHub/disposable среде;
- `opencode_host` — trusted GitHub CD устанавливает exact CI artifact на машину, где работает OpenCode;
- `hybrid` — сначала GitHub automated validation, затем тот же artifact разворачивается на OpenCode host и проходит owner acceptance.

Для OpenCode-host CD deterministic probe проверяет trusted workflow, Environment, trusted ref, configured secret names/runner labels и реальный GitHub→host probe. Агенты не получают raw `gh`/SSH credentials.

CI/CD evidence связывает candidate SHA, workflow run/attempt, required jobs, artifact ID/digest, source CI run и, для OpenCode-host, `target_id`. Terminal FAIL хранит failed jobs/steps; `diagnose` пишет отдельные redacted multiline job logs, а `log --job|--job-id` читает один exact-run job. Pre-terminal ошибки сохраняются как BLOCKED с `failure_phase`. Владелец не выгружает и не преобразует CI logs, пока deterministic GitHub auth работает. Stateful CD требует protected Environment и non-cancelling concurrency.

Если CI/CD workflow отсутствует, PLAN замораживает bootstrap work item. Candidate-safe CI может быть создан и запущен в текущем run. Новый privileged stateful CD workflow создаётся как `future_github_gates` и становится runnable только после merge в trusted ref.

## Stories

Один стабильный `.tmp/pipelines/<run-id>/stories/issue-N.md` на Issue; корректировки переписывают его. Reviews append-only.

## Existing implementation / V1 → V2

Если новая V2-планировка продолжает уже закоммиченную разработку из старого run, PLAN фиксирует её через `git-worktree-cli baseline <base-sha>` как `preserved_baseline`: exact HEAD, список путей и diff identity. Этот historical diff может оставаться в ветке, но не становится writable scope; изменение preserved-файла новым RUN всё равно требует `allowed_change_paths`.

До owner approval обязательны `stage-cli plan-run-preflight`, `git-worktree-cli adopt` и `git-worktree-cli verify`. Поэтому schema/scope/baseline ошибки должны обнаруживаться до утверждения.

После `init` frozen manifest не правится. Коррекция frozen V2 создаётся командой `stage-cli supersede <old-run> <new-run> --reason <code>`: копируется только planning/source/work-item контекст, но не state/candidate/gate/GitHub evidence. Для каждого нового run сохраняется reason-coded lineage.

## Live rules

Project `docs/pipeline-rules.md` and OpenCode's distribution `pipeline-rules.default.md` follow the same rule lifecycle. Pipeline commands and their agents never edit either rules source.

If the owner or distribution changes rules while the pipeline is stopped, the next RUN continuation reads the current file. A changed rules version/SHA updates machine-owned audit metadata and does not block by itself. Missing, unreadable, malformed rules or an invalid `edit_policy` still block. Never edit `state.json` manually.

## Main freshness

Manifest фиксирует `planning_base_sha` и `freshness_sensitive_paths`. `git-worktree-cli freshness` в начале RUN, пока worktree чистый, fetch'ит `origin/main`: релевантный drift → `STALE_PLAN` и replan; нерелевантный → deterministic merge и `run_base_sha` в `git-runtime.json`/state; frozen manifest не меняется.

## GitHub audit

Каждый реальный pipeline-status transition попадает в durable `github_outbox` и публикуется idempotent comment в mapped Issues. Перед publish/PR pending должен быть ноль. `git-worktree-cli publish` самостоятельно выполняет stage/commit/non-force push и проверяет remote SHA; owner не должен вручную выполнять `git add`/`commit`/`push` во время RUN. После успешного run PR содержит `Closes #N`, а `pipeline-github-sync.mjs link-pr <run-id> <pr-number>` фиксирует точный PR в Issue/state. Merge в main выполняет владелец.

## Команды

- `/pipeline-plan`
- `/pipeline-run <run-id>`
- `/pipeline-status <run-id>`
- `/pipeline-refresh` при релевантном main drift

Общая `/pipeline` не используется.
