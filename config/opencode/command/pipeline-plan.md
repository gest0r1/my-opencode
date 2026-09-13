---
description: Построить design-freeze plan pipeline без запуска реализации
tags:
  - pipeline
  - planning
  - design-freeze
  - worktree-isolation
---

# Pipeline Planning

`/pipeline-plan` выполняет только совместную с владельцем проработку постановки и design freeze. Команда не меняет исходный код, не запускает реализацию и никогда автоматически не переходит в `/pipeline-run`.

## Аргументы

`$ARGUMENTS` может содержать путь к plan-файлу. По умолчанию:

```text
plan: docs/plan.md
rules: docs/pipeline-rules.md
```

## Stage 0 — Workspace Isolation Gate

Эта стадия обязательна ДО чтения изменяемого project context. Цель — не позволить PLAN читать смесь состояний файлов, пока другой RUN меняет тот же working tree.

1. Сформируй новый `run-id` для планируемого запуска. Создание run-id не означает запуск реализации.
2. Выполни read-only preflight:

```bash
node .opencode/skills/task-management/scripts/workspace-preflight.mjs plan --run-id <run-id>
```

Если project-local script отсутствует, используй установленный вариант:

```bash
node ~/.config/opencode/skills/task-management/scripts/workspace-preflight.mjs plan --run-id <run-id>
```

3. Если `same_worktree_conflicts` не пуст, PLAN заблокирован. Нельзя продолжать в этом worktree. Нужно открыть/перенести текущую OpenChamber/OpenCode session в отдельный Git worktree либо завершить/явно закрыть остальные незавершённые RUN в этом worktree.
4. Если конфликтов нет, НЕ задавай владельцу отдельный вопрос про worktree. Прими `workspace_mode` из deterministic preflight и продолжай автоматически.
5. Сохрани результат preflight как локальный evidence `.tmp/pipelines/{run-id}/workspace-preflight.json`: `workspace_mode`, `head_sha`, branch, `worktree_id`, timestamp, список обнаруженных other runs и conflicts. Абсолютный путь worktree в manifest не сохраняй.
6. Зафиксируй `planning_base_sha = head_sha` и `planning_base_branch = branch` из preflight. Именно этот SHA является базой design freeze.
7. Если planning context содержит tracked dirty files, обсуждение допускается, но manifest нельзя утверждать и `stage-cli init` нельзя выполнять, пока контекст не приведён к воспроизводимому Git snapshot. Владелец должен закоммитить/убрать изменения и повторить preflight; новый HEAD становится `planning_base_sha`.

PLAN и другой RUN могут идти одновременно только в разных worktree. Два PLAN могут идти параллельно, если не меняют исходники и используют разные `run-id`/`.tmp/pipelines/{run-id}`.

## Обязательный planning flow

1. После Workspace Isolation Gate работай строго `plan-only`.
2. Прочитай plan, rules, architecture context по dual-read и нужные user stories.
3. Проверь `edit_policy: human_only`; иначе верни `blocked`.
4. Через ContextScout собери project context. Для risk-trigger (`new library`, внешний API, auth/payment/tenant, security, migration, queue/cache, deploy/runtime) получи official version-specific evidence через ExternalScout и максимум 2–3 зрелых public code patterns через CoderAgent/CodeReviewer.
5. Выполни StoryMapper/SeniorStoryReviewer, ArchitectureAnalyzer, ContractManager, PrioritizationEngine и SeniorTechnicalPlanReviewer.
6. Все функциональные развилки собери в один owner decision packet. Не выбирай отсутствующее пользовательское решение самостоятельно.
7. Создай planning artifacts: `decision-register.md`, `technology-evidence.md`, `contract-inventory.md`, `test-strategy.md`, `accepted-risks.md`.
8. Построй dependency graph. Определи pipelines, `exclusive_paths`, `conflict_group`, migrations, fixtures, deployment locks и gate profiles.
9. Явно найди зависимости от других незавершённых runs. Если будущий pipeline использует результат RUN-X, добавь `depends_on_runs` и перечисли требуемые decision/contract/artifact IDs. Это позволяет готовить PLAN-2 до завершения RUN-1, но RUN-2 не сможет стартовать, пока зависимость не подтверждена.
10. TaskManager создаёт задачи только после readiness `ready`; каждая задача содержит binary acceptance criteria, tests и ссылки на decision/contract/research.
11. Определи CI contract для выполнения:
    - `fast_required_checks` — format/lint/typecheck/build/doc-gate/affected tests;
    - `full_required_checks` — полный deterministic test suite;
    - `runtime_required_checks` — установка из GitHub exact SHA + integration/e2e/smoke на изолированном runtime;
    - если проект пока не имеет нужных GitHub Actions, это blocker для release validation, а не повод заменять CI вызовом LLM.
12. Создай manifest с `planning_mode: design-freeze`, readiness и per-pipeline decision/research/contract IDs.

## Обязательные поля нового manifest

Новые design-freeze manifests должны включать:

```json
{
  "planning_mode": "design-freeze",
  "planning_context": {
    "base_branch": "feature-or-main",
    "base_sha": "40-hex-git-sha",
    "workspace_mode": "dedicated_worktree | exclusive_shared_worktree",
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

1. Проверь manifest. `open_decision`, отсутствие воспроизводимого `base_sha`, failed workspace preflight или planning blocker запрещают approval.
2. Покажи владельцу один consolidated decision packet и manifest.
3. Только после явного approval вызови `stage-cli init`.
4. После init остановись и верни команду `/pipeline-run {run-id} --unattended`. Сам `/pipeline-run` не запускай.

## Запрещено

- изменять исходный код;
- вызывать CoderAgent для реализации;
- запускать implementation tests, Docker или deployment;
- читать mutable project context до Workspace Isolation Gate;
- продолжать в том же worktree при обнаруженном незавершённом RUN;
- задавать владельцу отдельный worktree-confirmation вопрос при зелёном preflight;
- менять rules/backlog без явного указания владельца;
- автоматически стартовать `/pipeline-run`.

## Результат

Верни `run-id`, `planning_base_sha`, workspace mode, pipelines, зависимости между runs, gate profiles/CI contract, blockers, unresolved risks и следующую команду запуска.
