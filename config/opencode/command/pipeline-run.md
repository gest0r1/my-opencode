---
description: Выполнить утверждённый pipeline manifest
tags:
  - pipeline
  - execution
---

# Pipeline Run

Выполни утверждённый pipeline manifest.

## Аргументы

`$ARGUMENTS` должен содержать `run-id`.

Пример:

```text
/pipeline-run 2026-07-29-telegram-actions
```

Если run-id не передан, найди последний manifest со статусом `planned` или
`approved` и запроси у пользователя выбор. Не выбирай manifest молча.

## Preflight

До запуска реализации:

1. Найди `.tmp/pipelines/{run-id}/pipeline-manifest.json`.
2. Проверь `state.json` через `stage-cli validate`.
3. Проверь `docs/pipeline-rules.md`.
4. Убедись, что `edit_policy: human_only`.
5. Убедись, что manifest утверждён пользователем.
6. Проверь зависимости, `exclusive_paths`, `conflict_group` и locks.

Если manifest не утверждён или preflight не пройден, не запускай реализацию.
Верни статус `blocked` и список причин.

## Выполнение

Передавай управление StageOrchestrator в режиме `execute`.

StageOrchestrator обязан:

1. Выполнять pipeline в порядке manifest.
2. Запускать только разрешённые параллельные batches.
3. Перед каждой стадией вызывать `stage-cli start`.
4. После успешной стадии вызывать `stage-cli complete`.
5. При ошибке фиксировать `failed` или `blocked` через `stage-cli`.
6. Выполнять автоматические fix-loop по правилам `pipeline-rules.md`.
7. Не запрашивать дополнительное approval внутри уже утверждённого scope.
8. Остановиться при scope change, destructive operation, security blocker,
   отсутствующем secret или превышении retry limit.

## Запрещено

- изменять pipeline manifest;
- менять `docs/pipeline-rules.md`;
- начинать неутверждённые pipeline;
- пропускать обязательные stages;
- считать стадию завершённой только по текстовому отчёту агента;
- запускать следующий зависимый pipeline при незавершённом dependency.

## Результат

Верни пользователю:

- итоговый статус run;
- статус каждого pipeline;
- завершённые и пропущенные stages;
- результаты BuildAgent;
- результаты DevOpsSpecialist;
- результаты tests и Code Review;
- список автоматических fix-loop;
- блокирующие проблемы;
- unresolved risks;
- ссылки на runtime evidence.
