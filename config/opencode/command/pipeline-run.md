---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
---

# Pipeline Run

Выполни утверждённый pipeline manifest. `$ARGUMENTS` содержит `run-id` и может
содержать `--unattended` и `--no-session-reuse`. Без run-id запроси выбор
manifest, не выбирай молча.

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

## Session-reuse (включён по умолчанию)

Session-reuse активен по умолчанию для каждого pipeline. Отключение — явный
флаг `--no-session-reuse`, который запрещает reuse и принудительно делает
все вызовы fresh.

### Runtime enforcement

НЕ выбирай и НЕ передавай `task_id` вручную. Решение fresh/reuse принимает
локальный plugin `pipeline-runtime`.

Перед КАЖДЫМ вызовом CoderAgent, TestEngineer или BuildAgent непосредственно
перед `task()` вызови tool `pipeline_runtime_prepare`.

- для первого/baseline вызова роли и для вызова вне `technical_fix` передай
  `technical_fix: false`; такой вызов всегда fresh, но его session будет
  зарегистрирована для последующего контролируемого reuse;
- для `technical_fix` передай `technical_fix: true`;
- `pilot_pipeline_id` обязан совпадать с pipeline-id из approved manifest;
- `stage` и `role` должны точно соответствовать следующему `task()`;
- `state_revision` используй как текущую детерминированную ревизию state
  (явное revision/hash, а если его нет — стабильное поле `updated_at`);
- при повторном reuse передай `previous_state_revision` из последней записи
  session registry для той же identity;
- передай evidence, changed files или `diff_path`, и `required_reread`.

Пример:

```text
pipeline_runtime_prepare(
  pilot_pipeline_id: "api",
  run_id: "run-123",
  pipeline_id: "api",
  stage: "implementation-fix",
  role: "CoderAgent",
  loop: 2,
  technical_fix: true,
  state_revision: "2026-08-17T16:20:00Z",
  previous_state_revision: "2026-08-17T16:10:00Z",
  evidence_path: ".tmp/pipelines/run-123/reviews/api-implementation-fix-1.md",
  changed_files: ["src/api/auth.ts"],
  required_reread: ["docs/contracts/auth.md"]
)
```

Runtime context одноразовый и ограничен по времени. Plugin сам:

- удаляет любой model-supplied `task_id`;
- сопоставляет identity `{run_id,pipeline_id,stage,role}`;
- допускает reuse только healthy session;
- на compaction/error/cancel/in-progress/stale/missing delta делает fresh fallback;
- проверяет evidence и required reread paths;
- добавляет deterministic delta в resumed prompt;
- ведёт session registry;
- пишет append-only метрики.

### Область применения

Reuse разрешён только ролям CoderAgent, TestEngineer и BuildAgent и только
внутри `technical_fix` loop одной стадии. Planning-роли и ВСЕ reviewer-роли
(CodeReviewer, SeniorTechnicalPlanReviewer и др.) всегда стартуют заново.

Идентичность reuse — `{run_id, pipeline_id, stage, role}`; переиспользование
сессии между pipeline или role запрещено.

### Stop conditions (fresh session)

Reuse отклоняется и стартует свежая сессия, если:

- произошла compaction сессии;
- cancellation/error на предыдущей итерации;
- предыдущий вызов не завершился (`in_progress`);
- handle/role mismatch;
- cross-pipeline mismatch;
- state/evidence/diff устарели;
- delta-пакет отсутствует или неполон.

Эти условия сами по себе pipeline не останавливают.

Pipeline останавливается (block и stop) только при
scope/security/replan/secret/destructive — reuse также отклоняется.

### Метрики (append-only)

Registry:
`<project-root>/.tmp/pipelines/{run_id}/session-registry.json`

Метрики:
`<project-root>/.tmp/pipelines/{run_id}/reuse-metrics/events.jsonl`

Фиксируются фактически наблюдаемые значения: fresh/reuse, fallback reason,
latency, orientation time (до первого edit/test/build), prompt/response/packet
bytes, tool/read/grep/glob/edit/bash calls, unique files read, reread files и
context reread ratio. Не выдумывай token usage, если OpenCode его не отдаёт.

## Запрещено

- менять manifest, plan или rules;
- пропускать обязательную stage;
- начинать неутверждённый pipeline;
- запускать dependent pipeline до completed dependency;
- передавать `task_id` вручную в обход runtime plugin.

## Результат

Верни status run и pipeline, stages, evidence, Build/DevOps/test/review results,
fix-loops, blockers, unresolved risks, session-reuse решения и метрики.
