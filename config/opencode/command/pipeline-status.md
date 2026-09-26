---
description: Показать состояние pipeline без изменения данных
tags:
  - pipeline
  - status
  - read-only
---

# Pipeline Status

Покажи текущее состояние pipeline в режиме read-only.

## Аргументы

`$ARGUMENTS` должен содержать `run-id`.

Пример:

```text
/pipeline-status 2026-07-29-telegram-actions
```

Если run-id не передан, покажи список доступных run-id из `.tmp/pipelines/` и
попроси пользователя выбрать один. Не изменяй состояние автоматически.

## Действия

1. Прочитай `.tmp/pipelines/{run-id}/state.json`.
2. Выполни `stage-cli validate`.
3. Покажи статус run.
4. Покажи статус каждого pipeline.
5. Покажи текущую стадию.
6. Покажи завершённые, активные, ожидающие и заблокированные stages.
7. Покажи последние ошибки и evidence.
8. Для GitHub Issue run покажи repository/source issues, `planning_base_sha`/`run_base_sha`, `issue_results`, PR number и количество недоставленных событий `github_outbox`.

## Запрещено

- запускать agents;
- менять `state.json`;
- менять manifest;
- менять `plan.md`;
- менять `pipeline-rules.md`;
- автоматически выполнять `resume`, `start` или `complete`.

## Результат

Используй русский читаемый вывод. При необходимости добавь JSON-вывод для
машинной обработки, но не изменяй файлы.
