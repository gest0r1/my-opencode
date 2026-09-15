---
description: Выполнить утверждённый design-freeze pipeline manifest
tags:
  - pipeline
  - execution
  - unattended
  - github-handoff
---

# Pipeline Run

Выполняй только frozen approved manifest. OpenStageOrchestrator остаётся
единственным владельцем state transitions и child-agent routing.

## Аргументы

Обычный режим:

```text
/pipeline-run <run-id> [--unattended] [--no-session-reuse]
```

GitHub validation handoff:

```text
/pipeline-run <run-id> github <handoff-id> [--unattended] [--no-session-reuse]
```

Неизвестный mode/лишний positional argument → `blocked`.

## Authority

- `stage-cli` владеет frozen rules/manifest и DAG state.
- `stage-cli next` является единственным источником runnable pipeline/stage.
- `git-worktree-cli` владеет workspace/branch/source/scope/publish integrity.
- `gate-runner-cli` выполняет только frozen machine gates и пишет evidence.
- LLM agents реализуют/анализируют работу, но не подменяют deterministic PASS.

Не пересчитывай dependencies/conflicts в RUN. PLAN уже скомпилировал их в DAG.

## Preflight — normal mode

1. Выполни:

```text
stage-cli validate <run-id> --json
stage-cli next <run-id> --json
```

2. State обязан быть approved/in-progress либо terminal. Manifest/rules hash
   mismatch → `blocked`.
3. Если manifest содержит `git_setup`, сначала выполни:

```text
git-worktree-cli.ts capability <manifest>
```

   Затем выбери путь **только по frozen `git_setup.workspace_mode`**:

   Canonical OpenChamber mode:

```text
git_setup.workspace_mode == linked_worktree
git-worktree-cli.ts adopt <manifest>
git-worktree-cli.ts verify <manifest>
```

   `adopt` обязан подтвердить physical linked Git worktree, approved branch/base
   SHA и применить разрешённый `source_sha/checkout_paths`. Если worktree identity
   не совпала — `blocked`. Никогда не делай fallback к `setup` или свободному Git.

   Legacy advanced mode:

```text
git_setup.workspace_mode отсутствует или == legacy_current_checkout
git-worktree-cli.ts setup <manifest>
git-worktree-cli.ts verify <manifest>
```

   Legacy mode оставлен для совместимости/отладки и не является canonical `/pipeline` flow.
4. Не делай отдельный LLM-preflight по conflict groups/path collisions: если
   `stage-cli next` не выдал stage, она не runnable.

## Scheduler loop

Повторяй до terminal state:

1. `stage-cli next <run-id> --json`.
2. Полученные одновременно runnable stages могут выполняться параллельно.
   OpenStage вызывает child agents **напрямую**. Не делегируй orchestration в
   BatchExecutor.
3. Перед каждым stage: `stage-cli start ...`.
4. Выполни stage по dispatch ниже.
5. После deterministic/qualitative PASS: `stage-cli complete ... --evidence <path>`.
6. При blocker/failure: `stage-cli block|fail ... --evidence <path>`.
7. Снова вызови `stage-cli next`; downstream появится только после завершения
   prerequisites.

Если runnable queue пуст, используй state как источник terminal результата;
не пытайся самостоятельно «разблокировать» dependency.

## Stage dispatch

### implementation / technical_fix

- CoderAgent получает конкретный work item, exact context packet, acceptance
  criteria и `git_worktree_gate=PASS`.
- CoderAgent не вызывает TestEngineer и не выполняет Git/state transitions.
- Для параллельных work items OpenStage сам делает несколько `task()` calls.
- После каждого source-changing work item:

```text
git-worktree-cli.ts verify <manifest>
```

  Scope failure → `scope_stop` и block.

### build / tests / lint / typecheck

Machine commands запускает только:

```text
gate-runner-cli.ts <run-id> <pipeline-id> <gate>
```

BuildAgent/TestEngineer могут подготовить или интерпретировать работу, если это
предусмотрено stage, но их текстовый PASS не заменяет runner evidence.
TestEngineer в pipeline mode не просит отдельного approval: approved manifest
уже разрешил test stage.

### review

CodeReviewer запускается fresh. Он пишет review evidence в `.tmp/**` и
классифицирует finding как `technical_fix`, `replan`, `security_stop`,
`scope_stop`, `secret_stop` или `optional`.

### docs

DocWriter изменяет только approved documentation scope. В pipeline mode не
запрашивает повторное подтверждение для уже утверждённой docs stage.

### publish_candidate

После required fast gates и scope PASS:

```text
git-worktree-cli.ts verify <manifest>
git-worktree-cli.ts publish <manifest>
```

`publish` делает только scoped commit/non-force push approved branch, повторно
проверяет remote SHA и пишет `candidate.json` с exact `candidate_sha`.

### runtime_install / release_validation / smoke

Mutation/validation выполняет `gate-runner-cli`, а не свободный shell
OpenDevopsSpecialist. Runner:

- использует frozen manifest;
- запускает executable+argv без shell;
- подставляет `{candidate_sha}` из `candidate.json`;
- использует `runtime_locks` только для shared external mutable target;
- пишет machine evidence.

OpenDevopsSpecialist нужен только для анализа deployment issue/plan или
интерпретации результатов, не для обхода runner.

## Candidate SHA loop

Для deployable runtime целевой normal flow:

```text
implementation
  -> fast build/test gates
  -> git scope verify
  -> publish candidate
  -> candidate_sha
  -> runtime_install(candidate_sha)
  -> runtime_validation
```

При `technical_fix` после первого publish:

```text
fix -> scope verify -> affected fast gates -> publish new candidate
-> reinstall exact new candidate_sha -> rerun affected runtime gates
```

Нельзя тестировать runtime из local development folder, если manifest требует
GitHub candidate installation.

## `--unattended`

Внутри approved scope child agents не задают дополнительные approval-вопросы.
При `--unattended` никогда не вызывай native `question`. Любая новая необходимость
owner decision, scope expansion, security exception или destructive action вне
frozen manifest должна завершить текущий execution как `blocked`/`replan`, а не
открывать интерактивный prompt.

`--unattended` не разрешает:

- scope expansion;
- owner decision;
- security/secret/destructive bypass;
- изменение frozen manifest/rules;
- игнорирование deterministic FAIL;
- обход linked-worktree identity check.

Если требуется новое функциональное решение или scope expansion → `replan`.

## Session reuse

Session reuse включён по умолчанию; `--no-session-reuse` делает все child calls fresh.

Reuse разрешён только для `CoderAgent`, `TestEngineer`, `BuildAgent` и только
для `technical_fix` того же logical identity:

```text
{run_id, pipeline_id, stage, role, work_item_id}
```

OpenStage является parent для всех reusable calls. BatchExecutor и другие
nested orchestrators не участвуют в reuse path.

Перед reusable call вызови `pipeline_runtime_prepare(...)`, затем следующий
matching `task()` содержит:

```text
<pipeline_work_item id="<same-work-item-id>"/>
```

Baseline (`technical_fix:false`) всегда fresh и регистрируется. Reuse допускается
только при exact identity, healthy session, matching previous state revision,
valid evidence/diff/required reread. Любое несоответствие → fresh fallback, а
не остановка pipeline. Review/planning roles всегда fresh.

Registry и metrics остаются:

```text
.tmp/pipelines/{run-id}/session-registry.json
.tmp/pipelines/{run-id}/reuse-metrics/events.jsonl
```

## GitHub validation handoff mode

Этот mode используется, когда implementation уже выполнен внешним исполнителем.

1. `github_handoff_prepare(run_id, handoff_id)` проверяет immutable handoff ref,
   repository/source SHA, clean worktree и создаёт validation manifest.
2. `github_handoff_status` обязан подтвердить exact source SHA/current branch.
3. State создаётся/валидируется через `stage-cli`; выполняются только stages из
   validation manifest.
4. Machine validation по возможности идёт через тот же `gate-runner-cli`;
   agent report не заменяет фактический command evidence.
5. Допустимый `technical_fix` ограничен `allowed_fix_scope`, максимум два loop.
6. `github_handoff_publish` публикует только validated allowed-scope result и
   повторно подтверждает remote SHA.

Свободные `git pull/checkout/push`, смена handoff ref/source SHA или публикация
вне `allowed_fix_scope` запрещены.

## Stop classification

- `technical_fix` — исправление внутри frozen scope, после него повтори affected gates;
- `optional` — записать evidence, не блокирует;
- `replan` — stop/block;
- `security_stop`, `secret_stop`, `scope_stop`, destructive condition — stop/block.

## Результат

Верни только terminal summary при `completed`, `blocked` или `failed`:
run/pipeline statuses, candidate/source SHA, machine evidence paths,
review/test/runtime results, fix loops, blockers и reuse decisions.
