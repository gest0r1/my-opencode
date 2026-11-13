# План: OpenCode 2.2.7 + OpenChamber 2.7.1 + Telegram extension + value-aware reviews

Дата: 2026-11-13. Статус: **PLAN ONLY — без реализации, тестовых запусков, PR, merge и развёртывания**.
План размещён в отдельной ветке my-opencode; дальнейшие кодовые ветки в каждом целевом репозитории открывать только после утверждения.

## Решения владельца и ограничения

- Целевая пара: **OpenCode CLI / plugin / client / schema / protocol 2.2.7** и **OpenChamber 2.7.1**. Факт: upstream OpenChamber tag v2.7.1 уже pin-ит @opencode/client и @opencode/schema 2.2.7; в v2.7.0 был 2.2.6.
- Вывести Telegram-уведомления из встроенной модификации OpenChamber в самостоятельное OpenChamber SDK extension при сохранении поведения и обратимости. До подтверждённой эквивалентности ничего не удалять.
- Финальное тестирование **OpenChamber — GitHub Actions** (существующий PR workflow и необходимые интеграционные job); OpenCode/my-opencode — **самостоятельно в доступном изолированном локальном окружении**, без GitHub Actions для финальной проверки. Ни локальный, ни продовый SSH не использовать без нового разрешения. Невыполненную проверку не считать PASS.
- Не менять производственные сервисы, секреты, пользовательские модели и runtime-состояние. Сохранить #18 (выбор моделей/вариантов), SHA-bound installer/rollback, pipeline owner approvals и ограничения на права.
- Минимизировать повторные CI прогонки: подготовить полный набор локальных проверок до финального GitHub Actions, запустить финальный PR CI один раз на принятом candidate SHA; не запускать release/publish workflow до отдельного решения.

## Проверенный AS IS (источники внизу)

1. my-opencode/main: OpenCode 2.2.5; openchamber-ru/main: OpenChamber 2.6.1 / OpenCode client/schema 2.2.5.
2. Повтор одного defect_class в двух последовательных негативных authoritative review/gate результатах: после первого оплаченного fix cycle и до следующего оплаченного запуска срабатывает CLASS_REVIEW_REQUIRED. CLI сравнивает class keys; произвольно объявленные root_cause_id не обходят остановку. После этого ExternalScout → ArchitectureAnalyzer → SeniorTechnicalPlanReviewer, один подтверждённый консолидированный rework или confirm_approach с новой диагностикой.
3. Независимый architecture_review_due: после 5 оплаченных циклов относительно последнего применимого покрывающего ревью; legacy без подтверждённых зависимостей — 5/10/15. Если проверенная dependency_file изменилась, следующий fix cycle блокируется раньше. Проверка охватывает covered_paths и точные SHA зависимостей; область чтения может быть шире области записи.
4. ArchitectureAnalyzer — read-only для исходников, bash deny, task deny, запись только .tmp/pipelines/**; разрешены адресные внешние исследования (webfetch, gh_grep, context7, exa). Изменения требований, внешних контрактов, trust/security или destructive решения — через владельца/replan.
5. CodeReviewer — свежий независимый read-only reviewer; bash/task запрещены, .tmp/pipelines/** для evidence; внешние источники допустимы. По текущим правилам блокирует проверенный product/contract/security defect. Test-coverage note по умолчанию optional/nonblocking; блокирует только когда недоказанное поведение реально скрыто пробелом. FindingsReviewer проверяет ранее найденное, потом требуется свежий CodeReviewer.
6. Недостаток: нет обязательного доказательного **value-vs-cost** критерия для вновь предлагаемых механизмов, функциональности и необязательных тестов. PLAN защищает бизнес-решения и scope, reviewer запрещает speculative scope; однако рекомендация всё ещё может быть сформулирована как «лучше/полнее» без оценки прироста и затрат.

## Блок A — переход OpenCode/OpenChamber

1. Снять точные SHA upstream v2.7.1 / v2.2.7 и актуальных двух fork/main; проверить совместимость через официальный OpenChamber skill opencode-v2; сравнить API events, plugin hooks, permissions, background subagent result/metadata, session.wait, native plugin discovery, OAuth/MCP и initialization timing. Изменения OpenCode 2.3.x **исключить**.
2. В отдельной реализации upstream merge OpenChamber v2.7.1 с сохранением Telegram/Markdown-export/per-tool timings, PR-watch/merge-follow, x64 manifest, release fingerprint и русского UI. До миграции Telegram не удалять.
3. Согласованно pin-ить 2.2.7 во всех OpenCode installer/config/package/lock, OpenChamber client/schema/Electron/Docker/scripts/lock, проверять cross-repo pins. Оставить пользовательский выбор моделей/variants/credentials из #18.
4. Особый регресс v2.2.7: agent.list и несколько plugin endpoints возвращаются до завершения загрузки plugin; обновить preflight/wait по фактическим *.updated events/готовности, не объявлять отсутствующий GateRunner или других агентов без подтверждённого финального состояния.
5. Проверить работу текущего subagent foreground/background, lease, wake/recovery, GateRunner, gate result SHA, owner amendments/reviews, PLAN/RUN, install/rollback, Markdown export. Ошибка permissions GateRunner диагностируется отдельно; версия сама по себе её не исправляет.
6. План отката: неизменяемые generation и pinned SHA прежней совместимой пары; не модифицировать живые сессии без контролируемого тестового окна. Проверить сохранность конфигурации и SQLite/auth после обновления.

## Блок B — перенос Telegram в отдельное расширение

1. Инвентаризировать точные фичи текущего форка: opt-in на корневую сессию, once/run/session, chat UI/settings, alias/thread, готовность дочерних сессий до восьми уровней, waiting forms/permissions, returnResult и detached shells, finish/error/question/approval, проверка после restart/reconnect, manual retry, rate limits, одноразовое подтверждение agent send, explicit Markdown/text, приватные credential/token, дедупликация и unknown delivery.
2. Проверить точные контракты SDK 2.7.1: service.provides notifications, sessionEvents, service.keepRunning, sessionControl с approval и answers, action/buttons, settings/integration, read-only OpenCode service access; зафиксировать разницу между upstream событием turn-finished и нашей строгой «корневая сессия действительно завершена».
3. Спроектировать самостоятельный extension service и UI, без импорта внутренних private runtime OpenChamber; secrets — в защищённом extension storage; исходные разрешения строго минимальные. Решить размещение репозитория и совместимость SDK до начала реализации.
4. Миграция состояния: versioned schema, import текущих alias/subscriptions/checkpoints/delivery ledger (без утечки токенов, без двойной доставки), идемпотентность, безопасное прекращение при несовместимости. Продумать откат на прежний runtime без потери подписок.
5. Сначала параллельный **dry-run/shadow** без отправок в Telegram: события, получатели, тип, dedup key, completion decision; сравнить с текущим watcher на реальном OpenCode, отдельно протестировать reconnect, 429, 5xx, ambiguous timeout, crash/restart, cross-project/worktree, shell, forms, unanswered permissions. Не допускать два активных sender.
6. После PASS выполнить controlled cutover, отключить встроенную доставку, сохранить rollback, затем отдельным PR удалить только подтверждённо избыточную Telegram fork-модификацию и legacy workflow, не затронув нативные notifications. Полный Markdown-export/per-tool timings не удалять.
7. Acceptance: все реально используемые сценарии работают эквивалентно; не появилось дубликатов/потерянных уведомлений; секреты и выбор подписок сохранены; extension функционирует без Windows клиента и после restart; удаление встроенных изменений не ломает web UI.

## Блок C — оценка пользы архитектурных изменений

1. Сохранить существующие триггеры: повтор класса после двух последовательных негативных результатов; 5 циклов/проверенный drift. **Не добавлять новые ревью/модельные вызовы/тестовые гейты на успешном пути.**
2. Дополнить ArchitectureAnalyzer + SeniorTechnicalPlanReviewer + RUN/PLAN правила форматом «обоснование ценности» для любого *нового* механизма, дополнительной функциональности, расширения тестов и рефакторинга: исходная наблюдаемая проблема и evidence → обязательство frozen AC/контракта (если есть) → альтернативы «ничего не менять / исправить минимально / reuse / удалить механизм / расширить» → ожидаемая ценность или предотвращаемый риск → стоимость реализации, тестов, сопровождения и влияние на время RUN.
3. Если доработка **уже входит в утверждённую бизнес-цель**, не ставить под сомнение само решение владельца и не заводить обязательное повторное согласование; оценивать лишь техническую необходимость, минимальность и подтверждение поведения.
4. Если новая функциональность **не вытекает из утверждённой AC, доказанной ошибки, безопасности или проверяемого инварианта**, не включать её в технический fix. Классифицировать как optional предложение; при изменении поведения/сметы/границ — решение владельца.
5. Для class/architecture review хранить компактное value/alternative rationale в существующем evidence, по возможности без новых обязательных CLI полей; при необходимости — узкая контрактная проверка доказательств, без отдельного gate.
6. Архитектор может изучать связанные модули, callers и contract files **только read-only** при доказанной связи с ошибкой/предлагаемым решением; запись в новые исходники не разрешается самим ревью. Scope расширяется отдельным stage-cli scope/owner checkpoint.

## Блок D — value-aware CodeReviewer / FindingsReviewer

1. Для каждого finding различать (а) доказанный product/security/contract дефект, (б) test-coverage gap, который скрывает поведение, (в) полезный необязательный regression test, (г) speculative feature/refactor/style. Нужны конкретные path:line, нарушенный AC/контракт или machine evidence и последствия НЕисправления. Ссылки на понравившуюся реализацию/слова ревьюера не достаточно.
2. В каждом предложении о новых тестах: какой сбой обнаружит тест, не покрывает ли его существующий test/gate, вероятность/критичность ущерба, задержка CI/RUN и стоимость поддержки. Если прирост покрытия не доказан — optional, не блокирует и не расходует fix-cycle; дополнительные тесты не должны просто закреплять случайную реализацию.
3. Для предложения новой функциональности и расширенного рефакторинга: предъявить прямую трассировку к frozen AC/безопасности/доказанной регрессии; иначе вне текущего RUN и только владельцу как предложение. Не превращать предложение в скрытое изменение требований.
4. Сохранить обязательные проверки безопасности, реального ingress-path, нарушенных контрактов, regression; не ослаблять блокировку доказанных дефектов. CodeReviewer не редактирует исходники, FindingsReviewer остаётся узким, закрывает только прежние finding и новые ошибки в патче.
5. Без новых агентов и дополнительного полного прохода: value check встроить в существующий prompt/review evidence; регрессии должны проверить, что необязательное предложение не даёт charged fix-cycle, а доказанный дефект продолжает блокировать.
6. Нужен сравнительный журнал на нескольких реальных RUN: доля optional findings, количество cycles, wall-clock/tokens, количество подтверждённых defects и false positives до/после; улучшение не заявлять без измерений.

## Тестирование и выпуск — только после отдельного разрешения на реализацию

**OpenCode/my-opencode — самостоятельно, локально:** Node 24 / Bun 1.4.4 / tsx, installer + pin contracts, stage-cli budget/class-review/architecture-review/CodeReviewer regressions, permissions/capability-preflight, native CLI 2.2.7 + plugin readiness, full pipeline tests, isolated install/rollback. Никаких GitHub Actions для финальной проверки OpenCode. Без доступа к локальному checkout/runtime — явный blocker, а не фиктивный PASS.

**OpenChamber — через GitHub Actions:** локальные быстрые проверки до PR; в финальном PR использовать текущий .github/workflows/oc-review.yml (type-check, lint, tests, build) плюс необходимые Telegram extension/native runtime интеграционные тесты в этом workflow, если отсутствуют. Текущий telegram-notifications.yml запускается только на старой ветке и hardcode-ит smoke CLI 2.0.32, поэтому не служит достаточной финальной проверкой. Выполнение связывать с точным PR head SHA; failure исправлять и получать новый PASS. Пакетный v2-linux-web-package.yml publishes release на main/workflow_dispatch — отдельно, после принятия; не смешивать с PR тестом.

**Результат для приёмки:** фактические протоколы тестов обеих репозиториев; diff по сохраняемым/удаляемым fork changes; proof seamless model/credential preservation; Telegram equivalence matrix + rollback; review value-check regressions; итоговый handoff. Отдельное разрешение перед merge и любой серверной установкой.

## Ссылки на проверенные источники

- https://github.com/openchamber/openchamber/blob/v2.7.1/packages/web/package.json
- https://github.com/openchamber/openchamber/blob/main/changelog/2.7.1.md
- https://github.com/anomalyco/opencode/blob/v2.2.7/CHANGELOG.md
- https://github.com/gest0r1/my-opencode/blob/main/config/opencode/skills/task-management/scripts/stage-cli-core.ts
- https://github.com/gest0r1/my-opencode/blob/main/config/opencode/command/pipeline-run.md
- https://github.com/gest0r1/my-opencode/blob/main/config/opencode/agent/subagents/planning/architecture-analyzer.md
- https://github.com/gest0r1/my-opencode/blob/main/config/opencode/agent/subagents/code/reviewer.md
- https://github.com/gest0r1/openchamber-ru/blob/main/packages/web/server/lib/notifications/DOCUMENTATION.md
- https://github.com/gest0r1/openchamber-ru/blob/main/.github/workflows/oc-review.yml
- https://github.com/gest0r1/openchamber-ru/blob/main/.github/workflows/telegram-notifications.yml
