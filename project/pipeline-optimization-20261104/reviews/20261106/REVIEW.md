# Ревью и изолированные проверки — 2026-11-06

**Вердикт: вернуть на исправления. К merge/release/установке не принято.** Upstream в этом запуске не интегрировался; implementation source не менялся. Проверялись точные remote inputs, а не синтетически извлечённые функции.

## Входы и окружение

- my-opencode: `feature/pipeline-optimization-20261104@891a5c53d0fd3325e208402cf48fee5cdddc8c55`, tree `8cac601ae59786ffd35cb5f85a93ab4861495be9`; 436/436 файлов сверены по Git blob SHA. Изолированный snapshot без Git ancestry.
- openchamber-ru: `feature/pipeline-optimization-20261104@06afd56dffe3e0fc0c2863d0017ae243b037cc1b`. После `f9e8831` изменён только указатель документации; source timing прежний.
- Node `24.22.1`; реальные native Node tests и CLI с настоящими imports. Доступный tsx `4.21.0` использовался через loader shim из-за ограничения Unix socket; source требует `4.23.15`. Runtime tests использовали доступный `@opencode/plugin 2.0.23`, source pin `2.1.4`. Это квалифицированная проверка, не locked-dependency/installed-SDK acceptance.
- Bun и Docker executable отсутствуют. Docker в runner tests — fixture process, не действительная PostgreSQL. Production и чужие checkout не менялись. Дополнительные диагностические файлы созданы только в изолированной тестовой копии; все исходные 436 remote-файлов после проверки сохранили hash.

## Результаты штатных прогонов

Не складывать первоначальные FAIL и точечные повторы в вымышленный clean full run.

| Набор | Результат | Duration Node reporter | Evidence |
|---|---|---:|---|
| build-output proof, gate policy, snapshot inputs, reuse identity, wake, PLAN identity | 30 PASS / 1 FAIL / 1 Docker SKIP | 3.749 s | `logs/pure-suites.log` |
| gate runner, pipeline runtime, manifest v2 | 104 PASS / 1 FAIL | 204.766 s | `logs/integration-suites.log` |
| snapshot, dev-deploy, reuse report, Scout path, owner amendments | 24 PASS / 1 FAIL | 14.966 s | `logs/extra-suites.log` |
| Отдельный повтор plan-check после подключения `.bin/tsx` loader entrypoint | 1 PASS | 1.459 s | `logs/plan-check-loader-retest.log` |
| Повтор snapshot failure без inherited NODE_PATH | 1 FAIL: local vitest binary отсутствует в fixture | 1.555 s | `logs/snapshot-fixture-clean-env.log` |
| Повторная временная установка ContextScout | PASS, tool wall 0.679 s | shell, не Node duration | `logs/scout-install.log` |
| Текущий distribution pin checker | PASS: OpenCode2.1.4/OpenChamber2.5.2 согласованы | не измерялось | `logs/pins-current.log` |

Изначально 162 штатных tests: 158 PASS, 3 FAIL, 1 SKIP. Plan-check FAIL оказался средовым: отсутствовал локальный `.bin/tsx`, отдельный повтор прошёл. Два оставшихся FAIL связаны с fixtures (F4/F5), но это не отменяет функциональные дефекты, найденные дополнительными тестами.

Дополнительные **негативные тесты**: 3 ожидаемо падают, воспроизводя F1–F3 на неизменённом source. Actual runner invoked через штатный CLI; сервисный helper импортирован из настоящего `dev-deploy-cli.ts`. Финальный журнал `logs/review-repros-final.log`. Копия reproducer сохранена как `review-repros.test.mjs.txt`: для повторения поместить рядом с исходным `gate-runner-cli.test.mjs` под именем `review-only-repros.test.mjs` и выполнить через реальный tsx loader. Helpers взяты из штатного runner test fixture; проверяется actual production runner, а не копия его функций.

## Findings, в порядке важности

### F1 — P1: false PASS reuse при изменении вложенного ignored input

`config/opencode/skills/task-management/scripts/gate-snapshot.mjs:71–82`: `git ls-files --others --ignored --directory` сворачивает ignored directory в `.local-config/`, после чего `.filter(!endsWith('/'))` его отбрасывает. В результате `reuseLocalInputs` не включает `.local-config/mode.txt`; ни source digest, ни environment identity не меняются. В in-place gate файл доступен выполняемой команде.

Воспроизведение: gate читает файл `good` и получает PASS; меняем только этот файл на `bad`. Второй запуск: **exit0, commands_run=0, commands_reused=2, PASS**. Контроль с `--no-reuse`: **exit1** — настоящая команда на новых данных падает. Это не гипотеза о скорости, а недостоверный PASS.

Исправлять общий read-set для snapshot/in-place/reuse, включая вложенные ignored local inputs и смену их состава; сохранить исключения generated/dependency/runtime trees, безопасную обработку symlink и конфиденциальность. Не сканировать бесконтрольно всё дисковое пространство, не создавать второй cache. Нужны позитивные unchanged и негативные nested/add/remove/rename regressions; snapshot должен либо передать предусмотренный input, либо явно отклонить/не переиспользовать его, а не тихо терять.

### F2 — P1: дешёвый lifecycle preflight отсутствует в RUN

`gate-runner-cli.ts`: `preflight_command` запускается в `planProbe` около 324, но обычный RUN путь `runPending` около 767 сразу выполняет frozen commands и создаёт resource на live batch. Проверка PLAN не заменяет RUN lifecycle check после возможного изменения состояния/окружения.

Воспроизведение: frozen preflight пишет marker и завершает exit41; gate содержит non-live команду перед live. Обычный RUN: **exit0; preflightCalled=false; expensiveCalled=true; dockerCalled=true**. Docker fake fixture; никакой настоящий DB не поднимался.

Добавить общий validate-only precheck при реальном held lock до дорогих команд/Docker/attempt allocation. Сохранить phase/state/manifest/candidate checks и отдельный PLAN namespace. Не дублировать validator/runner и не подделывать `in_progress`. Нужны RUN preflight FAIL→нулевые expensive/Docker вызовы и успешный RUN; PLAN regressions сохранить. Текущий PLAN fixture проверяет собственный маленький скрипт; совместимость с действительным project-owned consumer этим ещё не доказана.

### F3 — P1: наличие SHA где угодно в status JSON считается доказательством установленного SHA

`dev-deploy-cli.ts:69–70`: `JSON.stringify(status).toLowerCase().includes(candidateSha)`. Аналогичный слабый predicate уже есть в `record` около 117; новый service verifier повторил его.

Воспроизведение: install metadata указывает candidate A, но status JSON содержит `{current:{sha:B}, requested_sha:A}`. **verifyDeployedServiceGate возвращает PASS**. Это ложноположительный результат по заведомо неоднозначному status input; наличие реального production файла именно такого формата не утверждается.

Нужен единый проверяемый parser действительного контракта status producer с точным сравнением поля фактически работающего SHA, а не всего JSON/подстроки. Не выдумывать схему — сначала прочитать producer/существующие contracts. Использовать общий predicate для record и consumer, отклонять missing/unknown/ambiguous current identity. Добавить unrelated/requested SHA, wrong current SHA, malformed status и положительный actual-current case. Второе deployment state store не нужно.

### F4 — P2: gate policy regression fixture сохраняет старый gate после rename

`gate-testing-policy.test.mjs:110–120`: при `assemble`→`release-assemble` заменены stage/executor и добавлены новые profile/testing keys, но старые `gate_profiles.local.assemble` и `gate_testing.local.assemble` остаются. Validator закономерно выдаёт `GATE_INPUT_OWNER_INVALID: local/assemble must belong to a local_gate stage`.

Исправить fixture как полное переименование; сохранить строгую проверку orphan gate. Отдельно проверить реальное независимое от названия поведение producer/consumer. Не убирать валидатор ради теста.

### F5 — P2: snapshot impact-reuse fixture не соответствует новому toolchain contract

`gate-snapshot.test.mjs:128–145` ожидает reuse, но `snapshotFixture` не создаёт project local `.bin/vitest`/полный проверяемый manager contract. На начальном окружении reuse отключил inherited NODE_PATH; после удаления только этого test-environment injection причина стала точной: **`pnpm exec tool vitest has no project-root node_modules/.bin executable`**.

Обновить fixture полноценной bounded toolchain, добавить control no-reuse case для неизвестного маршрута. Не ослаблять production identity и не удалять реальные environment inputs в runner ради PASS.

### F6 — P2: дрейф самого отчёта и testing handoff

REPORT дополняется длинными историческими блоками с противоречивыми текущими таблицами: build-output одновременно реализован в начале и остаётся незавершённым ниже; исторический reuse patch описан как ещё не опубликованный; TESTING_HANDOFF указывает старый UI docs HEAD. Такой документ увеличивает контекст и повторную работу.

Свести REPORT к одному текущему snapshot; историю перенести/оставить в runs/Git. Раздельно source-ready/reviewed/tested/integration-ready. Исправить фактические источники и последствия найденных дефектов, не заявлять ни «всё готово», ни «всё блокировано отсутствием clone».

## Дополнительные границы

- Diagnostic TypeScript6.0.3, `--strict false`, NodeNext/skipLibCheck, entrypoints gate runner/stage CLI/runtime: exit2, 75 diagnostics в transitive graph (`logs/typescript6-diagnostic.log`). Это ad-hoc diagnostic check с доступным SDK2.0.23, **не официальный pinned build**; baseline comparison не выполнен. Не считать 75 новыми регрессиями и не исправлять всё broad casts/рефакторингом. Требуется повтор в целевом dependency set и выделение delta.
- Первая диагностическая попытка использовала `typescript` package7.0.2; она отдельно записана, не смешивается с TS6 output. Фактические версии проверены.
- OpenChamber source после прошлой ограниченной timing приёмки не изменился. Bun suites/check:changed/typecheck/build/actual UI не запускались; прежний actual exporter PASS — исторический результат, не нынешний full PASS.
- Installed SDK hooks/restart/compaction, настоящий disposable PostgreSQL, installation/rollback и реальные before/after time/token savings не проверены. Никаких процентов ускорения не заявлено.
- Releases API 06.11 подтвердил официальные stable targets: OpenChamber v2.6.1 и OpenCode v2.2.5. Process-daemon release — другой компонент. Upstream merge/pin bump **не выполнялся** по указанию владельца.

## Возврат на разработку

Младшей модели передаются F1–F6 и отдельный этап upstream/pins; implementation исправляет она. В конце — branch/immutable HEAD, поэтапный отчёт и очередь NOT RUN для ChatGPT. Main/release/deploy/paid Actions не разрешены. После нового source diff повторить relevant regressions и финальные проверки; текущие результаты не переносить автоматически на новый HEAD.

## Готовая постановка младшей модели

[Исправления F1–F6 и отдельный этап upstream](https://chatgpt.com/library?file_id=libfile_8f395b0c6888819190ae66ec79d3d505&account_id=personal). Проверяющий не выполнял исправления или upstream integration; опубликованы только документы/тестовые evidence.
