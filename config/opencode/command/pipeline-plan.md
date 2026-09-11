---
description: Построить design-freeze OpenStage plan без запуска реализации
tags: [pipeline, planning, design-freeze]
---

# Pipeline Planning

Подготовь только план полного `OpenStageOrchestrator` pipeline. Реализацию, build, tests и deploy не запускай.

`$ARGUMENTS` может содержать путь к plan-файлу. Defaults:

```text
plan: docs/plan.md
rules: docs/pipeline-rules.md
```

## Flow

1. Прочитай исходный запрос/plan/rules, ближайший `AGENTS.md`, связанные stories и явные ограничения.
2. Через `ContextScout` добери только недостающий project context.
3. Для version-sensitive внешних библиотек/API используй `ExternalScout`; для более широкого публичного исследования — `WebResearcher`. Planning не использует CoderAgent для реализации или discovery.
4. Выполни `StoryMapper` → `SeniorStoryReviewer`.
5. Если требуется user-story verification, покажи reviewed stories и остановись до approval.
6. Выполни `ArchitectureAnalyzer` + `ContractManager` + `PrioritizationEngine`.
7. Выполни `ADRManager`: зафиксируй только устойчивые решения, уже принятые planning stage; допускается `not_required`.
8. Выполни fresh `SeniorTechnicalPlanReviewer`. Blocking findings возвращают план к шагам 6–7.
9. Только после статуса `ready` запусти `TaskManager`: stable work-item IDs, dependencies, parallel-safe groups, allowed scope, acceptance, validation/test expectations.
10. Собери immutable manifest/state inputs: stage order, decision/ADR refs, contracts, dependency graph, validation commands, paths/locks/conflict groups.
11. Проверь manifest через `stage-cli validate`. Open decision/blocker → `needs_revision`; state не инициализируй.
12. После явного approval допустимо `stage-cli init`. `/pipeline-run` автоматически не запускай.

## Boundaries

- не изменять product source;
- не использовать CoderAgent/BuildAgent/TestEngineer/DevOps;
- не менять rules/backlog/product requirements без решения владельца;
- не заменять unresolved decision собственным предположением;
- не передавать всему pipeline полный conversation/repository context, если есть компактные artifacts.

## Result

В `.tmp/pipelines/<run-id>/` должны быть manifest/state inputs, dependency graph, conflict/parallel groups, task artifacts и ссылки на stories/architecture/contracts/ADR/review evidence.

Верни: run id, pipelines, critical path, blockers/open decisions, validation profile и команду `/pipeline-run <run-id> --unattended` после approval.
