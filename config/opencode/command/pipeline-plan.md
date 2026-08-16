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

## Обязательный flow

1. Работай в режиме `plan-only` и прочитай plan, rules, architecture context
   по dual-read и нужные user stories.
2. Проверь `edit_policy: human_only`; иначе верни `blocked`.
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
9. Создай manifest с `planning_mode: design-freeze`, `planning_readiness` и
   per-pipeline `decision_ids`, `research_ids`, `contract_ids`.
10. Проверь manifest. Если есть `open_decision` или blocker, не инициализируй
    state и верни `needs_revision`.
11. Покажи один decision packet и manifest владельцу. После явного approval
    вызови `stage-cli init`; `/pipeline-run` автоматически не запускай.

## Запрещено

- изменять исходный код;
- вызывать CoderAgent для реализации;
- запускать tests реализации или Docker;
- менять rules или backlog без явного указания владельца.

## Результат

Создай в `.tmp/pipelines/{run-id}/` manifest, dependency graph, conflicts,
execution plan, пять planning artifacts и state после approval.

Верни run id, pipelines, зависимости, gate profiles, blockers, unresolved
risks и команду `/pipeline-run {run-id} --unattended`.
