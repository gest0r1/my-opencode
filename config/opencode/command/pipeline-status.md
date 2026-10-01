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
4. Покажи статус каждого pipeline и отдельно source-ready состояние: достигнут ли его `ready_after_stage`, даже если поздний CI/CD stage сейчас BLOCKED.
5. Покажи текущую стадию и runnable queue из `stage-cli next`. Если один pipeline BLOCKED, но queue не пуста, статус RUN трактуй как продолжающийся, а blocker — как deferred для соответствующего pipeline.
6. Покажи завершённые, активные, ожидающие и заблокированные stages.
7. Покажи последние ошибки и evidence. Для `security_stop|secret_stop|destructive_stop|scope_stop|replan` явно показывай `BLOCKED / awaiting owner` и причину; не называй такой checkpoint terminal `failed`, если state действительно blocked.
8. Для стадий `github_ci`/`github_dev` покажи frozen workflow, exact candidate SHA, workflow run ID/attempt, terminal job и `required_jobs` с PASS status. Для DEV покажи exact source-CI run ID, `installed_sha`/candidate SHA, а для stateful DEV — Environment/trusted ref/concurrency validation и `target_id`. Canonical final CI artifactless: artifact ID/digest не ожидаются. Для `testing_strategy.mode=hybrid` отдельно покажи post-CI `local_gate`, его frozen command(s), PASS/FAIL evidence и привязку к exact `candidate_sha`; отсутствие `deployment_target_check` для hybrid нормально. Не считай natural-language статус evidence.
9. Покажи `future_github_gates`: они могут быть разработаны в текущем run, но не считаются активными/runnable до merge в trusted ref. Если есть `deployment_target_check`, покажи `kind`, `transport`, Environment, trusted ref, probe workflow/run/job и время последней PLAN-проверки без вывода значений секретов; этот check является обязательным capability evidence только для выбранного `opencode_host`.
10. Для GitHub Issue run покажи repository/source issues, `planning_base_sha`/`run_base_sha`, `issue_results`, PR number и количество недоставленных событий `github_outbox`. Уточняй, что один distinct outbox event = один отдельный audit-комментарий; sync дедуплицирует повторную доставку того же event marker, но не объединяет разные transitions и не редактирует предыдущий комментарий. Один Issue, mapped к нескольким pipelines, может получить несколько комментариев одного run.
11. Если есть `preserved_baseline`, покажи его HEAD и число frozen paths отдельно от writable scope. Если state содержит `superseded_by`/`supersede_reason` или manifest содержит `lineage`, покажи цепочку run-ов и reason code.
    Если присутствуют `refresh-impact.json`, `git-runtime.json` или `refresh_revalidation`, отдельно покажи refresh classification (`NO_IMPACT|BOUNDED_IMPACT|STRUCTURAL_IMPACT`), previous/new base SHA, changed paths, affected planning gates, `rebuild_work_items`, inherited run-id и был ли сохранён прежний approval. Для bounded draft явно пометь gates со `status=needs_revision`; не представляй copied artifacts как заново проверенные.
12. Для rules покажи `rules_source`, текущий `rules_file`, `rules_version` и hash из state. Эти поля — audit metadata текущей принятой версии rules; изменение hash/version между pipeline-командами само по себе не является blocker.
13. Покажи `runtime_scope_extensions` отдельно от frozen manifest scope: class (`test|technical`), exact paths, reason и review evidence для technical. Если есть `scope_preflight`, покажи pipeline/stage/paths и отметь, что следующий matching `fix-cycle` его потребит. Если есть `security_fix_preflight`, отдельно покажи pipeline/stage, exact paths и evidence path/hash; это означает, что разрешён только matching `fix-cycle --repair-class security_fix`.
14. Для каждого stage покажи общий automatic-repair budget (`technical_fix` + `security_fix`) как `used/limit`, историю `technical_fix_budget_grants` с `source` (`run_override|owner_direct|runtime_replan`) и активный `runtime_replan` (revision/status/evidence/owner_questions/granted_cycles). Default нового RUN = 5; ceiling выше 5 может быть заранее задан owner через `--fix-cycles N`. Явно различай `awaiting_owner_clarification` и `awaiting_owner_approval`; это не terminal full replan.
15. Отдельно покажи integrated candidate: текущий `candidate_sha` и для каждого deployable pipeline — совпадает ли PASS `deployment_validation.stage` с этим SHA. Для `github_ci`/`github_dev` со статусом FAIL или BLOCKED покажи canonical evidence. Для FAIL: workflow run/attempt, failed jobs/steps, `validation_error` и diagnostics. Для BLOCKED: `failure_phase`, candidate/workflow identity и observed run ID/status, если run уже найден. Не проси пользователя вручную выгружать Actions logs, если deterministic CLI имеет доступ.

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
