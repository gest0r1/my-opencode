# Pipeline: краткий навигатор (PLAN → RUN → PR)

> **Нормативный источник, а не этот обзор:** [`command/pipeline-plan.md`](command/pipeline-plan.md)
> и [`command/pipeline-run.md`](command/pipeline-run.md).
> Детерминированные ограничения, formats и проверки реализованы в
> [`skills/task-management/scripts/`](skills/task-management/scripts/).
> При противоречии обзора команде или валидатору использовать действующий контракт,
> исправить обзор отдельно. Не копировать здесь подробную спецификацию.

## Workflow владельца

```text
/pipeline-plan #12 #34
/pipeline-plan "7"                 # веха по номеру или названию в кавычках
/pipeline-plan --milestone 7
# после явного утверждения предложенного manifest/run-id:
/pipeline-run <run-id> [--unattended] [--fix-cycles 5..20]
```

Владелец сам выбирает worktree/сессию, даёт **отдельное явное разрешение**
на freeze/старт и самостоятельно решает merge. Команды не создают и
не переключают его worktree. `--unattended` не выдаёт разрешений на
новые требования, security/destructive scope или merge.

## PLAN

Источник GitHub Issue — `#N`, веха или явный текст/файл; GitHub Issue
и человеческие комментарии с требованиями — исходные требования.
`ContextScout` адресно читает применимые правила, реализацию и тесты
(не весь репозиторий); при архитектурном триггере дополняет тот же
`planning/context-packet.md` картой reuse/owners/удалённых потребителей.

Для **изменяющегося пользовательского поведения**:
1. `StoryMapper` — `Как сейчас | Как будет | Как проверить`; полный
   `SeniorStoryReviewer` сверяет исходные требования. Владелец утверждает
   точную версию baseline Story/SHA **до** архитектуры.
2. При архитектурном триггере `ArchitectureAnalyzer` совместно оценивает
   затронутые Issue, существующие owners и reuse. Новое поведение,
   не предусмотренное source Issue, требует решения владельца о scope.
3. Изменение утверждённого поведения оформляется версионированной
   дельтой `StoryMapper`, утверждается владельцем; независимый
   **`SeniorTechnicalPlanReviewer` обязателен при такой дельте**.
   Второй `SeniorStoryReviewer` на дельту не запускается.
4. `ContractManager`, внешний research и обычное техническое review
   запускаются только по существующим триггерам.

Для **технической Issue без изменений поведения** не создавать
искусственных Stories и первого owner checkpoint; итоговое утверждение
PLAN сохраняется. `TaskManager` показывает WI, независимые линии,
DAG/зависимости и критический путь до финального согласования.

### Проверяемые согласования владельца

Новый GitHub Issue PLAN использует строго структурированный **комментарий,
написанный самим владельцем**, с `run_id`, `issue_number`, точным
`artifact_path`, SHA-256 и решением `approve/reject`. Форма:
[раздел Owner Story approvals](command/pipeline-plan.md#owner-story-approvals-github-issue-mode).

`planning/owner-approvals.json` — только индекс, **не доказательство**
согласия. Действующий `stage-cli plan-check/plan-start` и прямые
`init/approve` сверяют живые комментарии GitHub, права автора, SHA
и full-review/technical-review evidence. Проверенный чистый
комментарий-согласование не меняет `source_requirements_sha256`, обычные
комментарии с новыми требованиями — меняют и требуют reconcile.
Непроверенное согласие блокирует freeze. Для не-GitHub source mode
нужен отдельный подтверждённый read-back пользовательского сообщения;
не подменять его выводом агента.

## RUN и доставка

**Новых исполнителей/stages/scheduler нет.** Текущий `pipeline-run.md`
определяет work-item dispatch, scope/secret guards, fix budget,
root-cause review, main freshness, bounded owner amendments/replans
и доказательства прохождения tests/gates.

Для новых deployable PLAN целевой путь:

```text
source lanes: implementation + affected tests + independent review
    → git_verify → local fail-fast → git_publish exact candidate SHA
    → candidate local_gate (по опубликованному SHA)
    → dev_deploy → owner_acceptance → PR
```

Новые PLAN используют `github_ci_mode: "off"`: обязательного финального
GitHub Actions CI **нет**. `github_ci`/`github_dev` и GitHub-driven CD
остаются **legacy-контрактами** ранее замороженных запусков, их
не переносить в новые PLAN. Source-only RUN не получает
`dev_deploy`/`owner_acceptance`. Технические тесты не заменяют
обязательные сценарные проверки поведения; вся приёмка по
реальному prod-entry на доступном тестовом контуре, где применимо.

Обновление нормативной документации целевого проекта:
`CoderAgent` обновляет затронутый документ **в своём WI** в пределах
замороженного `allowed_change_paths`; `DocWriter` — для самостоятельной
docs-only задачи. Документационный стандарт определяется **проектом**,
конвейер не навязывает всем FACT-only.

## Диагностика и ограничения

- Переход gate допускается только по `ready` и проверяемым path/SHA;
  full review на freeze, bounded fix/repair, без модели «PASS по словам агента».
- Scope, destructive/security stop, Git и secrets — правила текущих
  [PLAN](command/pipeline-plan.md) / [RUN](command/pipeline-run.md).
- GitHub audit и PR handoff имеют идемпотентные события, исходные
  требования проверяются заново; PR создаётся без автоматического merge.
- Токены/время и качество сравнивать на сопоставимых задачах по
  фактическим логам. Не заявлять экономию на основании предположений.
- Детали runtime-scope, replan, тестовых профилей, machine evidence,
  release packaging, permissions и legacy GitHub workflows **не
  дублировать здесь**: читать нормативную команду затронутого этапа.
