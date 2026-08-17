---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
---

# Pipeline Run

Выполни утверждённый pipeline manifest. `$ARGUMENTS` содержит `run-id`, может содержать `--unattended` и `--session-reuse-pilot <pipeline-id>`.

## Preflight

1. Найди manifest/state, выполни `stage-cli validate`, проверь rules и `edit_policy: human_only`.
2. Проверь approval manifest, dependencies, paths, conflict groups и locks.
3. Для `planning_mode: design-freeze` проверь planning readiness и отсутствие open decisions.
4. Выполни doc-gate.

При любой ошибке верни `blocked`; реализацию не запускай.

## Session reuse pilot

Пилот активируется только явным `--session-reuse-pilot <pipeline-id>` и только для одного pipeline. Без флага reuse запрещён.

Вместо ручного выбора `task_id` используй runtime plugin `pipeline-runtime`.

Для каждой eligible technical-fix делегации перед вызовом `task()` подготовь файл:

```text
<project-root>/.tmp/pipeline-runtime-context.json
```

со следующими полями:

```json
{
  "run_id": "<run-id>",
  "pipeline_id": "<pipeline-id>",
  "stage": "<stage>",
  "role": "CoderAgent|TestEngineer|BuildAgent",
  "loop": 1,
  "technical_fix": true,
  "state_revision": "<current-state-revision>",
  "evidence_path": "<relative-or-absolute-evidence-path>",
  "changed_files": ["..."],
  "required_reread": ["..."]
}
```

Для неeligible делегаций ставь `technical_fix: false` либо не создавай runtime context. Не передавай `task_id` вручную.

Plugin обязан:
- сопоставлять identity `{run_id,pipeline_id,stage,role}`;
- возобновлять только healthy session;
- на compaction/error/cancel/stale/missing delta запускать fresh session;
- добавлять deterministic delta к prompt;
- вести session registry;
- писать append-only reuse metrics.

Метрики хранятся в:

```text
<project-root>/.tmp/pipelines/{run_id}/reuse-metrics/events.jsonl
```

Registry:

```text
<project-root>/.tmp/pipelines/{run_id}/session-registry.json
```

## Выполнение

StageOrchestrator остаётся основной сессией. Перед стадией вызывай `stage-cli start`, после успеха — `complete`; evidence обязательно. Выполняй только разрешённые batches.

Review findings классифицируй как:
- `technical_fix` — auto-fix, максимум два loop;
- `replan` — block/stop;
- scope/security/secret/destructive — block/stop;
- optional — evidence, не блокирует.

`--unattended` запрещает дополнительные запросы внутри approved scope.

## Запрещено

- менять manifest/plan/rules во время run;
- пропускать обязательную stage;
- запускать dependent pipeline до completed dependency;
- вручную переиспользовать task_id в обход runtime plugin.

## Результат

Верни status run/pipeline, stages, evidence, Build/DevOps/test/review results, fix-loops, blockers, unresolved risks и следующий action.
