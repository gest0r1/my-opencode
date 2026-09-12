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

## Session reuse: stock OpenCode task_id + semantic router

OpenCode сам создаёт и возобновляет child session по `task_id`. Локальный `pipeline-runtime` не реализует жизненный цикл session и не заменяет штатный механизм. Он решает только одну отсутствующую в OpenCode задачу: какой логический work item имеет право получить какой native `task_id`, когда в pipeline есть несколько параллельных детей.

### Logical identity

Для каждого потенциально reusable вызова identity строго:

```text
{run_id, pipeline_id, stage, role, work_item_id}
```

`work_item_id` стабилен между baseline и technical-fix одного задания, уникален для параллельных work items и берётся из TaskManager/manifest. Не используй timestamp, random UUID или номер fix-loop как identity.

### Eligible roles

Reuse разрешён только `CoderAgent`, `TestEngineer`, `BuildAgent` и только для `technical_fix` того же exact work item.

Planning/review/ADR/DevOps/docs роли всегда запускаются fresh.

### Invocation protocol

Перед eligible child invocation, если reuse не отключён:

```text
pipeline_runtime_prepare(
  run_id,
  pipeline_id,
  stage,
  role,
  work_item_id,
  technical_fix,
  state_revision,
  previous_state_revision?,
  evidence_path?,
  changed_files?,
  diff_path?,
  required_reread?
)
```

Сразу следующий matching `task()` prompt должен содержать:

```text
<pipeline_work_item id="<same-work-item-id>"/>
```

Для pipeline work item модель не выбирает `task_id`: router удаляет такой handle и подставляет его только при exact identity + valid state/evidence. Вызовы `task()` без pipeline marker остаются полностью штатными и могут использовать native `task_id` без вмешательства router.

Baseline (`technical_fix:false`) всегда fresh и регистрирует созданную OpenCode session. Fix (`technical_fix:true`) может resume только exact registered child.

### Fresh fallback

Fresh вместо reuse при отсутствующей session, compaction/error/cancel/stale/in-progress, identity mismatch, revision mismatch, отсутствующем evidence/diff/reread или просроченном prepare. Fresh fallback сам по себе не блокирует pipeline.

При параллельном исполнении нельзя выбирать «последнюю session роли»: завершение связывается с exact work-item identity и native call/session ID.

Registry:

```text
.tmp/pipelines/<run-id>/session-registry.json
```

Компактный audit routing decisions:

```text
.tmp/pipelines/<run-id>/session-routing.jsonl
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

Фиксируй `source_sha`, `validated_sha`, fix commits, validation evidence и routing decisions.

## Prohibited

- менять approved manifest/rules во время run;
- пропускать обязательный stage;
- продолжать зависимый batch до завершения dependency;
- вручную выбирать/reuse `task_id` в обход router для pipeline work item;
- использовать один work_item_id для разных parallel items;
- публиковать изменения за пределами allowed scope;
- force-push или обход GitHub handoff tools.

## Final result

Верни компактно: pipeline status, stages, evidence, build/review/test/release results, fix-loops, blockers/risks, routing decisions; в GitHub mode также source/validated SHA и fix commits.
