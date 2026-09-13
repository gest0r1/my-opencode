---
description: Показать состояние pipeline и Git/CI provenance без изменения данных
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
3. Если есть `workspace-preflight.json`, покажи только PASS/FAIL и причину FAIL; дополнительные детали — только если они нужны для диагностики.
4. Покажи `planning_context.base_sha`, зависимости от других runs и drift result, если есть.
5. Покажи status pipeline/stages, blockers и последние evidence.
6. Если есть GitHub validation, покажи `source_sha`, FAST/FULL/runtime checks, CodeReviewer/TestEngineer result, installed/validated SHA или artifact digest и fix-loop count.
7. SHA mismatch или отсутствие required evidence не интерпретируй как PASS.

## Запрещено

Не запускай agents, tests, CI, resume/start/complete и не меняй state/manifest/plan/rules/files.
