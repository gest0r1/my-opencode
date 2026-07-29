---
description: Построить и проверить план pipeline без запуска реализации
tags:
  - pipeline
  - planning
  - read-only
---

# Pipeline Planning

Выполни только этап Pipeline Planning для файла `docs/plan.md`.

## Аргументы

`$ARGUMENTS` может содержать путь к plan-файлу. Если аргументы не переданы,
используй:

```text
plan: docs/plan.md
rules: docs/pipeline-rules.md
```

## Обязательные правила

1. Работай в режиме `plan-only`.
2. Прочитай `docs/plan.md`.
3. Прочитай `docs/pipeline-rules.md`.
4. Проверь `edit_policy` правил. При значении, отличном от `human_only`,
   остановись со статусом `blocked`.
5. Прочитай `docs/architecture.md` и существующие user stories только в
   объёме, необходимом для планирования.
6. Построй dependency graph.
7. Объедини backlog items в pipeline по правилам из `pipeline-rules.md`.
8. Определи `exclusive_paths`, `conflict_group`, migration-файлы и
   deployment locks.
9. Назначь каждому pipeline gate profile.
10. Создай pipeline manifest и выполни его validation.
11. Инициализируй состояние через `stage-cli init`.

## Запрещено

- изменять исходный код;
- вызывать CoderAgent;
- запускать реализацию;
- запускать тесты реализации;
- запускать Docker;
- менять `docs/pipeline-rules.md`;
- менять backlog без явного указания пользователя.

## Результат

Создай runtime-артефакты:

```text
.tmp/pipelines/{run-id}/pipeline-manifest.json
.tmp/pipelines/{run-id}/dependency-graph.json
.tmp/pipelines/{run-id}/conflicts.json
.tmp/pipelines/{run-id}/execution-plan.md
.tmp/pipelines/{run-id}/state.json
```

Верни пользователю:

- run id;
- список созданных pipeline;
- зависимости между pipeline;
- выбранные gate profiles;
- найденные конфликты;
- блокирующие проблемы;
- команду для следующего шага:

```text
/pipeline-run {run-id}
```

Не запускай `/pipeline-run` автоматически.
