---
description: Запустить новый pipeline в изолированной OpenChamber worktree-session
tags:
  - pipeline
  - openchamber
  - worktree
  - planning
---

# Pipeline

Это основной пользовательский вход в canonical pipeline.

## Использование

```text
/pipeline <task>
```

`$ARGUMENTS` — полное описание задачи. Пустая задача → остановись и попроси пользователя сформулировать задачу.

## Назначение

Эта команда только создаёт изолированную OpenChamber worktree-session и передаёт туда PLAN. Не анализируй код, не строй plan и не меняй source в bootstrap-session.

## Обязательный flow

1. Используй native tool `openchamber`, action `session.create`.
2. Создай **новую isolated worktree session** текущего проекта:
   - `worktree`: короткое безопасное уникальное имя `pipeline-<task-slug>-<short-suffix>`;
   - `branch`: `pipeline/<task-slug>-<short-suffix>`;
   - не передавай `startRef`, если пользователь явно не задал другой source/base ref: OpenChamber должен использовать обычную текущую точку старта проекта;
   - `agent`: `OpenStageOrchestrator`;
   - `title`: краткое название задачи с префиксом `Pipeline:`;
   - `prompt`: `/pipeline-plan $ARGUMENTS`;
   - **не включай Goal Mode** для PLAN;
   - не ставь `wait`: новая session должна появиться в OpenChamber и выполняться отдельно.
3. Не создавай worktree через shell или `git-worktree-cli setup`. Physical worktree создаёт только OpenChamber control plane.
4. Если `openchamber` tool недоступен или `session.create` не подтвердил создание worktree-session, верни `blocked` и предложи advanced fallback: вручную создать OpenChamber worktree-session и в ней вызвать `/pipeline-plan <task>`. Не запускай PLAN в primary checkout автоматически.
5. После успешного dispatch верни только созданные session/worktree/branch identifiers и сообщение, что дальнейший design-freeze выполняется в новой session.

## Инварианты

- Один `/pipeline` = один новый physical worktree.
- PLAN выполняется в новой worktree-session, а не в bootstrap-session.
- Текущие незакоммиченные изменения primary checkout не считаются частью новой задачи и не должны копироваться в worktree.
- `/pipeline-plan` останавливается на owner approval; реализация автоматически не начинается.
