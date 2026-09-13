---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
  - ci-first
  - github-sha
  - worktree-isolation
---

# Pipeline Run

`/pipeline-run` выполняет только уже утверждённый design-freeze manifest. Planning остаётся отдельной командой `/pipeline-plan`; RUN не пересматривает продуктовые решения молча.

## Аргументы

Обычный режим:

```text
/pipeline-run <run-id> [--unattended] [--no-session-reuse]
```

GitHub validation handoff (compatibility mode):

```text
/pipeline-run <run-id> github <handoff-id> [--unattended] [--no-session-reuse]
```

Без `run-id` попроси выбрать manifest. Неизвестный mode/лишний positional argument → `blocked`.

## Stage 0 — Workspace Isolation Gate

До implementation и до чтения mutable source выполни:

```bash
node .opencode/skills/task-management/scripts/workspace-preflight.mjs run --run-id <run-id> --base-sha <planning_base_sha>
```

Fallback:

```bash
node ~/.config/opencode/skills/task-management/scripts/workspace-preflight.mjs run --run-id <run-id> --base-sha <planning_base_sha>
```

Правила:

1. Если `same_worktree_conflicts` содержит другой незавершённый RUN — `blocked`. Нельзя разрешить два изменяющих один worktree RUN.
2. Если конфликтов нет, НЕ задавай владельцу отдельный вопрос про worktree. Прими `workspace_mode` из deterministic preflight, сохрани evidence в `.tmp/pipelines/{run-id}/workspace-preflight.json` и продолжай автоматически.
3. Worktree относится к DEV execution. Validation runtime не должен запускаться из этого checkout.

## Preflight — ordinary mode

1. Найди manifest/state, выполни `stage-cli validate`, проверь approval, rules, dependencies, conflict groups и locks.
2. Проверь `planning_context.base_sha`, workspace preflight evidence и CI contract.
3. Проверяй зависимости `planning_context.depends_on_runs`:
   - required RUN должен иметь terminal `completed`;
   - требуемые contract/artifact IDs должны существовать и совпадать с ожиданиями PLAN;
   - несовпадение контракта/решения → `replan`.
4. Оцени drift от `planning_base_sha` по evidence `workspace-preflight`:
   - current HEAD не является descendant base SHA → `replan`;
   - drift пересекает `exclusive_paths`, contracts, migrations, security boundaries или принятые decisions → targeted revalidation; при изменении решения → `replan`;
   - непересекающийся drift допускается только с evidence, что acceptance/architecture не изменились.
5. Dirty worktree до первой implementation stage запрещён.

## Execution model — CI first

### 1. Implementation in DEV worktree

BatchExecutor/CoderAgent меняют только DEV workspace текущего RUN. CoderAgent не меняет validation runtime и не подменяет Git/CI evidence текстовым отчётом.

Разрешены быстрые local prechecks, но они не считаются release evidence.

### 2. Git publication / immutable source SHA

После законченного implementation batch:

1. через одобренный Git mechanism закоммить только разрешённые paths;
2. push feature branch в GitHub;
3. получи remote commit SHA и заморозь его как `source_sha`;
4. проверь, что локальный опубликованный commit и remote SHA совпадают;
5. все последующие gates относятся к exact `source_sha`, а не к имени ветки.

Если нет воспроизводимого remote SHA, validation не начинается.

### 3. FAST CI — до любого дорогого LLM review

FAST CI должен содержать дешёвые deterministic checks: format/lint/typecheck/build/doc validator/affected tests и project-specific static/security checks.

Проверяй exact SHA без LLM polling:

```bash
node .opencode/skills/task-management/scripts/github-ci-gate.mjs \
  --sha <source_sha> \
  --required <comma-separated-fast-checks> \
  --wait-seconds 900
```

Fallback — установленный script в `~/.config/opencode/...`.

- FAST CI FAIL → CodeReviewer/TestEngineer не запускать.
- Сначала используй CI logs/evidence. BuildAgent вызывается только если причина build/typecheck/CI failure неочевидна или требуется воспроизведение.
- `technical_fix` выполняется только в DEV worktree. Затем новый commit/push → новый `source_sha` → FAST CI сначала.
- максимум два automatic technical-fix loop на stage, если project rules не задают меньший предел.

### 4. После FAST PASS — semantic review и FULL CI параллельно

Запусти независимо:

- `CodeReviewer` fresh session: semantics/security/architecture/contracts/maintainability;
- FULL CI: полный deterministic test suite на том же `source_sha`.

FULL CI проверяется `github-ci-gate.mjs` по `ci.full_required_checks`.

Ни один LLM не должен повторно выполнять полный test suite только ради подтверждения зелёного GitHub check.

Если FULL CI падает, reviewer может закончить уже начатый review, но новый expensive review для того же заведомо broken SHA не запускай.

### 5. TestEngineer = test-quality gate, а не test runner

После FAST PASS и при наличии review/full-CI evidence TestEngineer проверяет:

- traceability `acceptance criterion → test`;
- missing positive/negative/edge cases;
- trivial/self-fulfilling assertions;
- неверное/избыточное mocking;
- regression gaps.

Если тестов достаточно — PASS без повторного полного запуска. Если TestEngineer добавил/изменил тесты, появился новый SHA: commit/push и возврат к FAST CI.

### 6. Remote-pinned runtime validation

Последний технический gate — `ci.runtime_required_checks`. Он должен исполняться в изолированном runtime/self-hosted runner и обязан:

1. очистить/создать validation environment;
2. получить исходники/пакет ТОЛЬКО из GitHub по exact `source_sha` (не копировать из DEV workspace);
3. build/install/deploy;
4. подтвердить `installed_sha == source_sha` или эквивалентный artifact digest;
5. выполнить integration/e2e/health/smoke и при необходимости rollback validation;
6. сохранить provenance evidence (`source_sha`, `installed_sha`, workflow run/check, artifact/image digest если есть).

Validation runtime immutable относительно source: исправления внутри него запрещены.

Runtime FAIL → диагностируй evidence. OpenDevopsSpecialist вызывается только для неоднозначной infra/deploy причины или если approved scope действительно меняет infrastructure. Кодовый fix всегда возвращается в DEV → новый SHA → FAST CI → зависимые gates заново → новый clean runtime.

### 7. READY_FOR_APPROVAL

После PASS обязательны:

```text
source_sha == validated_sha
fast_ci = PASS
full_ci = PASS
semantic_review = PASS
runtime_validation = PASS
installed_sha == source_sha (или verified artifact digest)
```

Сохрани evidence и остановись со статусом `READY_FOR_APPROVAL`. Не merge в `main` без отдельного явного подтверждения владельца.

После approval/merge получи exact `main_sha`; перед production сделай короткую повторную deterministic validation именно `main_sha`/промотируемого immutable artifact.

## Failure classification

- `technical_fix` — дефект внутри approved scope: bounded auto-fix в DEV;
- `replan` — требуется новое решение/контракт или materially changed planning assumption: block;
- `security_stop`, `scope_stop`, `secret_stop`, `destructive_stop` — block;
- `optional` — evidence, не блокирует.

`--unattended` отменяет промежуточные вопросы только внутри approved scope. Workspace Isolation Gate теперь deterministic и не требует отдельного owner confirmation; hard stops остаются обязательными.

## GitHub validation handoff compatibility mode

Существующий `github <handoff-id>` режим сохраняется для внешнего handoff. Источник — immutable `origin/handoff/<handoff-id>` с `.opencode/pipeline-handoff.json` и `source_sha`.

Обязательные invariants остаются:

- `github_handoff_prepare` создаёт `pipeline/<run-id>` строго от `source_sha`;
- `current_head == source_sha` до validation;
- malformed/shifted handoff → block;
- validation выполняет только stages из handoff;
- `replan`/scope/security/secret/destructive → block;
- publish запрещает secret paths/divergent/non-fast-forward result;
- финальный evidence содержит `handoff_id`, `source_sha`, `validated_sha`, checks и fixes.

Новые проекты должны предпочитать ordinary CI-first flow выше: fixes в DEV и clean revalidation remote SHA. Handoff compatibility mode не должен использоваться как основание для запуска runtime из development checkout.

## Session reuse

Нативный `task_id` не выбирается моделью. Router владеет reuse decision.

Logical identity:

```text
{run_id, pipeline_id, stage, role, work_item_id}
```

`work_item_id` стабилен для одного logical work item между baseline/fix loop и уникален для параллельных задач.

Reuse разрешён только CoderAgent/TestEngineer/BuildAgent внутри `technical_fix` exact same identity. Planning roles, CodeReviewer, SeniorTechnicalPlanReviewer, OpenDevopsSpecialist и DocWriter всегда fresh. Cross-run/pipeline/stage/role/work-item reuse запрещён.

Перед допустимым reuse используй `pipeline_runtime_prepare` с deterministic delta/evidence; при stale/missing evidence/session health problem — fresh fallback.

## Запрещено

- менять approved manifest/plan/rules во время RUN;
- запускать RUN в shared worktree одновременно с другим unfinished RUN;
- задавать владельцу отдельный worktree-confirmation вопрос при зелёном preflight;
- считать branch name достаточным provenance вместо exact SHA;
- запускать CodeReviewer на SHA, не прошедшем FAST CI;
- использовать LLM вместо deterministic GitHub checks;
- тестировать release из DEV checkout;
- исправлять код внутри validation runtime;
- пропускать новый FAST CI после нового commit SHA;
- merge `main` без явного approval владельца.

## Результат

Покажи: workspace mode, planning base SHA/drift result, source/validated/installed SHA, GitHub CI checks, semantic review, test-quality review, runtime provenance, fix loops, blockers и terminal status.
