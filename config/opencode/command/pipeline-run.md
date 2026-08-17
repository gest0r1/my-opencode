---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
---

# Pipeline Run

Выполни утверждённый pipeline manifest. `$ARGUMENTS` содержит `run-id` и может
содержать `--unattended` и `--session-reuse-pilot <pipeline-id>`. Без run-id
запроси выбор manifest, не выбирай молча.

## Preflight

1. Найди manifest/state, выполни `stage-cli validate`, проверь rules и
   `edit_policy: human_only`.
2. Проверь approval manifest, dependencies, paths, conflict groups и locks.
3. Для `planning_mode: design-freeze` проверь `planning_readiness`, ссылки на
   decision/research/contract artifacts и отсутствие open decisions.
4. Выполни doc-gate по `pipeline-rules.md`.

При любой ошибке верни `blocked`; реализацию не запускай.

## Выполнение

StageOrchestrator — это основная сессия; оркестрацию субагентам не передавай.
Перед стадией вызывай `stage-cli start`, после успеха — `complete`; evidence
обязателен. Выполняй только разрешённые batches.

Классифицируй review findings по `pipeline-rules.md`:
- `technical_fix` внутри approved scope — auto-fix, максимум два loop;
- `replan` — `stage-cli block --reason replan`, не продолжай и не выбирай
  новую архитектуру в run;
- scope/security/secret/destructive — block и stop;
- `optional` — evidence, не блокирует.

`--unattended` запрещает дополнительные запросы внутри approved scope. Верни
только terminal summary при `completed`, `blocked` или `failed`.

## Пилот session-reuse (ограниченный)

Активация — только явным флагом `--session-reuse-pilot <pipeline-id>`; флаг
принимает ровно один pipeline-id. Без флага reuse запрещён.

Флаг строго валидируется: дублирующий флаг, отсутствующее/пустое значение,
лишнее значение или pipeline-id, отсутствующий в approved manifest, —
отклоняются как ошибка вызова: пилот не активируется, reuse запрещён, верни
`blocked`.

### Область применения

Reuse разрешён только ролям CoderAgent, TestEngineer и BuildAgent и только
внутри `technical_fix` loop одной стадии. Planning-роли и ВСЕ reviewer-роли
(CodeReviewer, SeniorTechnicalPlanReviewer и др.) всегда стартуют заново.

Идентичность reuse — `{run_id, pipeline_id, stage, role}`; переиспользование
сессии между pipeline запрещено.

### Требования к reuse

Перед reuse передай детерминированный delta-пакет:

- путь к evidence предыдущей итерации (`reviews/{pipeline}-{stage}-{loop}.md`);
- список изменённых файлов или diff текущей итерации;
- текущую ревизию manifest/state;
- обязательные пути для повторного чтения.

Все пути delta-пакета и evidence резолвятся относительно корня выбранного
pipeline-проекта `<project-root>`.

Без полного delta-пакета reuse не выполняется — стартует свежая сессия.

### Stop conditions (fresh session)

Reuse отклоняется и стартует свежая сессия, если:

- произошла compaction сессии;
- cancellation/error на предыдущей итерации;
- handle mismatch (другой run/pipeline/stage/role);
- evidence или diff устарели (stale);
- delta-пакет отсутствует (missing delta).

Эти условия сами по себе pipeline не останавливают.

Pipeline останавливается (block и stop) только при
scope/security/replan/secret/destructive — reuse также отклоняется.

### Метрики (append-only)

Метрики пишутся append-only в sidecar JSON:
`<project-root>/.tmp/pipelines/{run_id}/reuse-metrics/{pipeline}-{stage}-{loop}.json`
— `<project-root>` это корень выбранного pipeline-проекта.

Запись содержит поля: timestamp, identity, decision, fallback reason,
packet bytes, latency. Существующая запись никогда не перезаписывается —
новая запись только добавляется.

Разрешены только фактически измеряемые прокси: packet bytes запроса/ответа
субагента и latency-прокси (время вызова/ожидания/ревью). Фейковые token-метрики
запрещены: токены не указывай, если OpenCode не отдаёт фактический usage.

## Запрещено

- менять manifest, plan или rules;
- пропускать обязательную stage;
- начинать неутверждённый pipeline;
- запускать dependent pipeline до completed dependency;
- переиспользовать сессию субагента без флага `--session-reuse-pilot <pipeline-id>`.

## Результат

Верни status run и pipeline, stages, evidence, Build/DevOps/test/review results,
fix-loops, blockers, unresolved risks, session-reuse решения и метрики (если
пилот активен) и требуемый next action.
