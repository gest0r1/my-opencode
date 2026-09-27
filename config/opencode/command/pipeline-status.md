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
8. Для стадий `github_ci`/`github_dev` покажи frozen workflow, candidate SHA, workflow run ID/attempt, terminal job, `required_jobs` с их PASS status, artifact ID/name/`sha256:` digest и source CI run/digest (для DEV), а для stateful DEV — Environment/trusted ref/concurrency validation. Не считай natural-language статус evidence.
9. Покажи `future_github_gates`: они могут быть разработаны в текущем run, но не считаются активными/runnable до merge в trusted ref. Если есть `deployment_target_check`, покажи `kind`, `transport`, Environment, trusted ref, probe workflow/run/job и время последней PLAN-проверки без вывода значений секретов.
10. Для GitHub Issue run покажи repository/source issues, `planning_base_sha`/`run_base_sha`, `issue_results`, PR number и количество недоставленных событий `github_outbox`.

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
