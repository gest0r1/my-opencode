---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
---

# Pipeline Run

Выполни утверждённый pipeline manifest. `$ARGUMENTS` содержит `run-id` и может
содержать `--unattended`. Без run-id запроси выбор manifest, не выбирай молча.

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

## Запрещено

- менять manifest, plan или rules;
- пропускать обязательную stage;
- начинать неутверждённый pipeline;
- запускать dependent pipeline до completed dependency.

## Результат

Верни status run и pipeline, stages, evidence, Build/DevOps/test/review results,
fix-loops, blockers, unresolved risks и требуемый next action.
