# Итоговая приёмка pipeline optimization — 2026-11-08

**Завершено в границе серверного обновления и передачи владельцу на рабочий тест. Серверную накатку точной пары SHA ниже подтверждаю.** Это не выпуск Windows-дистрибутива и не заявление об уже выполненном обновлении production.

Реализацию исправлений текущего запуска выполняла Luna; root провёл ревью, независимые проверки, сборку, установку пакета и проверку настоящего движка. Main, рабочие сервисы, активные продуктовые RUN и production-данные не менялись. Платные Actions не запускались.

## Принятые исходники

| Компонент | Точная версия / SHA |
|---|---|
| my-opencode, проверенный код | `338c26993178f3d681eb3f1c86e17357c63233de` |
| openchamber-ru, проверенный итог | `b236258326deaf3541956b8a9cd9bb5aec68da5b` |
| Ветки | `feature/pipeline-optimization-20261104` в обоих репозиториях |
| Upstream OpenChamber | v2.6.1, `ce853f415704d1bfe8d076a5cfb2caabac00fffd`; включён настоящим merge с двумя родителями |
| OpenCode CLI / plugin / client / schema / protocol | 2.2.5 |
| Окружение приёмки | Node 24.22.1, Bun 1.4.4, tsx 4.23.15 |

После публикации исходники перечитаны из GitHub: все **8093** файла OpenChamber соответствуют локальным Git blob SHA. Все **456** файлов исходной принятой ветки my-opencode также совпали; дальнейший commit отчёта меняет только документацию и журналы.

## Что Luna завершила

1. В `packages/web/server/index.js` восстановлен существующий upstream lifecycle `prWatchRuntime` и `mergeFollowRuntime`: создание, запуск PR watcher, передача в tracked-items/control/routes и штатная остановка. Раньше пакет собирался, но настоящий запуск завершался с ReferenceError.
2. Стандартный Oxlint `no-undef` подключён к этому серверному entrypoint через действующий web lint. Разрешены Node globals и конкретные Node Web APIs; весь browser environment не включён. Отрицательный повтор на исходном сломанном файле воспроизводимо обнаруживает обе потерянные переменные.
3. Тест загрузки локали больше не считает 20 коротких timer ticks. Он ожидает наблюдаемое изменение store через подписку с ограниченным дедлайном и cleanup. Production store не менялся; проверки переводов не ослаблены.
4. Проверка настоящим OpenCode подтвердила native auto-discovery отдельных файлов из `config/opencode/plugins/`. `pipeline-runtime` и `github-handoff` стали `active`. Дополнительный package adapter не добавляли: первоначальная попытка явно прописать file URI была неверной конфигурацией тестового стенда, а не дефектом дистрибутива.

## Независимые результаты

| Проверка | Результат | Журнал |
|---|---|---|
| Все 50 отслеживаемых файлов pipeline tests | **450 сценариев: 448 PASS, 0 FAIL, 2 SKIP**, один полный прогон | [pipeline](reviews/20261108/pipeline.log), [команда и длительность](reviews/20261108/pipeline-result.json) |
| OpenChamber `check:changed` | **PASS**: типы 3914 файлов/7 проектов, Electron syntax, lint всех пакетов, dead code, anti-slop | [gate](reviews/20261108/check-final.log) |
| 10 затронутых серверных Vitest файлов | **195/195 PASS** | [server](reviews/20261108/server-tests.log) |
| 10 изолированных UI/export/projection/i18n файлов | **124/124 PASS**, итоговый повтор после исправления fixture | [UI](reviews/20261108/ui-final.log) |
| Release authorization/workflow/reuse | **10/10 PASS**, fork release policy PASS | [release](reviews/20261108/release-tests.log) |
| 9 installer/scope shell suites | PASS | [installer](reviews/20261108/installer-shell.log) |
| Python standard installer, runtime user, Node floor | PASS | [Python](reviews/20261108/installer-python.log) |
| Межрепозиторные pins | PASS: OpenCode 2.2.5 / OpenChamber 2.6.1 | [pins](reviews/20261108/pins.log) |
| SDK build и production web build/service worker | PASS, web build 2m44s | [SDK](reviews/20261108/sdk-build.log), [build summary](reviews/20261108/build-summary.log) |
| Собранный web package, изолированная установка | PASS; CLI 2.6.1, 2677 файлов, архив 19030023 байта | [package](reviews/20261108/package-summary.log) |
| Настоящий packaged server + managed OpenCode 2.2.5 | **HTTP 200**, health: `isOpenCodeReady=true`, `openCodeRunning=true`, `lastOpenCodeError=null`; штатное завершение | [runtime result](reviews/20261108/server-ready-result.json) |
| Нативная загрузка наших plugins движком | **active** для pipeline-runtime и github-handoff; запрос через серверный proxy | [plugin result](reviews/20261108/native-plugin-accepted.json) |

Два SKIP — настоящий Docker/PG (Docker отсутствует) и проверка PID-reuse через procfs (PID namespace этого стенда не совпадает с procfs). Обычная Linux-проверка сохранена. Живой Docker/PG, Windows packaging/signing, systemd activation и откат на настоящем рабочем сервере не объявлены проверенными. Полный web-набор не объявляется зелёным: предыдущая попытка зависла в неизменённом upstream gatekeeper. Согласно указанию владельца неизменённый upstream принимается за рабочую основу; затронутые серверные сценарии проверены отдельно.

LLM/provider-запросы в runtime smoke не отправлялись, пользовательские credentials не использовались. Каталог внешних моделей в изолированном стенде мог быть недоступен по DNS; это не мешало health, загрузке plugins и проверке локальных API.

## Соответствие исходному ТЗ

| Этап | Что принято |
|---|---|
| 0–1: исходные точки и аудит | Ветки/SHA, карта решений и проверяемые журналы сохранены |
| 2: ContextScout | Широкий planning/** scope, запрет machine artifacts, повторная установка и path checks проходят |
| 3: upstream/pins | Upstream 2.6.1 интегрирован; pins/lock OpenCode 2.2.5 согласованы |
| 4: tool timing | Сохранены происхождение времени, unknown/zero, running/interrupted, child sessions и next-call gaps; native Bun tests проходят |
| 5: approvals / PLAN | Предмет/hash согласования, отдельное явное намерение RUN, probe/preflight и carried findings проверены |
| 6: prep/DAG/gates | Именованные потребители prep, порядок/циклы зависимостей, tree/candidate/build-output/service identity проверены |
| 7: selection/reuse/live lifecycle | Нет устаревшего PASS после изменения ignored input или toolchain; focus не заменяет final; preflight/locks/cleanup проходят |
| 8: wake/recovery | Event/restart/unknown lease сценарии проходят; plugin реально активирован OpenCode 2.2.5 |
| 9: связность/дубли | Существующие runner/state/evidence owners сохранены; лишний adapter не добавлен, retired role/workflows не возвращены |
| 10: передача | Точная совместимая пара, сборка, установка пакета, настоящий startup, инструкции накатки и возврата |

## Проверенные оптимизации и предел измерений

В исполняемых regression fixtures первая проверка выполняет две команды, неизменённый повтор — ноль; после изменения входов выполняются обе. При частичном reuse выполняется одна команда и переиспользуется одна. Это доказательство выбора/reuse и сохранённого покрытия, **не процент ускорения продуктового RUN**.

Экономия времени/токенов на рабочих RUN пока не измерена. Четыре отслеживаемых prompt-файла выросли с 138746 до 144185 байт (+3,9%); уменьшение контекста или стоимости по этому признаку не заявляется. После накатки остаётся измерить реальный эффект и приемлемость трактовки задач владельцем.

В предыдущей работе также подтверждены: исправление планирования по milestone (`readdir`), bound candidate/build-output/service proof, согласованные approved model tests и удалённый StageOrchestrator, 554 RU перевода/placeholder fixes, удаление 77 неиспользуемых RU ключей и трёх unused imports. Новый запуск не подменял эти функции; они повторно прошли checks на опубликованных исходниках.

## Накатка

[ROLLOUT.md](ROLLOUT.md) содержит точные команды. Используется явный `source` mode: нового release bundle для этой feature нет. Сборка выполняется из неизменяемого принятого SHA, сохраняются текущие bind host/port и target для возврата. Пробный архив имеет SHA-256 `d8b1b0f8669866886fe360a49534c4f25f7cb71c6701301187e1b6d7e776c5eb`; это локальное test evidence, не опубликованный release manifest.

Код готов к серверной накатке и рабочему тесту владельца. Merge в main, релиз Windows и фактический deploy не выполнялись.
