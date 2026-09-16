---
description: Построить design-freeze plan pipeline без запуска реализации
tags:
  - pipeline
  - planning
  - design-freeze
---

# Pipeline Planning

Построй только утверждаемый design-freeze plan. Реализацию не запускай.

## Аргументы

`$ARGUMENTS` содержит описание задачи и может дополнительно ссылаться на plan-файл. По умолчанию:

```text
plan: docs/plan.md
rules: docs/pipeline-rules.md
```

Project rules предпочтительны. Если их нет, effective rules определяет только
`stage-cli rules`; агент не создаёт `docs/pipeline-rules.md` автоматически.

## Принцип

PLAN является компилятором исполнения: он заранее превращает зависимости,
пересечения файлов, migrations/fixtures и порядок проверок в DAG. `/pipeline-run`
не должен повторно решать архитектурные конфликты.

Оставляй runtime lock только для реально общего внешнего mutable target,
например `deploy:staging`, `database:prod-migration`, `runtime:warehouse-01`.
Обычные code/file conflicts кодируй dependency edge, а не runtime lock.

В canonical flow есть ровно один explicit approval: владелец утверждает финальный
frozen manifest. После этого routine actions внутри утверждённого scope не требуют
повторных подтверждений.

Product/backlog priority не является частью PLAN: задача уже выбрана владельцем
самим фактом `/pipeline` запуска.

## Owner interaction

Native `question` используется только в PLAN и только для двух случаев:

1. один batched owner decision packet, если остаются решения, которые нельзя
   вывести из rules/context;
2. один финальный вопрос на approval готового manifest/design freeze.

Не задавай промежуточные progress-вопросы и не дроби decision packet на серию
prompt'ов. OpenChamber `notifyOnQuestion` должен иметь возможность уведомить
владельца именно о реально требующем решения месте. После approval RUN становится
неинтерактивным: owner decision или scope expansion в `/pipeline-run --unattended`
приводит к `blocked`/`replan`, а не к новому `question`.

## Project discovery

- Для просмотра каталога используй native `Read` на directory path.
- Для перечисления файлов используй native `Glob`; для поиска содержимого — `Grep`.
- Никогда не используй `ls`, `find`, `tree`, `pwd`, `cat`, `head` или другие shell
  commands для filesystem discovery.
- Не выполняй preliminary shell inspection перед обязательными deterministic CLI.

## Обязательный flow

1. Не добавляй preliminary inspection step. Preflight начинается строго с:

```text
git-worktree-cli.ts inspect
stage-cli.ts rules docs/pipeline-rules.md --json
```

   Используй native Read/Glob/Grep и только approved deterministic CLI. Не
   вызывай произвольный shell/git. Rules gate обязан вернуть PASS.

   При canonical запуске через `/pipeline` результат `inspect` обязан показать
   `linked_worktree: true`, clean checkout, непустую task branch и exact current
   HEAD. Если canonical PLAN оказался в primary checkout, остановись `blocked`:
   не создавай branch через shell и не заменяй physical worktree обычным checkout.
2. Один раз собери project context через ContextScout и сформируй compact
   context packet. Downstream agents получают exact relevant paths; повторный
   ContextScout вызывается только при обнаруженном gap.
3. Классифицируй задачу и запускай planning agents только по trigger:
   - `StoryMapper` + `SeniorStoryReviewer`: user-facing behavior или неясные acceptance criteria;
   - `ArchitectureAnalyzer`: изменение architecture/domain boundaries или сложное cross-module взаимодействие;
   - `ContractManager`: HTTP/event/CLI/external/internal interface contract изменяется;
   - `ExternalScout`: new/changed external library/API, auth/payment/security/migration/runtime technology;
   - `SeniorTechnicalPlanReviewer`: medium/high risk, multi-pipeline, security/migration/runtime или существенная architecture change.
   Для low-risk локального изменения пропускай неприменимые роли. Product priority
   не вычисляй и `PrioritizationEngine` не вызывай.
4. Всем planning agents передавай artifact root:

```text
.tmp/pipelines/{run-id}/planning/
```

   Они не пишут source и не используют глобальные `.tmp/planning/**` или
   `.tmp/contracts/**` как canonical pipeline output.
5. Собери функциональные/архитектурные решения, которые нельзя вывести
   детерминированно, в один owner decision packet. Если пакет непустой, задай его
   одним native `question` вызовом и дождись ответа до продолжения. Не принимай
   owner decision сам. Если packet пуст, не вызывай `question` на этом шаге.
6. Построй DAG:
   - реальные prerequisite → `depends_on`;
   - overlapping source paths → выбери порядок и добавь dependency edge;
   - migration/fixture collision → dependency edge;
   - dependent verification/release → dependency edge;
   - независимые pipelines оставь параллельными.
   Не добавляй в manifest `conflict_group`, `exclusive_paths`, `migration_paths`
   или `fixture_paths`: это planning evidence, а не runtime state.
7. Для shared external mutable targets добавь только `runtime_locks` на
   соответствующий pipeline.
8. Сформируй top-level `allowed_change_paths`: минимальный union source/test/docs
   paths, которые этот run вправе изменить. `git_setup.checkout_paths` должны
   входить в этот scope. Secrets, `.git` и protected env files не включай.
9. TaskManager создаёт implementation tasks только после planning readiness.
   Tasks содержат binary acceptance criteria, deliverables, dependencies,
   suggested canonical agent ID и ссылки на relevant decision/research/contract.
   Task JSON — рабочий execution aid; authority остаётся frozen manifest.
10. Для canonical OpenChamber branch/source setup добавь данные **текущего уже
    созданного worktree**, полученные из deterministic `inspect`:

```json
{
  "git_setup": {
    "workspace_mode": "linked_worktree",
    "base_sha": "40-hex-current-worktree-head-before-source-checkout",
    "branch": "current-openchamber-worktree-branch",
    "source_sha": "optional-40-hex",
    "checkout_paths": [],
    "must_absent": []
  }
}
```

    PLAN не придумывает другую branch после создания worktree. `branch` и
    `base_sha` freeze фактическую workspace identity. Advanced прямой
    `/pipeline-plan` вне `/pipeline` допускает legacy mode только если пользователь
    явно выбрал старый workflow; canonical flow всегда `linked_worktree`.
11. `gate_profiles` содержит только machine-executable commands для
    deterministic `gate-runner-cli`. Один array item = один процесс без pipes,
    redirects, command substitution или command chaining. Qualitative review/docs
    выполняют агенты и не маскируются под shell-команды.
12. Для deployable runtime, когда проект имеет воспроизводимый installer,
    планируй цикл candidate SHA:

```text
implementation -> fast gates -> git scope verify -> publish candidate
-> runtime_install {candidate_sha} -> runtime_validation
```

    `{candidate_sha}` разрешён как placeholder в runtime gate command и
    подставляется deterministic runner из `candidate.json`. Если runtime install
    объективно неприменим, явно запиши `not_applicable` и причину в planning evidence.
13. Создай manifest минимум с:
   - `schema_version`, `run_id`;
   - `planning_mode: design-freeze`;
   - `rules_file`, `rules_version`;
   - `allowed_change_paths`;
   - pipelines `{id, stages, depends_on, profile?, runtime_locks?}`;
   - `gate_profiles` для machine gates;
   - `git_setup` при Git branch/source flow;
   - `open_decisions`.
14. После формирования final manifest, но до owner approval выполни единый
    deterministic readiness gate:

```text
pipeline-init-cli.ts <manifest> --check --json
```

    Он не создаёт canonical `state.json` и не запускает build/test/runtime commands.
    PASS означает, что manifest/DAG/rules валидны, referenced gate profiles используют
    разрешённые invocation и доступные top-level executables, workspace identity
    соответствует frozen `git_setup`, а в этом worktree нет другого active run.
    Любой FAIL/BLOCKED → не запрашивай approval и не создавай state. Project package
    dependencies остаются ответственностью воспроизводимого project installer/dependency files.
15. Покажи владельцу один финальный decision/manifest packet и запроси **ровно
    один** explicit approval через native `question`. Это единственный explicit
    approval canonical flow. Только после явного положительного ответа выполни:

```text
pipeline-init-cli.ts <manifest>
stage-cli approve <run-id>
stage-cli validate <run-id> --json
stage-cli next <run-id> --json
```

    Обычный `pipeline-init-cli` повторяет тот же readiness gate перед freeze, поэтому
    состояние не может быть создано в обход pre-approval проверки. Он атомарно
    запрещает второй active run в том же worktree; для параллельной разработки
    используй отдельный OpenChamber git worktree. После approval не запрашивай
    подтверждение для routine actions внутри frozen scope. Только approved state с
    ожидаемым runnable queue готов к execution. `/pipeline-run` автоматически не запускай.

## Planning artifacts

Canonical artifacts находятся под `.tmp/pipelines/{run-id}/`:

```text
manifest.json
decision-register.md
technology-evidence.md
contract-inventory.md
test-strategy.md
accepted-risks.md
planning/**
```

`state.json`, lock-файлы, gate evidence и candidate evidence принадлежат
детерминированным CLI/tools; LLM напрямую их не редактирует.

## Запрещено

- создавать/изменять `docs/pipeline-rules.md`;
- изменять implementation source в PLAN;
- вызывать CoderAgent для реализации;
- устанавливать system/project dependencies из PLAN;
- создавать runtime conflict detector там, где конфликт можно превратить в DAG edge;
- вычислять product/backlog priority внутри pipeline;
- вызывать `PrioritizationEngine` в canonical pipeline;
- создавать/switch branch в canonical flow вместо OpenChamber physical worktree;
- добавлять лишний approval внутри уже утверждаемого manifest;
- использовать `question` внутри unattended RUN;
- обходить rules/Git/state gates решением LLM.

## Результат

Верни run id, выбранные planning roles и причины, DAG/runnable roots,
`allowed_change_paths`, runtime locks, gate profiles, blockers/risks и следующий
пользовательский action:

```text
/pipeline-start {run-id}
```

`/pipeline-run {run-id} --unattended` оставь как advanced/debug direct execution,
но canonical OpenChamber flow запускается через `/pipeline-start`, чтобы RUN получил
отдельную Goal-session в том же worktree.
