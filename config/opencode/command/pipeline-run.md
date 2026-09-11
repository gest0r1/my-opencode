---
description: Выполнить утверждённый OpenStage pipeline manifest
tags: [pipeline, execution, unattended, github-handoff]
---

# Pipeline Run

Выполни утверждённый manifest через **OpenStageOrchestrator**. Оркестратор владеет стадиями, routing и gates; дочерние агенты выполняют только свои ограниченные роли.

## Syntax

```text
/pipeline-run <run-id> [--unattended] [--no-session-reuse]
/pipeline-run <run-id> github <handoff-id> [--unattended] [--no-session-reuse]
```

Без `run-id` запроси выбор manifest. Неизвестные positional args или `github` без `handoff-id` → `blocked`.

## Normal preflight

1. Найди manifest/state и выполни `stage-cli validate`.
2. Проверь approval, dependencies, allowed paths, conflict groups, locks и design-freeze readiness.
3. Проверь отсутствие открытых blocking decisions.
4. Запускай только стадии, присутствующие в утверждённом pipeline.

Ошибка preflight → `blocked`, без реализации.

## Stage execution

Для каждой стадии:

1. `stage-cli start`;
2. вызови ровно профильного агента из OpenStage;
3. передай компактный structured packet: objective, acceptance, constraints, input artifacts, allowed scope, validation/evidence paths;
4. сохрани evidence;
5. PASS → `stage-cli complete`;
6. finding классифицируй как `technical_fix | replan | scope/security/secret/destructive | optional`.

`technical_fix` внутри уже утверждённого scope может идти в fix-loop. `replan`, выход за scope, security/secret/destructive decision → stop/block.

`--unattended` отменяет только лишние вопросы внутри уже утверждённого scope; он не отменяет permissions, security gates и replan stops.

## Session reuse: native task_id + semantic router

OpenCode нативно умеет продолжать child session по `task_id`. Но `task_id` — только transport handle: он не определяет, **какой логический work item** можно продолжать, особенно когда параллельно работают несколько детей одной роли.

Поэтому `pipeline-runtime` остаётся тонким safety/router layer поверх штатного `task_id`.

### Logical identity

Для каждого потенциально reusable вызова identity строго:

```text
{run_id, pipeline_id, stage, role, work_item_id}
```

`work_item_id`:
- стабилен между baseline и technical-fix для одного задания;
- уникален для параллельных work items;
- берётся из TaskManager/manifest;
- не содержит timestamp, random UUID или loop number.

### Eligible roles

Reuse разрешён только:

```text
CoderAgent
TestEngineer
BuildAgent
```

и только для `technical_fix` того же exact work item.

Всегда fresh: StoryMapper, SeniorStoryReviewer, ArchitectureAnalyzer, ContractManager, PrioritizationEngine, ADRManager, SeniorTechnicalPlanReviewer, TaskManager, CodeReviewer, OpenDevopsSpecialist, DocWriter.

### Invocation protocol

Перед каждым eligible child invocation, если reuse не отключён:

```text
pipeline_runtime_prepare(
  run_id,
  pipeline_id,
  stage,
  role,
  work_item_id,
  loop,
  technical_fix,
  state_revision,
  previous_state_revision?,
  evidence_path?,
  changed_files?,
  diff_path?,
  required_reread?
)
```

Сразу следующий matching `task()` prompt содержит:

```text
<pipeline_work_item id="<same-work-item-id>"/>
```

Модель не выбирает `task_id`. Router удаляет model-supplied `task_id` и может подставить нативный OpenCode `task_id` только для exact identity после проверок состояния.

Baseline (`technical_fix:false`) всегда fresh, но завершившийся child регистрируется. Fix (`technical_fix:true`) может resume только exact registered child.

### Fresh fallback

Fresh вместо reuse при: отсутствующей session, compaction/error/cancel/stale/in-progress, identity mismatch, revision mismatch, отсутствующем/stale evidence/diff/reread, неверном marker. Fresh fallback сам по себе не блокирует pipeline.

При параллельном исполнении router связывает завершение с native call ID и work_item_id; запрещено выбирать «последнюю session данной роли».

Registry:

```text
.tmp/pipelines/<run-id>/session-registry.json
```

Metrics:

```text
.tmp/pipelines/<run-id>/reuse-metrics/events.jsonl
```

## GitHub validation handoff

Режим `github` применяется, когда planning/implementation уже зафиксированы внешним исполнителем, а OpenCode должен валидировать immutable result и при необходимости сделать только допустимый technical fix.

Handoff ref:

```text
origin/handoff/<handoff-id>
```

Обязателен `.opencode/pipeline-handoff.json` с как минимум: `schema_version`, `provider`, `handoff_id`, `run_id`, `repository`, `source_branch`, `source_sha`, `pipeline_id`, `validation_stages`, `allowed_fix_scope`, `acceptance`, validation commands.

Подготовка только через:

```text
github_handoff_prepare(run_id: "<run-id>", handoff_id: "<handoff-id>")
github_handoff_status(run_id: "<run-id>")
```

Требования: clean worktree, exact source SHA, repository match, локальная `pipeline/<run-id>` строго от `source_sha`. Нельзя использовать свободные `git pull/checkout/push` вместо handoff tools.

В GitHub mode выполняются только разрешённые validation stages. Technical fix допускается только внутри `allowed_fix_scope`; replan/scope/security/secret/destructive finding блокирует run.

После PASS:

```text
github_handoff_publish(run_id: "<run-id>")
github_handoff_status(run_id: "<run-id>")
```

Фиксируй `source_sha`, `validated_sha`, fix commits (если были), validation evidence и session-reuse decisions.

## Prohibited

- менять approved manifest/rules во время run;
- пропускать обязательный stage;
- продолжать зависимый batch до завершения dependency;
- вручную выбирать/reuse `task_id` в обход router;
- использовать один work_item_id для разных parallel items;
- публиковать изменения за пределами allowed scope;
- force-push или обход GitHub handoff tools.

## Final result

Верни компактно: pipeline status, stages, evidence, build/review/test/release results, fix-loops, blockers/risks, session-reuse decisions; в GitHub mode также source/validated SHA и fix commits.
