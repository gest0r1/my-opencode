---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
  - ci-first
  - github-sha
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

## Stage 0 — Deterministic preflight

До implementation и чтения mutable source выполни:

```bash
node .opencode/skills/task-management/scripts/workspace-preflight.mjs run --run-id <run-id> --base-sha <planning_base_sha>
```

Fallback:

```bash
node ~/.config/opencode/skills/task-management/scripts/workspace-preflight.mjs run --run-id <run-id> --base-sha <planning_base_sha>
```

Контракт gate:

- exit `0` → продолжай молча;
- non-zero → остановись и покажи возвращённую причину;
- helper сам сохраняет `.tmp/pipelines/{run-id}/workspace-preflight.json`.

## Preflight — ordinary mode

1. Найди manifest/state, выполни `stage-cli validate`, проверь approval, rules, dependencies, conflict groups и locks.
2. Проверь `planning_context.base_sha` и CI contract.
3. Для `planning_context.depends_on_runs` проверь terminal `completed` и требуемые contract/artifact IDs; несовпадение решения/контракта → `replan`.
4. Если Git drift из preflight пересекает `exclusive_paths`, contracts, migrations, security boundaries или approved decisions, выполни targeted revalidation; material change → `replan`.

## Execution model — CI first

### 1. Implementation in DEV worktree

BatchExecutor/CoderAgent меняют только DEV workspace текущего RUN. Быстрые local prechecks разрешены, но не являются release evidence.

### 2. Git publication / immutable source SHA

После implementation batch:

1. закоммить только разрешённые paths;
2. push feature branch;
3. получи remote commit SHA как `source_sha`;
4. проверь совпадение local published commit и remote SHA;
5. все дальнейшие gates относятся к exact `source_sha`.

Без воспроизводимого remote SHA validation не начинается.

### 3. FAST CI — до дорогого LLM review

Проверяй exact SHA:

```bash
node .opencode/skills/task-management/scripts/github-ci-gate.mjs \
  --sha <source_sha> \
  --required <comma-separated-fast-checks> \
  --wait-seconds 900
```

- PASS → дальше;
- FAIL → CodeReviewer/TestEngineer не запускать; сначала использовать CI evidence;
- BuildAgent — только если build/typecheck failure требует анализа;
- любой `technical_fix` только в DEV → новый commit/SHA → FAST CI заново;
- максимум два automatic technical-fix loop на stage, если rules не задают меньше.

### 4. После FAST PASS — CodeReviewer и FULL CI параллельно

- `CodeReviewer` fresh session: semantics/security/architecture/contracts/maintainability;
- FULL CI: полный deterministic test suite того же `source_sha`.

FULL CI проверяется `github-ci-gate.mjs` по `ci.full_required_checks`. Не запускай LLM только для повторения уже зелёного deterministic suite.

### 5. TestEngineer = test-quality gate

Проверяет acceptance→tests traceability, negative/edge coverage, assertion quality, mocking и regression gaps. Если он меняет тесты — новый SHA и возврат к FAST CI.

### 6. Remote-pinned runtime validation

`ci.runtime_required_checks` выполняется в изолированном runtime/self-hosted runner и обязан получить release source/artifact только из GitHub exact `source_sha`, подтвердить installed provenance и выполнить integration/e2e/health/smoke.

Успех требует `installed_sha == source_sha` либо verified immutable artifact digest, связанный с `source_sha`. Исправления в validation runtime запрещены; кодовый fix возвращается в DEV и создаёт новый SHA.

OpenDevopsSpecialist вызывается только для неоднозначной infra/deploy причины или approved infrastructure change.

### 7. READY_FOR_APPROVAL

Обязательны:

```text
source_sha == validated_sha
fast_ci = PASS
full_ci = PASS
semantic_review = PASS
runtime_validation = PASS
installed_sha == source_sha (или verified artifact digest)
```

Сохрани evidence и остановись `READY_FOR_APPROVAL`. Не merge `main` без отдельного явного подтверждения владельца. После merge повторно проверь exact `main_sha`/промотируемый immutable artifact перед production.

## Failure classification

- `technical_fix` — дефект внутри approved scope: bounded auto-fix в DEV;
- `replan` — требуется новое решение/контракт или materially changed planning assumption;
- `security_stop`, `scope_stop`, `secret_stop`, `destructive_stop` — block;
- `optional` — nonblocking evidence.

`--unattended` отменяет промежуточные вопросы только внутри approved scope; hard stops остаются обязательными.

## GitHub validation handoff compatibility mode

Существующий `github <handoff-id>` режим сохраняется. Источник — immutable `origin/handoff/<handoff-id>` с `.opencode/pipeline-handoff.json` и `source_sha`.

Invariants: prepare строго от `source_sha`; `current_head == source_sha`; malformed/shifted handoff → block; выполнять только разрешённые stages; replan/scope/security/secret/destructive → block; publish без secrets/divergence; final evidence содержит handoff/source/validated SHA, checks и fixes.

Новые проекты должны предпочитать ordinary CI-first flow: fixes в DEV и clean revalidation remote SHA.

## Session reuse

Router владеет reuse decision; модель не выбирает native `task_id`.

Logical identity:

```text
{run_id, pipeline_id, stage, role, work_item_id}
```

Reuse разрешён только CoderAgent/TestEngineer/BuildAgent внутри `technical_fix` exact same identity. Planning roles, CodeReviewer, SeniorTechnicalPlanReviewer, OpenDevopsSpecialist и DocWriter всегда fresh. Перед reuse используй `pipeline_runtime_prepare`; stale/missing evidence/session health problem → fresh fallback.

## Запрещено

- менять approved manifest/plan/rules во время RUN;
- считать branch name provenance вместо exact SHA;
- запускать CodeReviewer до FAST CI PASS;
- использовать LLM вместо deterministic GitHub checks;
- тестировать release из DEV checkout;
- исправлять код внутри validation runtime;
- пропускать FAST CI после нового commit SHA;
- merge `main` без явного approval владельца.

## Результат

Покажи planning base SHA/drift result, source/validated/installed SHA, GitHub CI checks, semantic review, test-quality review, runtime provenance, fix loops, blockers и terminal status.
