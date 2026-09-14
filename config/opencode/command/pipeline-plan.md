---
description: Построить design-freeze plan pipeline без запуска реализации
tags:
  - pipeline
  - planning
  - design-freeze
---

# Pipeline Planning

Выполни только Pipeline Planning для `docs/plan.md`. Реализацию не запускай.

## Аргументы

`$ARGUMENTS` может содержать путь к plan-файлу. По умолчанию:

```text
plan: docs/plan.md
rules: docs/pipeline-rules.md
```

`rules` — предпочтительный project policy. Если project rules отсутствуют,
canonical fallback определяет только deterministic `stage-cli rules`; агент не
копирует и не создаёт project rules самостоятельно.

## Обязательный flow

0. До чтения: не вызывай произвольный Bash, `ls` или `git`. Прочитай входные
   artifacts через native file tools и вызови только approved read-only gates:
   `git-worktree-cli.ts inspect` и `stage-cli.ts rules docs/pipeline-rules.md --json`.
   Отказ произвольного shell permission не является blocker и не должен повторяться.
1. Работай в режиме `plan-only`. Прочитай plan, effective rules по пути,
   возвращённому `stage-cli rules`, architecture context по dual-read и нужные
   user stories. Не реализуй алгоритм fallback самостоятельно.
2. Требуй `PASS` от rules gate. Existing-but-invalid project rules, invalid
   default rules или невозможность определить effective rules → `blocked`.
3. Через ContextScout собери project context. Для risk-trigger (`new library`,
   внешний API, auth/payment/tenant, security, migration, queue/cache,
   deploy/runtime) получи official version-specific evidence через ExternalScout
   и максимум 2–3 зрелых public code patterns через CoderAgent/CodeReviewer.
4. Выполни StoryMapper/SeniorStoryReviewer, ArchitectureAnalyzer,
   ContractManager, PrioritizationEngine и SeniorTechnicalPlanReviewer.
5. Собери все функциональные развилки в один owner decision packet. Не выбирай
   отсутствующее пользовательское решение сам.
6. Создай planning artifacts:
   `decision-register.md`, `technology-evidence.md`, `contract-inventory.md`,
   `test-strategy.md`, `accepted-risks.md`.
7. Построй dependency graph; определи pipelines, `exclusive_paths`,
   `conflict_group`, migrations, fixtures, deployment locks и gate profiles.
8. TaskManager создаёт задачи только после readiness `ready`; каждая задача
   содержит binary acceptance criteria, tests и ссылки на decision/contract/research.
9. Для branch/source checkout добавь в manifest `git_setup`: exact `base_sha`,
   target `branch`, optional `source_sha`, allowlisted `checkout_paths` и
   `must_absent`. Это единственный источник полномочий для Git gate.
10. Создай manifest с `planning_mode: design-freeze`, `planning_readiness` и
    per-pipeline `decision_ids`, `research_ids`, `contract_ids`. В `rules_file`
    укажи project preference `docs/pipeline-rules.md`, а `rules_version` возьми
    из результата canonical rules gate. `stage-cli init` сам фиксирует фактически
    выбранные rules source/path/version/SHA. Fallback на task.json запрещён.
11. Проверь manifest. Если есть `open_decision`, rules gate не PASS или другой
    blocker, не инициализируй state и верни `needs_revision`/`blocked` по причине.
12. Покажи один decision packet и manifest владельцу. После явного approval
    вызови `stage-cli init`; `/pipeline-run` автоматически не запускай.

## Direct write scope PLAN

Основной OpenStageOrchestrator во время PLAN может напрямую создавать/менять
только `.tmp/pipelines/{run-id}/**`. Project source, `docs/pipeline-rules.md`,
`.tmp/tasks/**`, произвольные docs и Git history напрямую не изменяются.
Специализированные planning agents работают только в рамках собственных
разрешений и утверждённого planning flow.

## Запрещено

- создавать, копировать или изменять `docs/pipeline-rules.md`;
- изменять исходный код;
- вызывать CoderAgent для реализации;
- запускать tests реализации или Docker;
- менять backlog без явного указания владельца;
- обходить deterministic rules/Git/state gates решением LLM.

## Результат

Создай в `.tmp/pipelines/{run-id}/` manifest, dependency graph, conflicts,
execution plan, пять planning artifacts и state после approval.

Верни run id, pipelines, зависимости, gate profiles, blockers, unresolved
risks и команду `/pipeline-run {run-id} --unattended`.
