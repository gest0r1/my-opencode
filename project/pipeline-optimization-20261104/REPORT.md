# Pipeline optimization 20261104 — текущий REPORT

**Статус на 05.11.2026, 17:19 UTC: ЧАСТИЧНО; локальный gate-input identity обновлён, финальные Node/Bun и интеграция NOT RUN.** Работа возобновлена в feature-ветке my-opencode по handoff; общая независимая приёмка и тестирование на итоговом коде отсутствуют. В этой сессии `main`, релизы, установку и production не меняли. По прямому запрету владельца репозиторий `sevami` не открывали и не изменяли.

## Основная передача

[Handoff: что осталось, исходные точки, рабочий патч, этапы и очередь тестов](https://chatgpt.com/library?file_id=libfile_5e21320151888191ad0f3833a9dfae8f&account_id=personal).

Исходное ТЗ: [pipeline-improvement-prompt-20261104.md](https://chatgpt.com/library?file_id=libfile_5cb2f8787138819187518776c6d73d2b&account_id=personal). Аудит механизмов: [DECISIONS.md](DECISIONS.md); история — `runs/` и история Git. Старый срез REPORT на 04.11 21:50 UTC устарел; нижеследующее заменяет его текущие статусы.

## Исходные published SHA handoff (исторический checkpoint, не актуальный HEAD)

Во всех repo ветка `feature/pipeline-optimization-20261104`; текущий ref будет содержать и документационный commit.

| Repo | Base main при начале задачи | Source HEAD |
|---|---|---|
| my-opencode | `c58f452047df3806ea6e946d1909b075344bc069` | `8925bcbbf3228bf315ea11a891b5d192d358a5da` |
| openchamber-ru | `f9521f168c894cb17dc60ba4f929d4df0722e263` | `f9e8831586efc5b6ef975102bc3facef968561e3` |
| sevami | `6a4898b3aabed5a06a13f3071e870deb75ae139d` | `81743b27cec89f1528645b0112a2c154cf18a68b` |

## Статус этапов

| Блок | Сделано | Осталось |
|---|---|---|
| ContextScout | Planning subtree, path validator, multiple support files, reinstall regression | Installed/pinned runtime integration |
| Instructions/prep | Consumer-only `required_by`, legacy fallback; последний blanket reminder исправлен в `5454011...`; карта loader/callers в `runs/chatgpt-20261105-instruction-audit-01.md` | Полная проверка действительной runtime загрузки; upstream cleanup только при доказанной замене |
| Owner approval | `8925bcbb...`: exact manifest/run/subject/decision/response audit, fail-fast, technical carry и legacy continuation | Повтор на final integrated source; explicit separate RUN entry coverage |
| Gate inputs | tree/candidate source сохраняется; deployed-service proof подключён в существующий RUN runner с before/after target/candidate recheck | build-output producer/hash; actual installed target smoke tests; повторный TypeScript check |
| Live PLAN/RUN | **my-opencode source добавлен**: phase-aware runtime lock, cheap preflight до Docker и attempt, stateless PLAN/candidate=null, отдельная PLAN evidence; тот же validator при RUN base reuse | запуск Node/tsx и actual cross-repo consumer integration **запрещён для этой сессии**, исходники другого repo не открывались |
| Reuse | **Source опубликован**: 4-файловый patch, итоговые SHA256 совпали на переносе; исторический 39/39 не переносится на итоговый код | финальная независимая приёмка, Node/tsx, реальная стоимость hashing/ускорение |
| Wake/children | Independent lanes, unknown lease/reprobe, visible dedup notice | Pinned SDK missing/404 и compaction/restart; crash-window exactly-once не доказан |
| Markdown timing | Actual projection→export runtime принят ограниченно | Bun/full UI/sync-context/build checks после upstream |
| Upstream/pins | Common base/trees проверены, 98 merge-file inputs: 80 clean/18 conflicts, отдельно 6 delete/modify | Разрешить конфликты, настоящий merge в feature, OpenCode 2.2.5/OpenChamber 2.6.1 pins, frozen checks |
| Final integration | Отдельные commits проверены | Полные affected suites на final совместимых refs, isolated live, install/rollback и итоговое ревью |

## Проверки — разные inputs, не общий full PASS

| Input | Результат | Граница |
|---|---|---|
| Approval source `8925bcbb...` | Luna: 120/120 в шести targeted suites; root лично 9/9, 12.09 s; root 13/13 remote blob match | Node24.22.1/tsx4.21 loader; plugin2.0.23, не locked target set |
| Сохранённый reuse working patch | Локальный журнал 39/39, 77.015 s | Последняя версия после nested-tool correction не принята root и не source-commit; synthetic/fake Docker |
| SeVami `81743b27...` | Luna 16/16, 677 ms; targeted strict TS6.0.3 PASS без source stubs | Не cross-repo runner acceptance; config-inclusive TS не PASS |
| SeVami test-blocks | FAIL: Unresolved in-repository imports | Возможный baseline sourceGraph/baseUrl/paths defect ещё не доказан сравнением main |
| OpenChamber timing source `279a2b4...`, docs `f9e8831...` | Root actual projection+export runtime PASS | Не Bun suite/UI/build |
| Target frozen install/full build, installed binary/plugin, настоящий Docker/live | NOT RUN | Требуется целевое окружение; production не используется |

Повторить full suites только после итоговых изменений или новых failures; старые PASS не присваивать новому diff. У младшей модели проверки без окружения имеют статус NOT RUN, затем их выполняет ChatGPT.

## Сохранённая незавершённая работа

`handoff-assets/reuse-identity-working-20261105.patch` основан на source `8925bcbb...` и **опубликован в исходниках** этого продолжения; все четыре SHA256 перенесённых файлов совпали с `.files.json` на отдельных transfer commits. Последующие commits меняют runner и его тесты для PLAN и service: их новые hashes, естественно, отличаются от preservation checkpoint. Исторический 39/39 тест больше не удостоверяет итоговый код.

`handoff-assets/upstream-conflicts-20261105/manifest.jsonl` хранит точные metadata/blob SHA всех 98 text и 6 delete/modify inputs. Скрипт `merge-check.py` воспроизводит three-way check после materialization exact blobs в `input-blobs/`. Ручные resolutions и upstream merge не сохранены/не опубликованы. Target: OpenChamber `ce853f415704d1bfe8d076a5cfb2caabac00fffd`, merge-base `c4919abc1e7a0a3beeaa126666487806bf79cfe0`; OpenCode `9bbb8ce18c80f099e0e448775f59d965ead40a21`.

## Исправленные прежние blockers

- Owner consent является **workflow audit**, не independently authenticated transcript. IDs необязательны. Второй approval store или несуществующий readback не нужны. Технические revisions не требуют повторного согласования неизменившегося owner contract.
- Полные upstream/base/feature trees доступны, fork читает upstream objects: отсутствие local clone не абсолютный blocker настоящего GitData merge с двумя подлинными parents и lease ref. Локальный snapshot/synthetic index всё равно не является ancestry checkout.
- Actual timing exporter удалось запустить с настоящими imports; прежний missing-locale blocker относится к старой неполной попытке. Bun/full checks остаются NOT RUN.

## Среда и статистика остановок

Source snapshots не имеют подлинной Git ancestry. Старые чужие checkout не изменялись. Node24.22.1, cached tsx4.21/plugin2.0.23 отличались от source pins; loader shim использован из-за Unix-socket EPERM. SeVami финальные focused checks использовали Vitest4.1.10/TS6.0.3 с настоящими tracked imports. Один реконструированный index имел 1155 remote paths/1154 materialized blobs: не хватало архивного PNG, не test source.

Terra остановился по usage limit при диагностике baseline generator, до runner integration; длительность и session ID unavailable. Это статистика, не основание менять архитектуру/роли. Текущая команда на момент handoff не содержит активных дочерних агентов. Состояние чужих host процессов не утверждается.

## Следующее действие

Сверить feature HEAD после последнего runs report, выполнить локальные Node/tsx и TypeScript suites на source из feature (точные команды ниже), затем независимое ревью diff. Source-only PLAN контракт не утверждать как cross-repo integration; OpenChamber upstream/pins и build-output остаются отдельно. Пользователь запретил обращаться к `sevami` — не делать это даже ради интеграционного теста.

## Продолжение: 2026-11-05, source и статическая приёмка

**Рабочие ветки и точные точки входа**

| Repo | Base origin/main | Старт HEAD этого запуска | Последний известный source HEAD перед REPORT | URL | Working tree |
|---|---|---|---|---|---|
| my-opencode | `c58f452047df3806ea6e946d1909b075344bc069` | `85c8969a807f1cae3ee14f9bdd9fbcbd7644301e` | `e38c3c7cf0bbc7ebf4bc0393256e61176f09e895` (плюс следующие commits этого отчёта) | https://github.com/gest0r1/my-opencode/tree/feature/pipeline-optimization-20261104 | repo checkout отсутствует, изменения только GitHub API commits |
| openchamber-ru | `f9521f168c894cb17dc60ba4f929d4df0722e263` | `f9e8831586efc5b6ef975102bc3facef968561e3` | тот же, source не изменялся | https://github.com/gest0r1/openchamber-ru/tree/feature/pipeline-optimization-20261104 | checkout отсутствует |
| sevami | **не проверялся в этом запуске** | **не читался** | **не изменялся** | — | доступ к repo не использовался по указанию владельца |

Исторический base указан из handoff; фактический `main` двух разрешённых репозиториев был проверен в начале запуска: прежний SHA, без merge. Текущий HEAD проверяется чтением feature ref **после** создания runs-записи; отчёт не должен притворяться ссылкой на собственный ещё не существующий commit.

**Состояние этапов** (source-ready ≠ reviewed ≠ tested):

| Этап | Source | Независимая проверка / тест | Не завершено |
|---|---|---|---|
| 0–2. База, инвентаризация, ContextScout | подготовлено в предыдущих commits | историческая узкая приёмка | целевой установленный runtime, full tests |
| 3. Upstream/pins | **не готово** | 80 clean/18 conflict text + 6 delete/modify: только исторический three-way, не опубликованный merge | два настоящих parents, ручные resolutions, compatible OpenCode v2.2.5, Bun lock regeneration и pin checker |
| 4. Markdown tool timing | опубликовано ранее в OpenChamber | исторический actual projection→export runtime PASS | Bun/UI/typecheck/build на итоговом upstream |
| 5. PLAN approval/owner | source approval `8925bcb` принят ранее ограниченно | исторические 120/120 + 9/9, не новые tests | отдельный RUN intent во всех входах, full integration |
| 6. Prep/live/gates | targeted prep ранее; **PLAN phase lock/preflight + deployed-service proof добавлены** | новые source tests записаны, **NOT RUN** | actual consumer, build-output producer hash |
| 7. Reuse/live diagnostics | сохранённый reuse identity patch 4 файла **перенесён**, SHA256 всех четырёх совпали на commits переноса; source дополнен PLAN | прежний 39/39 — другой input, текущие тесты **NOT RUN** | real impact/reuse performance, actual live, post-patch regression |
| 8. Wake/compaction | wake/unknown child исходники ранее | pinned runtime не протестирован | actual missing-session/404, restart/compaction |
| 9. Canonical instructions | ранее частично исправлено, ownership в DECISIONS | исходники только | upstream-dependent cleanup/runtime load |
| 10. Integration | новые fixture tests написаны | **NOT RUN** | полный набор Node/tsx/TS/Bun, cross-repo, Docker, independent review |

**Изменения текущего запуска — только `my-opencode` feature**

- Сохранённый patch: `gate-runner-cli.ts`, `gate-runner-cli.test.mjs`; новый `gate-reuse-identity.mjs`, `gate-reuse-identity.test.mjs`. На переносе совпали *точные четыре* SHA256 из `handoff-assets/reuse-identity-working-20261105.files.json`. Модуль хеширует Node/действительный manager/tool/local bin, полное наследуемое env (минус 5 attempt-полей), дерево зависимостей/config, запрещает stale/unsupported reuse без нового cache.
- Новые `plan-probe-identity.mjs` и `plan-probe-identity.test.mjs`: версионированный `input_digest` по HEAD/commands/live image/index/cheap command и физический manifest-path check.
- `gate-command-policy.mjs`, `gate-testing-policy.mjs`, `gate-testing-policy.test.mjs`: только безопасный `preflight_command` в существующем `live_postgres`; `--pipeline-preflight` до реальных gate commands.
- `gate-runner-cli.ts` и старый `gate-runner-cli.test.mjs`: статeless `--plan-probe`, реальный `.runtime-locks` с PID/start, `phase=plan_probe`, raw manifest SHA, HEAD, input digest и candidate=null. Cheap preflight выполняется **до** выделения attempt/scratch/Docker; FAIL помечается BLOCKED, cleanup проверяется. После команд повторная проверка чистого checkout и неизменного raw manifest до PASS. Добавлены регрессии для fake Docker и fail-before-Docker; тесты не запускались.
- `manifest-v2-policy.mjs`, `pipeline-v2-contract.test.mjs`, `pipeline-dispatch.ts`, `pipeline-run.md`: один и тот же `planProbeMatches` при PLAN approval и RUN base reuse, live evidence строго для данной pipeline, phase/head/image/input/preflight, без ложного PASS от другой линии.
- `dev-deploy-cli.ts`, `gate-runner-cli.ts`: существующий `dev_deploy` evidence и root target status проверяются перед smoke и после него; команды получают `PIPELINE_DEPLOY_TARGET`, `CANDIDATE_SHA` от frozen published candidate; read-only, без sudo. Новый тест smoke PASS, stale SHA, missing completed stage и смены installed SHA во время команд.
- `gate-testing.md` и `DECISIONS.md` содержат канонические контракты, ограничения и разделение владельцев. Новых scheduler/cache/state/approval-store нет. `runtime-locks.mjs` и RUN state format не меняли.

**Проверки этого запуска и точная граница**

| Команда/действие | CWD / source input | Result | Duration / log |
|---|---|---|---|
| GitHub connector: проверка двух feature/main refs, `fetch_file`, коммиты | remote feature, начальные HEAD выше | PASS: published commits, сохранены прежние исходники при переносе | wall-clock unavailable; GitHub commit refs |
| Реконструкция 4-file unified diff + проверка каждых hunk context/length против source `8925bcbb...` | JS V8 isolate, exact GitHub source | PASS, 4/4 apply; старые два blob SHA не изменились после source baseline | duration unavailable; transfer commits `553dd563`, `4597078c`, `f25d52f9`, `1e891253` |
| SHA-256 transferred source files vs handoff `.files.json` | GitHub transfer commit refs; JS hash function c known test vector `abc` | **4/4 MATCH** на точках переноса; после новых commits runner файлы закономерно другие | duration unavailable; exact refs выше |
| V8 static JavaScript parse для 9 `.mjs` sources/tests (imports removed solely for parser); повтор для двух multiline imports | fetched remote source, JS isolate | **9/9 PARSE_PASS** | duration unavailable; не Node test и не module-resolution |
| Direct synthetic invocation `preflightPolicyError` from remote exact source | JS isolate, 3 good + 5 unsafe argv examples | PASS for declared scenarios | duration unavailable; без filesystem runner |
| `node --test ...gate-reuse-identity.test.mjs ...gate-runner-cli.test.mjs ...pipeline-v2-contract.test.mjs ...gate-testing-policy.test.mjs ...plan-probe-identity.test.mjs` | независимый checkout отсутствует | **NOT RUN — environment unavailable** | N/A |
| `bash tests/test_contextscout_installation.sh`, `node scripts/check-opencode-pins.mjs --openchamber <checkout>` | изолированный checkout / второй repo checkout отсутствует | **NOT RUN** | N/A |
| OpenChamber `bun test`, `bun run type-check`, `bun run check:changed`, frozen install/build | Bun/полный checkout отсутствуют | **NOT RUN** | N/A |
| Cross-repo consumer integration, actual disposable PostgreSQL / service target | прямое ограничение владельца на доступ к третьему repo; production запрещён | **NOT RUN** | N/A |

**Несовпадения / риски для независимого ревью**

1. Потребитель phase-aware lock не был открыт по запрету владельца; runner-side `input_digest` и `preflight_command` должны быть проверены на фактическом адаптере **отдельно**, без изменения запрещённого repo в этой сессии.
2. Проверка installed service использует существующие root-owned install/status records, не remote attestation; реальная форма `status_file` и post-smoke update могут потребовать уточнения.
3. Reuse identity hashing исторически требовал 401,961,187 bytes/21,365 paths и 3.782–4.986 s/pass на другом input; нового измерения скорости/токенов нет. Потенциальный privacy/cache риск неизвестных env routes блокируется отказом reuse (fresh execution), не переписыванием env.
4. `build-output` по-прежнему намеренно отклоняется без proof producer/hash. Upstream OpenChamber 2.6.1 / OpenCode 2.2.5 merge/pins не обновлялись без конфликтного дерева и проверок. Текущие source commits не означают release-ready.
5. Старые 39/39 и 120/120 являются **историческими результатами на других исходниках**; новые тесты не запускались. Команды `npx` или импорт `.ts` в полном runtime требуют отдельного TypeScript-check.

**Процессы, изменения и безопасное продолжение**

API commits немедленно опубликованы в feature; локальных uncommitted files в этом окружении нет, checkout не существует (состояние чужого workspace не заявляется). Новых фоновых агентских сессий, shell PID, Docker-контейнеров, gate locks или jobs **не создавали**; наличие чужих live процессов/locks не проверялось и не изменялось. Изолированные V8 функции не открывали producer systems.

Следующее действие: в изолированном feature checkout запустить указанные focused tests и TS validation, **не трогая** запрещённый repo. При успешной независимой приёмке к рассмотрению останутся OpenChamber upstream конфликтные resolutions, pinned compatible versions, build-output producer и остальные integration требования. Передача: **«Разработка частично завершена, требуется ревью и тестирование»**.

### Финальная source-ревизия 05.11.2026 (дополнение после run note)

- `gate-runner-cli.ts`: stateless PLAN cheap validator теперь обнуляет **не только** `CANDIDATE_SHA` и `PIPELINE_DEPLOY_TARGET`, но и унаследованные `DATABASE_URL`, `LIVE_PG_TEST`, `LIVE_PG_CONTOUR`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` перед запуском validateOnly. Добавлен regression в существующий `gate-runner-cli.test.mjs`: внешний `DATABASE_URL` намеренно задан и в preflight запрещён. Синтаксический V8 PARSE_PASS для обновлённого теста; Node test по-прежнему **NOT RUN**.
- Инструкции OpenChamber были прочитаны только в разрешённом fork: `AGENTS.md`, `openchamber-change-discipline/SKILL.md`, `opencode-v2/SKILL.md`, `package.json`. Source merge там требует `bun run check:changed` **до каждого source commit**, полноценный Bun toolchain и ветку конфликтных файлов. В текущем source-only GitHub API окружении выполнить эти checks нельзя, поэтому не создавался фиктивный upstream merge commit и не менялись lockfile/pins.
- Checkpoint перед этим дополнением: git feature `739293a5cb5bdf2fd4c9f159eefbf827d5cd301e` (source); для актуального commit после отчёта/дополнений читать ref. `main` и OpenChamber feature в этом запуске неизменны. Запрещённый репозиторий не открывался.

## Ревью и точечный safety-fix, 2026-11-05T16:42:47.910Z UTC

**Точка входа:** `my-opencode feature@330c675bde9454614d9745769761aac04374ecd4`, `openchamber-ru feature@f9e8831586efc5b6ef975102bc3facef968561e3`; базовые `main` SHAs не изменились. На момент начала после предыдущего checkpoint в ветках уже были +51/+12 commits. В текущем запуске редактировали **только** `my-opencode`; чужие worktrees/процессы неизвестны, инструменты локального checkout/production не использовали. Состояние текущего ref следует проверять после run-note.

### Изменения
1. `gate-runner-cli.ts` (commit `3b5a8e8`): при межзапусковом `findReusableResults` и при `snapshot.reused_by_impact` запрещено зачитывать PASS для `live_postgres.command_indexes` и всех `input_kind=deployed-service`. Последующий RUN обязан получить новое evidence ресурса, при этом независимые pure commands сохраняют per-command reuse. Старый код сравнивал source/toolchain/env, **но не доказывал состояние другого disposable DB/service**, мог записать `commands_run=0` без Docker. Регрессия `gate-runner-cli.test.mjs` commit `230bf89`: два одинаковых запуска, две attempt-owned Docker create/rm, `commands_reused=0`. Документация `gate-testing.md` commit `ef332df`.
2. `dispatch-leases.mjs` (commits `06d7eee`, `7ba6ac3`): после гибели owner process lease с `parent_session_id` либо `child_session_id` **не удаляется**, если stage ещё не completed. Это покрывает crash-window до acknowledgement childID. `pipeline-runtime.ts::checkWake` (commit `9eb3c04`) для такого lease без childID распознаёт `unknown`, не `idle`, сохраняет bounded diagnostics вместо повторного dispatch. Старый legacy lease без parent/child по-прежнему может быть очищен после подтверждённого dead PID; stage completed также освобождает lease. Регрессия в `pipeline-runtime.test.mjs` commits `594a8f6`, `c5cabb9`.
3. `DECISIONS.md` commit `88a28b7`: кратко сохранены канонические владельцы, причина запрета resource reuse и незакрытые риски crash-window.

### Проверки именно этих source inputs

| Проверка | Фактический результат | Ограничение |
|---|---|---|
| `git ls-remote https://github.com/gest0r1/my-opencode.git HEAD` | FAIL: DNS `github.com` отсутствует | изолированный checkout недоступен |
| GitHub connector read/commit/branch compare | PASS, проверен прирост +51/+12 commits до текущего запуска | не выполняет project commands |
| Native Node 22 + Git, Bun | Node 22 / git присутствуют, Bun нет | без full checkout невозможно запустить затронутые TS source imports |
| V8 isolate, exact fetched `dispatch-leases.mjs` with in-memory FS | PASS: dead parent retains both child-known and crash-window leases; overlapping writer blocked; complete stage cleanup; legacy lease pruned | synthetic test, не OpenCode SDK/Node integration |
| V8 isolate, exact fetched `gate-runner-cli.ts` resource-filter | PASS: pure `[true,true,true]`, live index `[true,false,true]`, deployed-service `[false,false,false]` | не запускает Docker и gate-runner |
| V8 syntax parse fetched `dispatch-leases.mjs`, `pipeline-runtime.test.mjs` | PARSE_PASS 2/2 после stripping import/export для JS parser | полноценный `node --test` не выполнен |
| `node --test config/opencode/skills/task-management/scripts/gate-runner-cli.test.mjs config/opencode/skills/task-management/scripts/pipeline-runtime.test.mjs` | **NOT RUN** | нужен checkout с pinned tsx и test dependencies |
| Cross-repo Bun/check:changed, native OpenCode session restart, actual disposable PostgreSQL, install/rollback | **NOT RUN** | целевое изолированное окружение отсутствует |

### Границы и следующие действия
- Функционально оба дефекта на source-path исправлены, но **совместимость со всем RUN кодом и отсутствием regressions не подтверждена**. В особенности проверить `readLeases`/plugin pause/resume при server restart и все async paths `checkWake` (у background child должен быть только один автор).
- Команды проверки: `node --test config/opencode/skills/task-management/scripts/gate-runner-cli.test.mjs config/opencode/skills/task-management/scripts/pipeline-runtime.test.mjs config/opencode/skills/task-management/scripts/gate-reuse-identity.test.mjs`, далее остальные suites из основного отчёта, `bun run check:changed` в OpenChamber до его source edits.
- Следующие блоки ТЗ остаются: **upstream OpenChamber 2.6.1 + OpenCode 2.2.5 with real merge/pins, build-output producer/hash, компакция/restored session tests, full cross-repo smoke/rollback и интеграционная приёмка**. Вся фактическая экономия времени/tokens без сопоставимого PLAN/RUN остаётся неподтверждённой.
- Прямой запрет владельца на чтение/изменение `sevami` сохранён. `main`, releases, deployments, платные GitHub Actions не затронуты. **Итог: частично, к независимому ревью полного ТЗ пока не готово.**

## Продолжение 2026-11-05T17:19:07.695Z: локальные входы gate snapshot / reuse

**Срез:** base `my-opencode/main@c58f452`, feature исходно `553df042`, source перед этим REPORT `a0cd2cbb531d870589687e1a6cce993ece66e252`. OpenChamber feature `f9e8831586efc5b6ef975102bc3facef968561e3` не менялся. Sevami не открывали. Все изменения этого запуска на my-opencode feature, production/main/release не затронуты.

**Проблема:** source-inventory исключает ряд локальных файлов, тогда как snapshot preparation может передать их тестовому процессу. Без единой идентификации RUN мог повторно использовать PASS для уже изменившихся входов.

**Source delta:** `gate-snapshot.mjs` использует общие `copiedIgnoredInputs` и `reuseLocalInputs`. `gate-reuse-identity.mjs` привязывает эти входы к проверяемому агрегированному identity. `gate-runner-cli.ts` сравнивает набор файлов до повторного использования и после исполнения; при невозможности сравнения reuse отклоняется. Snapshot при ошибке копирования не продолжает молча с пропущенным входом. Обновлены `gate-testing.md`, `DECISIONS.md` и тесты `gate-reuse-identity.test.mjs`, `gate-runner-cli.test.mjs`. Отдельных cache/state/runner нет. Коммиты source: `13de892`, `df659ee`, `3f460e5`, `f6305ca`, `9ab460e`, `6d5644d`, `73e1158`, `1e33c1f`, `08eb6e6`, `b9644d7`.

**Дополнительная native Git-проверка (05.11):** создан `gate-snapshot-inputs.test.mjs` (commit `b40942a`) с настоящим `git init`, tracked/ignored/untracked fixture; npm/tsx ему не требуются, но сам test-file в текущем checkout недоступен. В контейнере отдельно выполнены команды `git ls-files --others --ignored --exclude-standard --directory -z` и `git ls-files --others --exclude-standard -z` на идентичном fixture: список `.env.local .tmp/ node_modules/` и отдельно `.env.untracked local.key src/new.ts` — PASS (exit=0). Это проверяет native Git semantics, но **не** импорт `gate-snapshot.mjs` и не полный test suite. Команда для будущего isolated checkout: `node --test config/opencode/skills/task-management/scripts/gate-snapshot-inputs.test.mjs`.

**Проверки текущего input:** GitHub connector source и commits PASS. V8 isolated JS parser four updated modules/tests PASS (imports удалены только для parse); isolated запуск точной `reuseLocalInputs` с симулированным Git-index PASS: исключённые каталоги пропущены, локальные входы включены. Нативные `node --test config/opencode/skills/task-management/scripts/gate-reuse-identity.test.mjs config/opencode/skills/task-management/scripts/gate-runner-cli.test.mjs` **NOT RUN**; TS/Bun/full regression/real Docker **NOT RUN**. Container: Node22.16.0, git2.47.3, Bun отсутствует, `curl https://github.com` завершается `Could not resolve host`. Изолированного repository checkout по-прежнему нет. Ни synthetic PASS, ни старые 39/39 не считаются актуальным full PASS.

**Риски:** дополнительные чтения локальных файлов могут увеличивать время хеширования; реального before/after по CPU/elapsed нет. Доказательства корректного восстановления OpenCode child после аварии и bundled upstream OpenChamber 2.6.1 / OpenCode 2.2.5 также отсутствуют. Целевая приёмка: focused Node suite на exact HEAD, тест с изменением локального файла между двумя одинаковыми gate-runs, тест с изменением набора входов во время RUN, затем full affected, pins/Bun, безопасное обновление upstream в feature и rollback documentation. Статус **частично**.

## Wake/child continuation — 2026-11-05T21:00:36.763Z

**Source input:** старт `my-opencode/feature@b48b719d74ddf6ef4f4be050db2826bad862ff05`; `main@c58f452047df3806ea6e946d1909b075344bc069`. Исходники OpenChamber `feature@f9e8831586efc5b6ef975102bc3facef968561e3` не редактировались. Sevami не читали. Этот запуск содержит 8 source/test commits до DECISIONS `c1d05b6`; full test на точном HEAD не выполнен.

### Найденные причины и корректировки

1. `pipeline-runtime.ts::trackChild` при успешном `session.wait` только удалял child из `pendingChildren`; родитель RUN мог оставаться idle, потому что событие `session.execution.succeeded` приходит ребёнку, не обязательно родителю. Теперь успешный `session.wait` вызывает существующий `checkWake(parent)` через его таймер. Duplicate ack не создаёт второго waiter. Если wait недоступен или rejected, lease сохраняется по прежним правилам. Code commit `5af5706`; regression `7b66c8c`.
2. До изменения `checkWake` записывал fingerprint **до** API `synthetic`, и единичный transient API failure делал следующий wake невозможным. Теперь fingerprint фиксируется только после принятого вызова; синхронные вызовы сериализуются guard `wakeInFlight`, отказы логируются и повторяются до трёх раз, с задержкой не более 5 секунд. При новом `session.execution.started` transient failure counter очищается. Code commits `0894c5a`, `4c5649a`, `f642be3`; regression `acc3954`.
3. `orchestrator-wake.mjs` fingerprint раньше учитывал только state JSON без доступности работ. После завершения ребёнка количество runnable lanes/активных leases меняется без edit state, и dedup мог подавить нужное продолжение. Добавлены `runnable_count` и `active_work` (boolean, без noise timestamps). Code commit `01906d3`; regression `289a5fd`.

### Фактические проверки этого запуска

| Проверка | Результат | Граница |
|---|---|---|
| GitHub feature и main SHA, 8 commits, список 4 изменённых source/test файлов | PASS | remote source, не checkout |
| Native Node22.16.0 + git2.47.3 на локальном fixture с ignored/untracked Git paths | **PASS**, содержимое входного набора проверено | fixture моделирует Git semantics, не выполняет full gate |
| Exact fetched `trackChild` source, JS isolate: дедуп waiter, no wake before child complete, one timer after success | PASS | не actual SDK/plugin setup |
| Exact fetched `checkWake` delivery source, JS isolate: failed synthetic не отмечен, second success consumed once | PASS | mocked plugin.session.synthetic |
| Exact fetched `wakeDecision` source, JS isolate: stable maintenance JSON, child active→released fingerprint change, dedup | PASS | mocked hash I/O, не integrated RUN |
| Isolated V8 parse `orchestrator-wake.mjs`, `orchestrator-wake.test.mjs`, `pipeline-runtime.test.mjs` | 3/3 PASS | импорты убраны только на этапе parser check |
| `node --test .../orchestrator-wake.test.mjs .../pipeline-runtime.test.mjs` | **NOT RUN** | нет checkout с настоящими imports/pinned deps |
| Pinned TypeScript/Bun/full OpenChamber, installed-plugin wait/synthetic, restart/compaction, cross-repo smoke | **NOT RUN** | нет проверенного runtime |

Завершение полного этапа 8 **НЕ подтверждено**: после restart/compaction нужны реальные installed SDK hooks, owner questions, ошибки доставки, duplicate event и управление orphan leases. Выбор модели/токены/экономия времени не измерялись. Никакой дополнительный scheduler/cache или постоянный второй wake store не добавлен.

### Продолжение
Точный изолированный feature checkout с pinned dependencies → целевые Node/tsx suites (wake, pipeline runtime, local gate inputs), затем parent wake и child wait tests на установленном OpenCode; после — stage 3 upstream/pins, stage 6 build-output producer/hash, полный integration/rollback. Сохранять запрет на чтение Sevami, production/deploy/release/paid Actions и отсутствие merge в main. **Статус по-прежнему ЧАСТИЧНО.**
