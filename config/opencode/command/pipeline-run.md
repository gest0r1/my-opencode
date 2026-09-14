---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
  - github-handoff
---

# Pipeline Run

Выполни утверждённый pipeline manifest. StageOrchestrator остаётся основной
сессией: он управляет стадиями и task routing, но не передаёт оркестрацию
субагентам.

## Аргументы

Обычный режим:

```text
/pipeline-run <run-id> [--unattended] [--no-session-reuse]
```

GitHub validation handoff:

```text
/pipeline-run <run-id> github <handoff-id> [--unattended] [--no-session-reuse]
```

`github` — positional mode. `handoff-id` обязателен и должен быть одним токеном.
Без `run-id` запроси выбор manifest; не выбирай молча. Неизвестный режим,
лишний positional argument или `github` без `handoff-id` → `blocked`.

Session reuse включён по умолчанию. `--no-session-reuse` принудительно делает
каждый task fresh.

## Preflight — обычный режим

1. Найди manifest/state, выполни `stage-cli validate`, проверь rules и
   `edit_policy: human_only`.
2. Проверь approval manifest, dependencies, paths, conflict groups и locks.
3. Для `planning_mode: design-freeze` проверь `planning_readiness`, ссылки на
   decision/research/contract artifacts и отсутствие open decisions.
4. Выполни doc-gate по `pipeline-rules.md`. Fallback на `task.json` запрещён.
5. Если manifest содержит `git_setup`, ДО запуска первой implementation stage вызови:

```text
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/git-worktree-cli.ts capability <manifest>
npx --yes tsx /root/.config/opencode/skills/task-management/scripts/git-worktree-cli.ts setup <manifest>
```

Только `PASS` продолжает молча. `BLOCKED` не создаёт CoderAgent-session, не
пишет reuse metrics и не запускает batch. После setup передай CoderAgent только
контракт `git_worktree_gate=PASS`; CoderAgent не выполняет Git-команды.
`git_setup` обязателен для branch/source checkout и содержит approved
`base_sha`, `branch`, optional `source_sha`, `checkout_paths` и `must_absent`.
Свободные Git-команды запрещены.

Любая ошибка preflight → `blocked`; реализацию не запускай.

## GitHub validation handoff

Этот режим означает, что planning, architecture, implementation и code review
уже выполнены внешним исполнителем. OpenCode забирает зафиксированный результат
из GitHub и выполняет только перечисленные validation stages плюс допустимые
`technical_fix`.

### Handoff transport

`handoff-id` разрешается через immutable ref:

```text
origin/handoff/<handoff-id>
```

Ref обязан содержать `.opencode/pipeline-handoff.json` минимум со следующими
полями:

```json
{
  "schema_version": 1,
  "provider": "github",
  "handoff_id": "handoff-001",
  "run_id": "run-123",
  "repository": "owner/product",
  "source_branch": "feature/foo",
  "source_sha": "40-hex-commit-sha",
  "pipeline_id": "app",
  "rules_file": "docs/pipeline-rules.md",
  "rules_version": 1,
  "validation_stages": ["build", "tests", "release_validation"],
  "allowed_fix_scope": ["src/**", "tests/**"],
  "acceptance": ["..."],
  "validation": {
    "build": ["..."],
    "deploy": ["..."],
    "test": ["..."],
    "smoke": ["..."]
  }
}
```

`repository`, если задан, обязан совпадать с GitHub `origin`.
`allowed_fix_scope` поддерживает exact paths и trailing `/**`; пустой scope
запрещает публикацию кодовых изменений.

### Deterministic Git preflight

Не используй свободные `git pull/checkout/push`. Вызови:

```text
github_handoff_prepare(
  run_id: "<run-id>",
  handoff_id: "<handoff-id>"
)
```

Tool обязан требовать clean worktree, проверить handoff/source SHA/repository,
создать локальную `pipeline/<run-id>` строго от `source_sha` и сформировать
`.tmp/pipelines/<run-id>/github-validation-manifest.json` только с validation
stages из handoff.

Затем вызови `github_handoff_status` и проверь:

```text
current_head == source_sha
current_branch == pipeline/<run-id>
```

Любое несовпадение, malformed handoff или сдвинувшийся source branch →
`blocked` без тестирования и исправлений.

Если state отсутствует, инициализируй его через `stage-cli init` с validation
manifest. Если существует, он обязан соответствовать тому же handoff,
pipeline-id и exact stage order. В GitHub mode planning/implementation stages
не помечаются skipped — их вообще нет в validation manifest.

### Validation execution

Для каждой разрешённой стадии:

1. `stage-cli start`;
2. вызови профильного агента;
3. передай acceptance и validation commands;
4. сохрани evidence;
5. при PASS — `stage-cli complete`;
6. при FAIL классифицируй finding.

Классификация:

- `technical_fix` внутри approved/allowed scope — auto-fix, максимум два loop;
- `replan` — block и stop;
- scope/security/secret/destructive — block и stop;
- `optional` — evidence, не блокирует.

Имя stage внутри fix-loop остаётся стабильным; меняется `loop`, а не stage.
После fix повтори затронутый gate и зависимые build/deploy/test gates.
Текстовый отчёт агента не заменяет реальные команды/evidence.

### Publish validated result

После PASS всех обязательных validation stages:

```text
github_handoff_publish(run_id: "<run-id>")
```

Tool обязан публиковать только внутри `allowed_fix_scope`, отклонять secret
paths, запрещать divergent/non-fast-forward publish, проверять validated HEAD
как потомка `source_sha` и повторно подтверждать remote SHA. После publish
снова вызови `github_handoff_status` и зафиксируй `validated_sha`. Без fixes
`validated_sha == source_sha`.

Финальный evidence GitHub mode содержит минимум:

```text
handoff_id
source_branch
source_sha
validated_sha
fix commit(s), если были
build/deploy/test results
session-reuse decisions
```

## Общие правила выполнения

Перед стадией вызывай `stage-cli start`, после успеха — `complete`; evidence
обязателен. Выполняй только разрешённые batches/stages.

Review findings классифицируй по `pipeline-rules.md`. `--unattended` запрещает
дополнительные вопросы внутри уже approved scope. Ответ пользователю — только
terminal summary при `completed`, `blocked` или `failed`.

## Session reuse

### Зачем нужен router

Нативный OpenCode `task_id` — только handle для продолжения конкретной child
session. Он не определяет, КАКОЙ логический work item должен продолжаться и
МОЖНО ли его продолжать. Политика принадлежит локальному `pipeline-runtime`.

`task_id` никогда не выбирается моделью. Router удаляет model-supplied
`task_id` и добавляет его только после точного сопоставления logical identity.

### Logical identity

Identity reuse:

```text
{run_id, pipeline_id, stage, role, work_item_id}
```

`work_item_id` обязателен для каждой потенциально reusable task:

- должен быть стабильным для одного логического задания между baseline и
  последующими technical-fix loop;
- должен быть уникальным для параллельных заданий одной роли в одной stage;
- не должен содержать номер loop, timestamp или случайный UUID;
- предпочтительно используй ID work item из manifest/task plan; если его нет —
  детерминированный slug конкретной единицы работы.

Пример параллельной реализации:

```text
implementation / CoderAgent / api-auth
implementation / CoderAgent / vacancy-filter
```

Эти две задачи обязаны получить разные `work_item_id` и никогда не должны
возобновлять session друг друга.

### Runtime enforcement

Перед КАЖДЫМ вызовом CoderAgent, TestEngineer или BuildAgent, если reuse не
отключён, вызови:

```text
pipeline_runtime_prepare(
  run_id: "<run-id>",
  pipeline_id: "<pipeline-id>",
  stage: "<stage>",
  role: "<role>",
  work_item_id: "<stable-work-item-id>",
  loop: <n>,
  technical_fix: <true|false>,
  state_revision: "<current-revision>",
  previous_state_revision: "<previous-revision-if-reuse>",
  evidence_path: "<path>",
  changed_files: ["..."],
  diff_path: "<optional-path>",
  required_reread: ["..."]
)
```

Сразу следующий соответствующий `task()` ОБЯЗАН содержать в prompt:

```text
<pipeline_work_item id="<same-work-item-id>"/>
```

Marker — routing key, а не инструкция модели. Он связывает вызов с конкретным
prepared work item даже при параллельном выполнении и изменённом порядке
завершения.

Для первого/baseline вызова передай `technical_fix: false`: task всегда fresh,
но завершившаяся child session регистрируется. Для допустимого fix-loop передай
`technical_fix: true` и `previous_state_revision` из registry ТОЙ ЖЕ exact
identity.

Router:

- хранит one-shot prepare отдельно для parent session + `work_item_id`, поэтому
  параллельные prepare не перезаписывают друг друга;
- сопоставляет завершение по нативному plugin `callID`, а не по «последней
  сессии роли»;
- хранит registry по полной identity с `work_item_id`;
- разрешает reuse только healthy session той же exact identity;
- передаёт в OpenCode нативный `task_id` только после всех проверок;
- добавляет deterministic delta и required reread;
- пишет append-only metrics.

### Где reuse разрешён

Reuse разрешён только для:

```text
CoderAgent
TestEngineer
BuildAgent
```

и только внутри `technical_fix` loop того же logical work item.

Planning-роли и ВСЕ reviewer-роли, включая CodeReviewer и
SeniorTechnicalPlanReviewer, всегда запускаются fresh, чтобы не переносить
собственные предыдущие выводы и anchoring.

Reuse между разными role, stage, pipeline, run или `work_item_id` запрещён.

### Fresh fallback

Запускай fresh session вместо reuse при любом из условий:

- нет предыдущей session для exact identity;
- предыдущая session compacted/error/cancelled/stale/in_progress;
- role/work-item/parent-session mismatch;
- state revision не соответствует предыдущей записи;
- evidence/diff/required reread отсутствуют или устарели;
- runtime context просрочен;
- marker отсутствует или не совпадает.

Fresh fallback сам по себе pipeline не останавливает. Pipeline block/stop только
по обычным scope/security/replan/secret/destructive правилам.

### Метрики

Registry:

```text
<project-root>/.tmp/pipelines/{run_id}/session-registry.json
```

Metrics:

```text
<project-root>/.tmp/pipelines/{run_id}/reuse-metrics/events.jsonl
```

Фиксируй только наблюдаемые значения: fresh/reuse, fallback reason, `call_id`,
`work_item_id`, latency, orientation time, prompt/response/packet bytes,
tool/read/grep/glob/edit/bash calls, unique/reread files. Не выдумывай token
usage, если OpenCode его не отдаёт.

## Запрещено

- менять approved manifest, plan или rules во время обычного run;
- в GitHub mode менять handoff ref или source_sha;
- использовать `git pull`, force-push или ручной push в обход handoff tools;
- пропускать обязательную validation stage;
- начинать неутверждённый обычный pipeline;
- запускать dependent pipeline до completed dependency;
- передавать `task_id` вручную в обход runtime router;
- использовать один `work_item_id` для разных параллельных задач;
- публиковать изменения вне `allowed_fix_scope`.

## Результат

Обычный режим: status run/pipeline, stages, evidence, build/devops/test/review
results, fix-loops, blockers, unresolved risks, session-reuse decisions и
metrics.

GitHub mode дополнительно: `handoff_id`, `source_branch`, `source_sha`,
`validated_sha`, fix commits/changed files и remote SHA verification.
