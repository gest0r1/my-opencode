---
description: Показать состояние pipeline, Git/CI provenance и workspace evidence без изменения данных
tags:
  - pipeline
  - status
  - read-only
---

# Pipeline Status

Покажи текущее состояние pipeline строго read-only.

`$ARGUMENTS` должен содержать `run-id`. Если его нет, покажи доступные run-id из `.tmp/pipelines/` и попроси выбрать.

## Действия

1. Прочитай `.tmp/pipelines/{run-id}/state.json` и manifest.
2. Выполни `stage-cli validate`.
3. Если есть `workspace-preflight.json`, покажи автоматически определённый workspace mode, worktree id, обнаруженные active runs и conflicts. Не ожидай owner confirmation.
4. Покажи `planning_context.base_sha`, зависимости от других runs и результат последней drift-проверки, если evidence существует.
5. Покажи status каждого pipeline/stage, blockers и последние evidence.
6. Если execution уже дошёл до GitHub validation, покажи отдельно:
   - `source_sha`;
   - FAST CI checks;
   - FULL CI checks;
   - CodeReviewer/TestEngineer result;
   - runtime-validation check;
   - `installed_sha`/artifact digest;
   - `validated_sha`;
   - fix-loop count.
7. Явно отметь SHA mismatch или отсутствие required evidence; не интерпретируй это как PASS.

## Запрещено

Не запускай agents, tests, CI, resume/start/complete и не меняй state/manifest/plan/rules/files.
