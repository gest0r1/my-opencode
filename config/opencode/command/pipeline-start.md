---
description: Запустить approved pipeline в отдельной OpenChamber Goal-session того же worktree
tags:
  - pipeline
  - openchamber
  - execution
  - goal
---

# Pipeline Start

Запусти уже утверждённый pipeline как unattended OpenChamber Goal-session.

## Использование

```text
/pipeline-start <run-id>
```

Ровно один positional `run-id`. Неизвестные/лишние аргументы → `blocked`.

## Preflight

До dispatch выполни только deterministic проверки:

```text
stage-cli validate <run-id> --json
stage-cli next <run-id> --json
```

Продолжай только если state approved/in-progress и manifest/rules valid. Terminal run не dispatch'и повторно.

Для manifest с `git_setup.workspace_mode: linked_worktree` выполни только
**non-mutating identity check**:

```text
git-worktree-cli.ts capability .tmp/pipelines/<run-id>/manifest.json
```

Он обязан подтвердить `linked_worktree: true`, approved branch/base SHA, clean
workspace и отсутствие forbidden paths. На этом этапе не применяй `source_sha`
и не меняй файлы.

Одноразовый `git-worktree-cli.ts adopt` принадлежит только `/pipeline-run`: там
он после dispatch проверяет ту же workspace identity и при необходимости
применяет frozen `source_sha/checkout_paths`. Не вызывай `adopt` здесь второй раз
и не используй legacy `setup` как fallback.

## Dispatch

Используй native tool `openchamber`, action `session.create`:

- `directory`: текущий worktree directory;
- не передавай `worktree` и `branch`: execution session должна использовать **тот же уже утверждённый worktree**, а не создавать ещё один;
- `agent`: `OpenStageOrchestrator`;
- `title`: `Pipeline run: <run-id>`;
- `prompt`: `/pipeline-run <run-id> --unattended`;
- `goal: true`;
- `goalTokenBudget`: не задавай без явного пользовательского ограничения — используй штатный default OpenChamber;
- `wait`: false/omit.

Goal objective должен быть узким: выполнить frozen approved pipeline до deterministic terminal state `completed`, `blocked` или `failed`; не менять manifest/rules, не переинтерпретировать deterministic blocker и не расширять scope.

Если tool недоступен или dispatch не подтверждён, верни `blocked`. Не запускай второй execution session автоматически и не подменяй Goal Mode обычным циклом bootstrap-session.

## Результат

Верни session id/title, run id и worktree directory. После dispatch пользователь может закрыть UI: дальнейшее выполнение принадлежит OpenChamber Goal-session и canonical `/pipeline-run`.
