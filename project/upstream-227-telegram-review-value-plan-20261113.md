# План: OpenCode 2.2.7 + OpenChamber 2.7.1 + Telegram extension + защита от переусложнения

Дата: 2026-11-13. Статус: **PLAN ONLY — без реализации, тестовых запусков, PR, merge и развёртывания**.
Уточнения, утверждённые владельцем 2026-11-13: RUN class-review на третье обнаружение, без senior-review при сохранении подхода; PLAN — оценка необходимости самописного механизма и вопрос владельцу при отрицательном заключении.
План размещён в отдельной ветке my-opencode; дальнейшие кодовые ветки в каждом целевом репозитории открывать только после утверждения.

## Решения владельца и ограничения

- Целевая пара: **OpenCode CLI / plugin / client / schema / protocol 2.2.7** и **OpenChamber 2.7.1**. Факт: upstream OpenChamber tag v2.7.1 уже pin-ит @opencode/client и @opencode/schema 2.2.7; в v2.7.0 был 2.2.6.
- Вывести Telegram-уведомления из встроенной модификации OpenChamber в самостоятельное OpenChamber SDK extension при сохранении поведения и обратимости. До подтверждённой эквивалентности ничего не удалять.
- Финальное тестирование **OpenChamber — GitHub Actions** (существующий PR workflow и необходимые интеграционные job); OpenCode/my-opencode — **самостоятельно в доступном изолированном локальном окружении**, без GitHub Actions для финальной проверки. Ни локальный, ни продовый SSH не использовать без нового разрешения. Невыполненную проверку не считать PASS.
- Не менять производственные сервисы, секреты, пользовательские модели и runtime-состояние. Сохранить #18 (выбор моделей/вариантов), SHA-bound installer/rollback, pipeline owner approvals и ограничения на права.
- Минимизировать повторные CI прогонки: подготовить полный набор локальных проверок до финального GitHub Actions, запустить финальный PR CI один раз на принятом candidate SHA; не запускать release/publish workflow до отдельного решения.

## Проверенный AS IS (источники внизу)

1. my-opencode/main: OpenCode 2.2.5; openchamber-ru/main: OpenChamber 2.6.1 / OpenCode client/schema 2.2.5.
2. **AS IS, изменить:** повтор defect_class в двух последовательных негативных authoritative review/gate результатах сейчас блокирует следующий fix-cycle. CLI сравнивает классы; произвольные root_cause_id не обходят остановку. Сегодня ExternalScout → ArchitectureAnalyzer → SeniorTechnicalPlanReviewer обязательны даже при решении сохранить подход.
3. Независимый architecture_review_due: после 5 оплаченных циклов относительно последнего применимого покрывающего ревью; legacy без подтверждённых зависимостей — 5/10/15. Если проверенная dependency_file изменилась, следующий fix cycle блокируется раньше. Проверка охватывает covered_paths и точные SHA зависимостей; область чтения может быть шире области записи.
4. ArchitectureAnalyzer — read-only для исходников, bash deny, task deny, запись только .tmp/pipelines/**; разрешены адресные внешние исследования (webfetch, gh_grep, context7, exa). Изменения требований, внешних контрактов, trust/security или destructive решения — через владельца/replan.
5. CodeReviewer — свежий независимый read-only reviewer; bash/task запрещены, .tmp/pipelines/** для evidence; внешние источники допустимы. По текущим правилам блокирует проверенный product/contract/security defect. Test-coverage note по умолчанию optional/nonblocking; блокирует только когда недоказанное поведение реально скрыто пробелом. FindingsReviewer проверяет ранее найденное, потом требуется свежий CodeReviewer.
6. **AS IS / пробел:** PLAN уже имеет ExternalScout own-mechanism research, поиск альтернатив, reuse/drift и senior missing_prior_art. Требуется иной критерий: не создавать нестандартные собственные механизмы без доказанной необходимости, оценивать их сложность и влияние на исправления/скорость релизов и до реализации спрашивать владельца, если архитектор рекомендует отказаться/упростить. Не денежная окупаемость каждого фикса.

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

## Блок C — трёхкратный повтор класса и предотвращение переусложнения

### C1. RUN: три обнаружения, а не два

1. CLASS_REVIEW_REQUIRED срабатывает после **трёх самостоятельных отрицательных authoritative review/gate результатов одного defect_class в рамках исправляемого блока**, перед следующим оплачиваемым исправлением. Первое обнаружение → первое исправление; второе → второе исправление без архитектора; третье → обязательный разбор. Повторная подача того же evidence SHA, retry команды, advisory, transport/environment failure не являются новыми обнаружениями. Промежуточные ошибки других классов не сбрасывают счётчик конкретного класса. Нельзя обходить правило заменой class key/root_cause_id.
2. В stage-cli-core.ts адаптировать детерминированный учёт класса и epochs после настоящего class-review, не ограничиваться промптом. Сохранить 5-цикловый architecture checkpoint, ранний drift зависимостей, общий бюджет (5 по умолчанию, максимум 20), защиту от повторного использования того же артефакта и покрытие ревью только затронутых paths.
3. В class-review после ExternalScout и ArchitectureAnalyzer **при confirm_approach НЕ вызывать SeniorTechnicalPlanReviewer**. Архитектор обязан предоставить собственное проверяемое evidence, фактическую диагностику и конкретный план исправления; stage-cli принимает его без технического ревьювера только когда подход не меняется, флаги границ false и условия подтверждены. Для обычного 5-циклового architecture checkpoint результат no_change также не требует отдельного SeniorTechnicalPlanReviewer.
4. Для remove_mechanism / rework_block свежий SeniorTechnicalPlanReviewer сохраняется: это реально новое решение. requirements_change / security / trust / external-contract / destructive остаются блокером до решения владельца по действующим правилам; не выдавать сохранение подхода за изменённую архитектуру.
5. Обновить согласованно stage-cli-core.ts, pipeline-run.md, architecture-analyzer.md, senior-technical-plan-reviewer.md и тесты. Regression matrix: A/A = два последовательных исправления допускаются; A/A/A = class review; A/B/A = три A также приводят к review; повтор SHA не засчитывается; confirm_approach без senior PASS при валидной диагностике; rework/remove без senior FAIL; независимый 5-cycle/dependency-drift guard продолжает работать.
6. **PLAN review — отдельная машина:** plan-review.ts после двух отрицательных вердиктов с повтором класса требует исследования и переработки ПЛАНА, а не архитектурного RUN review. Этот ранний PLAN research trigger пока сохраняем.

### C2. PLAN: отказываться от необоснованно самописной архитектуры до реализации

1. Цель — избежать самостоятельных механизмов и сложных процессных ограждений, которые делают конвейер существенно тяжелее и замедляют исправления и релизы. Не рассчитывать денежную окупаемость каждого теста, фикса или класса ошибок.
2. Использовать **существующий** ExternalScout own-mechanism research: как задача решена upstream, официальными SDK и библиотеками, несколькими применимыми зрелыми реализациями; что из этого работает на нужных версиях; действительно ли механизм требуется по утверждённым AC. Фиксировать источники, версии, ограничения и отрицательные результаты поиска; отсутствие обнаруженных аналогов не трактовать как доказательство их отсутствия.
3. ArchitectureAnalyzer сравнивает: не делать / переиспользовать / библиотека или штатная возможность / тонкий адаптер / собственный механизм. При выборе собственного механизма нужна конкретная причина отказа от более простых путей. Указать дополнительные состояния, контракты, повторяющиеся проверки, сценарии отказа, затраты на сопровождение, нагрузку на тесты, длительность RUN и риск снижения скорости выпуска релизов.
4. Если архитектор делает вывод **самописное решение неоправданно**, PLAN до начала реализации должен показать владельцу имеющиеся доказательства, практику более простого решения, последствия усложнения и рекомендацию. Поставить конкретный вопрос: сохранить нестандартный подход или упростить/отказаться? Не менять утверждённое поведение автоматически. Если вывод неопределённый и решение существенно, запросить недостающие факты или решение владельца, не изображая доказанный PASS.
5. При существенном отклонении от распространённого подхода фиксировать заключение justified / unjustified / uncertain, основание и решение владельца в существующих technology-evidence, architecture и decision-register. Принятие владельцем нестандартного решения не позволяет игнорировать безопасность или выдумывать гарантии.
6. **Не добавлять новые обязательные гейты или агентов.** Проверка встроена в существующие ExternalScout, ArchitectureAnalyzer и затрагивающие дизайн SeniorTechnicalPlanReviewer; глубокий поиск только при реальном нетривиальном выборе. Тест-кейсы: необоснованный механизм при наличии стандартного → вопрос владельцу; распространённое простое решение → без лишней остановки. Эффект на RUN/wall-clock/release throughput оценивать позже по наблюдениям.

## Блок D — CodeReviewer: отделять доказанный дефект от улучшения по желанию

1. Сохранить блокирующие категории: доказанное нарушение AC/контракта/security/поведения, либо отсутствие проверки, которое действительно скрывает поведение реального production ingress. У каждого blocker конкретное path:line и evidence нарушения, а не предпочтение ревьюера.
2. Необязательные новые тесты, оптимизация или рефакторинг — optional: кратко указать какой конкретный сбой могут предотвращать, чем не покрыты уже существующим тестом/gate и не добавят ли ненужную стоимость тестового времени/поддержки. Не создавать обязательный ROI-расчёт и не требовать дополнительные тесты ради полноты матрицы.
3. Новая функциональность не вытекает из утверждённых AC и доказанного дефекта → не включать в текущий технический fix и не расходовать цикл; при изменении продукта это предложение владельцу. Упоминание в Issue не заменяет содержательную трассировку к утверждённому требованию.
4. FindingsReviewer сохраняет узкую область повторной проверки; свежий CodeReviewer остаётся финальной проверкой. Новых модельных проходов или гейтов не добавлять.
5. Доказать регрессионными тестами optional/nonblocking и blocking-real-defect; затем по фактическим RUN оценить влияние на ошибочные замечания, циклы и время без преждевременных обещаний.

## Тестирование и выпуск — только после отдельного разрешения на реализацию

**OpenCode/my-opencode — самостоятельно, локально:** Node 24 / Bun 1.4.4 / tsx, installer + pin contracts, stage-cli budget/class-review/architecture-review/CodeReviewer regressions, permissions/capability-preflight, native CLI 2.2.7 + plugin readiness, full pipeline tests, isolated install/rollback. Никаких GitHub Actions для финальной проверки OpenCode. Без доступа к локальному checkout/runtime — явный blocker, а не фиктивный PASS.

**OpenChamber — через GitHub Actions:** локальные быстрые проверки до PR; в финальном PR использовать текущий .github/workflows/oc-review.yml (type-check, lint, tests, build) плюс необходимые Telegram extension/native runtime интеграционные тесты в этом workflow, если отсутствуют. Текущий telegram-notifications.yml запускается только на старой ветке и hardcode-ит smoke CLI 2.0.32, поэтому не служит достаточной финальной проверкой. Выполнение связывать с точным PR head SHA; failure исправлять и получать новый PASS. Пакетный v2-linux-web-package.yml publishes release на main/workflow_dispatch — отдельно, после принятия; не смешивать с PR тестом.

**Результат для приёмки:** фактические протоколы тестов обеих репозиториев; diff по сохраняемым/удаляемым fork changes; proof seamless model/credential preservation; Telegram equivalence matrix + rollback; RUN three-occurrence defect class, confirm_approach without senior, PLAN unnecessary-custom-mechanism owner checkpoint и CodeReviewer optional/blocking regressions; итоговый handoff. Отдельное разрешение перед merge и любой серверной установкой.

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
