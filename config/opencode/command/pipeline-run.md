---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
  - github-handoff
---

# Pipeline Run

Выполни утверждённый pipeline manifest.

## Аргументы

Базовый режим:

```text
/pipeline-run <run-id> [--unattended] [--no-session-reuse]
```

GitHub validation handoff:

```text
/pipeline-run <run-id> github <handoff-id> [--unattended] [--no-session-reuse]
```

`github` — positional mode, а не флаг. `handoff-id` обязателен и должен быть
одним токеном. Без `run-id` запроси выбор manifest, не выбирай молча. Если
указан `github` без `handoff-id`, лишний positional argument или неизвестный
режим — верни `blocked`.

Session-reuse включён по умолчанию в обоих режимах; `--no-session-reuse`
используется только для явного отключения reuse.

## Preflight — обычный режим

1. Найди manifest/state, выполни `stage-cli validate`, проверь rules и
   `edit_policy: human_only`.
2. Проверь approval manifest, dependencies, paths, conflict groups и locks.
3. Для `planning_mode: design-freeze` проверь `planning_readiness`, ссылки на
   decision/research/contract artifacts и отсутствие open decisions.
4. Выполни doc-gate по `pipeline-rules.md`.

При любой ошибке верни `blocked`; реализацию не запускай.

## GitHub validation handoff

Режим активируется только positional-вызовом:

```text
/pipeline-run <run-id> github <handoff-id>
```

Он означает: planning, architecture, implementation и code review уже
выполнены внешним исполнителем; OpenCode НЕ повторяет их, а забирает
зафиксированный результат из GitHub и продолжает с build/deploy/test и
`technical_fix`, если validation требует исправлений.

### Handoff transport

`handoff-id` разрешается через immutable handoff ref в репозитории продукта:

```text
origin/handoff/<handoff-id>
```

Этот ref обязан содержать:

```text
.opencode/pipeline-handoff.json
```

Минимальная схема handoff:

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

`repository` рекомендуется и при наличии обязан совпадать с GitHub `origin`.
`allowed_fix_scope` поддерживает exact paths или trailing `/**`; если scope
пуст, кодовые изменения публиковать запрещено.

### Deterministic Git preflight

Не выполняй handoff через свободные `git pull/checkout/push`. Используй только
`github-handoff-cli.ts`:

```text
npx tsx ~/.opencode/skills/task-management/scripts/github-handoff-cli.ts prepare <run-id> <handoff-id>
```

или project-local mirror:

```text
npx tsx .opencode/skills/task-management/scripts/github-handoff-cli.ts prepare <run-id> <handoff-id>
```

`prepare` обязан:

- требовать clean worktree;
- fetch `origin/handoff/<handoff-id>`;
- прочитать и валидировать `.opencode/pipeline-handoff.json`;
- проверить совпадение `run_id`/`handoff_id`/repository;
- fetch `source_branch`;
- требовать `origin/<source_branch> == source_sha`;
- проверить, что handoff ref основан на `source_sha`;
- создать локальную рабочую ветку `pipeline/<run-id>` строго от `source_sha`;
- записать `.tmp/pipelines/<run-id>/github-handoff.json`;
- создать `.tmp/pipelines/<run-id>/github-validation-manifest.json` только с
  validation stages из handoff.

Если исходная ветка сдвинулась после handoff, worktree грязный, SHA/repository
не совпали или handoff malformed — `blocked`, ничего не тестируй и не исправляй.

### Validation state

После успешного `prepare` используй созданный:

```text
.tmp/pipelines/<run-id>/github-validation-manifest.json
```

Если state для `<run-id>` отсутствует — инициализируй его через `stage-cli init`
с этим manifest и затем проведи штатное approval/start/complete flow согласно
локальной политике pipeline. Если state уже существует, он должен
соответствовать тому же `github-handoff.json`, pipeline-id и exact validation
stage order; иначе верни `blocked`, не переиспользуй чужой state.

В GitHub mode НЕ помечай пропущенными planning/implementation стадии обычного
manifest: они не входят в validation manifest вообще. Это отдельный runtime
continuation одного handoff, а не искусственный skip исходного pipeline.

### GitHub validation execution

Выполняй только `validation_stages` из handoff. Обычно это build, tests и
release/deploy validation. Не добавляй отсутствующие stages самостоятельно.

Для каждой стадии:

1. `stage-cli start`;
2. вызови профильного агента;
3. используй handoff acceptance и validation commands как обязательный input;
4. сохрани evidence;
5. при PASS — `stage-cli complete`;
6. при FAIL — классифицируй finding по тем же правилам, что в обычном run.

Классификация:

- `technical_fix` внутри `allowed_fix_scope`/approved scope — auto-fix, максимум
  два loop;
- `replan` — block и stop;
- scope/security/secret/destructive — block и stop;
- `optional` — evidence, не блокирует.

Сохраняй стабильное имя стадии внутри fix-loop. Не создавай `build-fix-1`,
`build-fix-2` и т.п.; меняй `loop`, а не `stage`. Это необходимо для identity
session-reuse `{run_id,pipeline_id,stage,role}`.

После каждого technical fix повтори непосредственно затронутый gate, затем
зависимые build/deploy/test gates. Не объявляй validation успешной только по
текстовому отчёту агента — нужны реальные команды/evidence.

### Publish validated result

После PASS всех обязательных validation stages изменения должны быть cleanly
зафиксированы и опубликованы в исходную product branch через deterministic
helper:

```text
npx tsx ~/.opencode/skills/task-management/scripts/github-handoff-cli.ts publish <run-id>
```

`publish`:

- разрешает изменённые файлы только внутри `allowed_fix_scope`;
- отклоняет `.env`, key/pem/secret/credential paths;
- при наличии допустимых fixes создаёт commit `fix: validation <run-id>`;
- требует, чтобы validated HEAD был потомком `source_sha`;
- fetch'ит `source_branch` и запрещает non-fast-forward/divergent publish;
- push'ит `HEAD` в исходную `source_branch`;
- повторно fetch'ит remote и проверяет exact SHA;
- записывает `validated_sha` в локальный handoff runtime.

Если fixes не было, publish всё равно верифицирует lineage/remote SHA и
фиксирует `validated_sha = source_sha`.

Финальный evidence GitHub mode обязан содержать как минимум:

```text
handoff_id
source_branch
source_sha
validated_sha
fix commit(s), если были
build/deploy/test results
session-reuse decisions
```

## Выполнение — общие правила

StageOrchestrator — это основная сессия; оркестрацию субагентам не передавай.
Перед стадией вызывай `stage-cli start`, после успеха — `complete`; evidence
обязателен. Выполняй только разрешённые batches/stages.

Классифицируй review findings по `pipeline-rules.md`:
- `technical_fix` внутри approved scope — auto-fix, максимум два loop;
- `replan` — `stage-cli block --reason replan`, не продолжай и не выбирай
  новую архитектуру в run;
- scope/security/secret/destructive — block и stop;
- `optional` — evidence, не блокирует.

`--unattended` запрещает дополнительные запросы внутри approved scope. Верни
только terminal summary при `completed`, `blocked` или `failed`.

## Session-reuse (включён по умолчанию)

Session-reuse активен по умолчанию для каждого pipeline и для GitHub validation
handoff. Отключение — явный флаг `--no-session-reuse`, который запрещает reuse
и принудительно делает все вызовы fresh.

### Runtime enforcement

НЕ выбирай и НЕ передавай `task_id` вручную. Решение fresh/reuse принимает
локальный plugin `pipeline-runtime`.

Перед КАЖДЫМ вызовом CoderAgent, TestEngineer или BuildAgent непосредственно
перед `task()` вызови tool `pipeline_runtime_prepare`, если не указан
`--no-session-reuse`.

- для первого/baseline вызова роли и для вызова вне `technical_fix` передай
  `technical_fix: false`; такой вызов всегда fresh, но его session будет
  зарегистрирована для последующего контролируемого reuse;
- для `technical_fix` передай `technical_fix: true`;
- `pilot_pipeline_id` обязан совпадать с pipeline-id из active manifest;
- `stage` и `role` должны точно соответствовать следующему `task()`;
- `state_revision` используй как текущую детерминированную ревизию state
  (явное revision/hash, а если его нет — стабильное поле `updated_at`);
- при повторном reuse передай `previous_state_revision` из последней записи
  session registry для той же identity;
- передай evidence, changed files или `diff_path`, и `required_reread`.

Runtime context одноразовый и ограничен по времени. Plugin сам:

- удаляет любой model-supplied `task_id`;
- сопоставляет identity `{run_id,pipeline_id,stage,role}`;
- допускает reuse только healthy session;
- на compaction/error/cancel/in-progress/stale/missing delta делает fresh fallback;
- проверяет evidence и required reread paths;
- добавляет deterministic delta в resumed prompt;
- ведёт session registry;
- пишет append-only метрики.

### Область применения

Reuse разрешён только ролям CoderAgent, TestEngineer и BuildAgent и только
внутри `technical_fix` loop одной стадии. Planning-роли и ВСЕ reviewer-роли
(CodeReviewer, SeniorTechnicalPlanReviewer и др.) всегда стартуют заново.

Идентичность reuse — `{run_id, pipeline_id, stage, role}`; переиспользование
сессии между pipeline или role запрещено.

### Stop conditions (fresh session)

Reuse отклоняется и стартует свежая сессия, если:

- произошла compaction сессии;
- cancellation/error на предыдущей итерации;
- предыдущий вызов не завершился (`in_progress`);
- handle/role mismatch;
- cross-pipeline mismatch;
- state/evidence/diff устарели;
- delta-пакет отсутствует или неполон.

Эти условия сами по себе pipeline не останавливают.

Pipeline останавливается (block и stop) только при
scope/security/replan/secret/destructive — reuse также отклоняется.

### Метрики (append-only)

Registry:
`<project-root>/.tmp/pipelines/{run_id}/session-registry.json`

Метрики:
`<project-root>/.tmp/pipelines/{run_id}/reuse-metrics/events.jsonl`

Фиксируются фактически наблюдаемые значения: fresh/reuse, fallback reason,
latency, orientation time (до первого edit/test/build), prompt/response/packet
bytes, tool/read/grep/glob/edit/bash calls, unique files read, reread files и
context reread ratio. Не выдумывай token usage, если OpenCode его не отдаёт.

## Запрещено

- менять approved manifest, plan или rules во время обычного run;
- в GitHub mode менять handoff ref или source_sha;
- использовать `git pull`, force-push или ручной push в обход handoff helper;
- пропускать обязательную validation stage;
- начинать неутверждённый обычный pipeline;
- запускать dependent pipeline до completed dependency;
- передавать `task_id` вручную в обход runtime plugin;
- публиковать изменения вне `allowed_fix_scope`.

## Результат

Обычный режим: верни status run и pipeline, stages, evidence,
Build/DevOps/test/review results, fix-loops, blockers, unresolved risks,
session-reuse решения и метрики.

GitHub mode: дополнительно верни `handoff_id`, `source_branch`, `source_sha`,
`validated_sha`, fix commits/changed files и результат remote SHA verification.
