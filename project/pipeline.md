# Универсальный pipeline target-проектов

Канонические команды живут в `config/opencode/command/pipeline-*.md`, deterministic state/Git/GitHub gates — в `config/opencode/skills/task-management/scripts/`.

OpenCode и OpenChamber являются средой запуска pipeline. Они не являются обязательным предметом `/pipeline-*`: их собственная разработка может выполняться отдельно через GPT/PR-процесс.

## Ответственный агент

Конвейером управляет основной агент **OpenStageOrchestrator**. Planning/implementation/review/test/build/DevOps субагенты выполняют только замороженные work items и не оркестрируют pipeline самостоятельно.

## Источник PLAN

`/pipeline-plan #51 #47`, файл, текст или пустая команда с linked GitHub Issue refs из OpenChamber. Fallback на `docs/plan.md` отсутствует. `#N` относится только к repository текущего worktree. OpenChamber передаёт refs; PLAN заново читает Issue из GitHub.

## Cost-aware CI/CD

Schema v2 фиксирует явный executor каждой стадии. Для одного продукта upstream work-blocks доводятся до source-ready, а terminal deployable sink выполняет одну интегрированную цепочку:

```text
implementation/review
  -> git_verify
  -> local_gate: test/lint/typecheck/build/install/smoke
  -> git_publish exact candidate SHA
  -> one lean artifactless github_ci
  -> optional local or remote CD
  -> optional owner acceptance
```

Локальные machine gates выполняет уже существующий `gate-runner-cli`; новые executor/CLI для этого не нужны. Локальный fail-fast ставится после `git_verify` и до `git_publish`: при ошибке candidate не пушится и GitHub Actions minutes не расходуются. После публикации deployable sink всё равно проходит один независимый final `github_ci` на exact SHA.

Режим выбирает владелец:

- `github` — local fail-fast + final GitHub CI, без OpenCode-host CD;
- `opencode_host` — local fail-fast + final GitHub CI + специальный trusted GitHub-driven `github_dev` CD; только этот режим требует deployment-target probe;
- `hybrid` — local fail-fast + final GitHub CI + post-CI `local_gate`, который устанавливает/обновляет exact `candidate_sha` на OpenCode/dev host и выполняет smoke.

`deployment_validation.stage` всегда указывает на final `github_ci`. Старые `fresh_job`/`upgrade_job` допускаются как legacy metadata, но больше не являются обязательными GitHub jobs. Fresh/repeat-install и тяжёлые runtime/E2E проверки предпочтительно выполняются локально, если проект предоставляет детерминированные команды.

Canonical candidate CI artifactless: без `actions/upload-artifact`/`actions/download-artifact`; evidence связывает exact candidate SHA, workflow run/attempt и required jobs. GitHub CI следует держать коротким и независимым, а не повторять дорогостоящую локальную установку без причины.

Release packaging отделён от candidate CI. Если проект реально выпускает package/container/binary, используется его существующий release/tag workflow, а результат публикуется в GitHub Release или registry. Actions artifacts не используются как долговременное хранилище релизов.

Если final CI отсутствует, PLAN замораживает обычный bootstrap/adaptation work item. Новый privileged stateful CD workflow нужен только для выбранного `opencode_host` режима и по-прежнему становится runnable только после merge в trusted ref.

## Stories

Один стабильный `.tmp/pipelines/<run-id>/stories/issue-N.md` на Issue; корректировки переписывают его. Reviews append-only.

## Existing implementation / V1 → V2

Если новая V2-планировка продолжает уже закоммиченную разработку из старого run, PLAN фиксирует её через `git-worktree-cli baseline <base-sha>` как `preserved_baseline`: exact HEAD, список путей и diff identity. Этот historical diff может оставаться в ветке, но не становится writable scope; изменение preserved-файла новым RUN всё равно требует `allowed_change_paths`.

До owner approval обязательны `stage-cli plan-run-preflight`, `git-worktree-cli adopt` и `git-worktree-cli verify`. Поэтому schema/scope/baseline ошибки должны обнаруживаться до утверждения.

После `init` frozen manifest не правится. Коррекция frozen V2 создаётся командой `stage-cli supersede <old-run> <new-run> --reason <code>`: копируется только planning/source/work-item контекст, но не state/candidate/gate/GitHub evidence. Для каждого нового run сохраняется reason-coded lineage.

## Runtime fix budget

RUN начинает каждый stage с общим budget **5 automatic repair cycles** для `technical_fix` и bounded `security_fix`. При запуске владелец может заранее увеличить потолок всего RUN:

```text
/pipeline-run <run-id> --unattended --fix-cycles 10
```

`--fix-cycles N` задаёт ceiling, а не `+N`; deterministic `stage-cli fix-budget-set` только повышает существующие лимиты и не может их уменьшить. Максимум — 20. Во время RUN остаётся точечный `fix-budget-add +N` для активного stage. Исчерпание budget лишь делает owner-развилку обязательной; уже начатый цикл завершается через frozen review/gates. Runtime replan может проходить несколько раундов уточнений, но новые циклы выдаются только после явного owner approval финального локального плана. Изменение frozen requirements/acceptance/contracts/security boundaries остаётся full replan.

### Security fixes vs stops

`security_fix` — автоматический bounded repair, если frozen AC/contract/security rule уже однозначно определяет fail-closed/least-privilege исправление. Severity Critical/High сама по себе не требует остановки. Перед таким repair CodeReviewer пишет machine-readable evidence, а `stage-cli security-fix-check` детерминированно проверяет отсутствие owner decision, privilege expansion, secret exposure, destructive action и security-boundary change.

`security_stop` используется только когда владельцу реально нужно решить security policy/trust/access. `secret_stop` — при фактической утечке/необходимости rotation/revocation. `destructive_stop` — при необратимом remediation. Protected/sensitive scope остаётся `scope_stop`, а изменение security boundary — replan. Эти случаи должны быть `BLOCKED / awaiting owner`, а не terminal `failed` только из-за самого факта security-находки.

## Runtime implementation scope

The approved manifest freezes product decisions, acceptance criteria and base implementation scope, not an exhaustive list of future test files. RUN can add audited machine-owned test/support paths for already-approved app/package components. Additional production/config paths require decision-free architecture/reviewer evidence; protected/security/trust-boundary changes still require owner/replan. The frozen manifest itself is never rewritten.

## Live rules

Project `docs/pipeline-rules.md` and OpenCode's distribution `pipeline-rules.default.md` follow the same rule lifecycle. Pipeline commands and their agents never edit either rules source.

If the owner or distribution changes rules while the pipeline is stopped, the next RUN continuation reads the current file. A changed rules version/SHA updates machine-owned audit metadata and does not block by itself. Missing, unreadable, malformed rules or an invalid `edit_policy` still block. Never edit `state.json` manually.

## Main freshness

Manifest фиксирует `planning_base_sha` и `freshness_sensitive_paths`. `git-worktree-cli freshness` в начале RUN, пока worktree чистый, fetch'ит `origin/main`: релевантный drift → `STALE_PLAN` и replan; нерелевантный → deterministic merge и `run_base_sha` в `git-runtime.json`/state; frozen manifest не меняется.

## GitHub audit

Каждый реальный pipeline-status transition попадает в durable `github_outbox` и публикуется отдельным idempotent comment в mapped Issues. Идемпотентность действует на конкретный event marker: повторный sync не публикует тот же event второй раз, но следующий transition имеет новый event ID и создаёт новый комментарий; существующие audit-комментарии не редактируются и не объединяются. Если один Issue mapped к нескольким pipelines, каждая pipeline публикует собственные transitions, поэтому у одного run может быть несколько audit-комментариев в одном Issue. Перед publish/PR pending должен быть ноль. `git-worktree-cli publish` самостоятельно выполняет stage/commit/non-force push и проверяет remote SHA; owner не должен вручную выполнять `git add`/`commit`/`push` во время RUN. После успешного run PR содержит `Closes #N`, а `pipeline-github-sync.mjs link-pr <run-id> <pr-number>` фиксирует точный PR в Issue/state. Merge в main выполняет владелец.

## Команды

- `/pipeline-plan`
- `/pipeline-run <run-id> [--unattended] [--fix-cycles <5..20>] [--no-session-reuse]`
- `/pipeline-status <run-id>`
- `/pipeline-refresh` при релевантном main drift

Общая `/pipeline` не используется.


## Уточнения и граница заморозки

До первого фактического старта стадии `agent`, меняющей исходники, PLAN редактируется
в той же папке через `/pipeline-plan --revise RUN`. Пересматриваются только затронутые
решения и проверки; техническая правка сохраняет approval, изменение согласованного
поведения/объёма/ограничений требует нового approval.
После старта совместимые уточнения владельца допускаются в любой момент через
append-only amendment, в том числе с новыми hash-bound runtime work units.
Количество work items не определяет необходимость replan. При несовместимом изменении
после старта CLI `inherit-replan` создаёт новую папку и переносит только исторический
контекст в `planning/inherited/`; старый RUN сохраняется.
RUN и REFRESH используют единый `pipeline-reconcile-cli`: hash mismatch — сигнал
для анализа diff против PLAN, а не автоматический replan. Только COMPATIBLE / PLAN_INVALID.
`state=in_progress` без реального старта не означает активное выполнение.
