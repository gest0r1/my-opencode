---
description: Построить design-freeze plan pipeline без запуска реализации
tags:
  - pipeline
  - planning
  - design-freeze
---

# Pipeline Planning

`/pipeline-plan` выполняет только совместную с владельцем проработку постановки и design freeze. Команда не меняет исходный код, не запускает реализацию и никогда автоматически не переходит в `/pipeline-run`.

## Аргументы

`$ARGUMENTS` может содержать путь к plan-файлу. По умолчанию:

```text
plan: docs/plan.md
rules: docs/pipeline-rules.md
```

## Stage 0 — Deterministic preflight

Сформируй новый `run-id` и до чтения mutable project context выполни:

```bash
node .opencode/skills/task-management/scripts/workspace-preflight.mjs plan --run-id <run-id>
```

Fallback:

```bash
node ~/.config/opencode/skills/task-management/scripts/workspace-preflight.mjs plan --run-id <run-id>
```

Контракт gate:

- exit `0` → продолжай молча;
- non-zero → остановись и покажи возвращённую причину;
- helper сам сохраняет `.tmp/pipelines/{run-id}/workspace-preflight.json`.

Используй `head_sha`/`branch` из preflight как `planning_context.base_sha`/`base_branch`. Design-freeze approval допускается только для clean Git snapshot.

## Обязательный planning flow

1. Работай строго `plan-only`.
2. Прочитай plan, rules, architecture context по dual-read и нужные user stories.
3. Проверь `edit_policy: human_only`; иначе верни `blocked`.
4. Через ContextScout собери project context. Для risk-trigger (`new library`, внешний API, auth/payment/tenant, security, migration, queue/cache, deploy/runtime) получи official version-specific evidence через ExternalScout и максимум 2–3 зрелых public code patterns через CoderAgent/CodeReviewer.
5. Выполни StoryMapper/SeniorStoryReviewer, ArchitectureAnalyzer, ContractManager, PrioritizationEngine и SeniorTechnicalPlanReviewer.
6. Все функциональные развилки собери в один owner decision packet. Не выбирай отсутствующее пользовательское решение самостоятельно.
7. Создай planning artifacts: `decision-register.md`, `technology-evidence.md`, `contract-inventory.md`, `test-strategy.md`, `accepted-risks.md`.
8. Построй dependency graph. Определи pipelines, `exclusive_paths`, `conflict_group`, migrations, fixtures, deployment locks и gate profiles.
9. Если будущий pipeline зависит от результата другого RUN, добавь `depends_on_runs` и требуемые decision/contract/artifact IDs. Это позволяет готовить следующий PLAN параллельно с выполняющимся RUN.
10. TaskManager создаёт задачи только после readiness `ready`; каждая задача содержит binary acceptance criteria, tests и ссылки на decision/contract/research.
11. Определи CI contract:
    - `fast_required_checks` — format/lint/typecheck/build/doc-gate/affected tests;
    - `full_required_checks` — полный deterministic test suite;
    - `runtime_required_checks` — установка из GitHub exact SHA + integration/e2e/smoke на изолированном runtime;
    - отсутствие требуемого CI — blocker для release validation, не повод заменять CI вызовом LLM.
12. Создай manifest с `planning_mode: design-freeze`, readiness и per-pipeline decision/research/contract IDs.

## Обязательные поля нового manifest

```json
{
  "planning_mode": "design-freeze",
  "planning_context": {
    "base_branch": "feature-or-main",
    "base_sha": "40-hex-git-sha",
    "depends_on_runs": [
      {
        "run_id": "run-001",
        "required_artifacts": ["contract:C-017"]
      }
    ]
  },
  "ci": {
    "fast_required_checks": ["fast-ci"],
    "full_required_checks": ["full-tests"],
    "runtime_required_checks": ["runtime-validation"]
  }
}
```

Названия checks проектные: не выдумывай существующий check, если его нет. Зафиксируй реальное имя из GitHub Actions/config проекта.

## Approval

1. `open_decision`, отсутствие воспроизводимого `base_sha`, failed preflight или planning blocker запрещают approval.
2. Покажи владельцу один consolidated decision packet и manifest.
3. Только после явного approval вызови `stage-cli init`.
4. После init остановись и верни `/pipeline-run {run-id} --unattended`. Сам RUN не запускай.

## Запрещено

- изменять исходный код;
- вызывать CoderAgent для реализации;
- запускать implementation tests, Docker или deployment;
- менять rules/backlog без явного указания владельца;
- автоматически стартовать `/pipeline-run`.

## Результат

Верни `run-id`, `planning_base_sha`, pipelines, зависимости между runs, CI contract, blockers, unresolved risks и следующую команду запуска.
