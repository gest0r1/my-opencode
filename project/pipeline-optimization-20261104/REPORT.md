# Pipeline optimization 20261104 — актуальный отчёт

**Статус: частично; не готово к независимому ревью как завершённое ТЗ.** Срез: 2026-11-04 21:50 UTC; сессия ChatGPT, фактическая модель и ID runtime: unavailable. Ведущий reviewer проверяет отдельные commits; принятие отдельных изменений не означает приёмку всего задания. ТЗ: Library `libfile_5cb2f8787138819187518776c6d73d2b`, `pipeline-improvement-prompt-20261104.md`; инвентаризация и открытые решения — [DECISIONS.md](DECISIONS.md). История предыдущих запусков — `runs/` и история feature-ветки.

## Репозитории и среда

| Repo | Base `origin/main` | Проверенный source HEAD до отчёта | Рабочий путь / статус |
|---|---|---|---|
| [my-opencode](https://github.com/gest0r1/my-opencode/tree/feature/pipeline-optimization-20261104) | `c58f452047df3806ea6e946d1909b075344bc069` | `979c854daa25e20bed982f8b7884515919ae0922` | `/workspace/scratch/33c68a33a56d/isolated/my-opencode`: isolated source snapshot без подлинной Git-истории, source changes опубликованы; актуальный HEAD читать из ref, поскольку этот отчёт создаёт новый commit |
| [openchamber-ru](https://github.com/gest0r1/openchamber-ru/tree/feature/pipeline-optimization-20261104) | `f9521f168c894cb17dc60ba4f929d4df0722e263` | `647e7377ff2cf82b98d86681c3575cedbda75708` (docs); проверенный source `279a2b45e245d019555704ea5951d670e62b9057` | отдельный source snapshot; native projection PASS на `279a2b4`; Bun export/typecheck/build не выполнены |
| [sevami](https://github.com/gest0r1/sevami/tree/main) | `6a4898b3aabed5a06a13f3071e870deb75ae139d` | тот же main, правок не было | read-only GitHub; локальная историческая копия `9573b606...` не считается актуальным main |

Snapshot my-opencode построен из tree `1ae23f8a31b5c335f71d101bdfcaac606e0e175a` commit `885c235e614f0ff1c7312d25972c234aab234df4`: 411/411 файлов совпали с Git blob SHA; реестр `../tree.json`. Последующие проверенные изменения получены в этом snapshot и опубликованы в feature. Node `v24.22.1`, доступные `tsx` 4.21.0 и `@opencode/plugin` 2.0.23; pinned в source `tsx` 4.23.15 и plugin 2.1.4. Для тестов применён отдельный `npx --yes tsx` → `node --import <tsx loader>` shim: обычный tsx CLI получает `EPERM` при создании Unix socket. Это не проверка locked dependency set. Для двух fixture-тестов применялся только stub `pnpm --version=11.17.0`; установленная среда сообщала 11.25.0, реальные pnpm операции stub запрещает.

Gateway обнаружил единственный host `sevami`; read-only job `job_01M6M5J84E00KX2T66FPCFEA2P` завершён `JOB_TIMEOUT` до установления SSH — команда не запускалась. Основной container не резолвит GitHub для git, коннектор предоставляет source/commits, но не настоящую Git ancestry в checkout. Старые чужие рабочие деревья и рабочие сервисы не менялись. Оставшихся собственных test jobs/дочерних процессов и locks нет; состояние чужих процессов не утверждается. Session однажды прервалась из-за usage limit; это не причина менять роли/модели или архитектуру.

## Этапы и следующий пробел

| Этап | Статус и фактическое доказательство | Осталось |
|---|---|---|
| 0–1 baseline/inventory | частично: branch bases, tree/blob проверены; `DECISIONS.md` перечисляет владельцев и источники | настоящие checkout с ancestry, installed runtime pins, полная проверка consumers и загрузки ролей |
| 2 ContextScout | частично: planning subtree и path validator, native path tests и повторная установка fixture | exact-version runtime и интеграция с реальной установленной средой |
| 3 upstream/pins | блокировано средой: OpenChamber target v2.6.1 `ce853f415704d1bfe8d076a5cfb2caabac00fffd`, OpenCode target v2.2.5 `9bbb8ce18c80f099e0e448775f59d965ead40a21` — ориентиры предыдущей проверки, не обновлённые pins | перепроверить актуальный stable; настоящая Git ancestry, осмысленное разрешение конфликтов и обе pin/install проверки. Псевдо-merge не выполнялся |
| 4 Markdown timing | source исправления вынесены в OpenChamber, reviewer проверил source | projection regression PASS на source `279a2b4` (pending/running, fallback zero vs real zero, 1726500, error, endSource); Bun export/full/typecheck/build/sync-context runtime не выполнены: Bun отсутствует, standalone export упирается в отсутствующий locale en chain |
| 5 PLAN/approval | частично: baseline инструкции, readiness/carried ledger, запрет ложного wake на embedded RUN example | привязка действительного owner ответа к точному manifest hash и ID; отдельный explicit RUN intent, узкий approve и technical revision интеграционно не доказаны. `approvePipeline` сам не получает аутентифицированный owner-response identity; нельзя заменить её текстовой догадкой или вторым approval store |
| 6 prep/gates | частично: targeted `required_by` с legacy fallback; candidate publisher/runner binding; docs согласованы | PLAN-probe provenance для live-harness, build-output producer/hash, deployed-service installed SHA/target identity, полный runner end-to-end; безопасную фазовую границу не имитировать фиктивным RUN state |
| 7 selection/reuse/live | частично: 28 native fixture tests PASS, включая full/focus, per-command/cross-run reuse, fake live cleanup/SIGTERM | точная toolchain identity в reuse, реальный disposable Docker/live, before/after реального RUN и бывшая failed command не доказаны |
| 8 wake/children | частично: existing queue для независимых lanes, unknown lease, bounded re-probe, visible notice с dedup; 22 runtime tests PASS на plugin 2.0.23 | pinned plugin/runtime, доказанный contract missing session/404, persisted wake dedup и compact/restart интеграция; notice и запись не атомарны, crash между ними может повторить notice |
| 9 prompt cleanup | частично: PLAN context-index и RUN/Architecture prep drift устранены | полный audit runtime consumers, роль standalone vs pipeline delegation, upstream workaround removal только с доказанным replacement |
| 10 integration/review | не готово: отдельные source commits доступны по remote | полные affected suites на pinned deps, cross-repo совместимые SHA/pins, реальный export пример timing, installation/rollback plan и независимое ревью |

## Проверки

| Проверка и input | Результат | Среда и граница |
|---|---|---|
| `node --test .../gate-testing-policy.test.mjs` после `2eee746` | 14 PASS, 1 Docker SKIP, 0 FAIL; 151 ms Node reporter | verified snapshot; selection/fallback и gate policy; Docker не запускался |
| `bash tests/test_contextscout_installation.sh` | PASS, 0.69 s tool wall | temporary isolated destination, повторный install сохраняет subtree |
| Пять focused Node suites source `885c235` до следующих правок | 63 PASS, 2 FAIL, 1 SKIP; 25.6 s reporter | оба FAIL отдельно PASS с fixture `pnpm --version` stub и loader shim; два запуска не являются единым полным PASS на штатной среде |
| `git-worktree-cli.test.mjs` на candidate fix | 16 PASS, 16.26 s; новая producer hash assertion отдельно 1 PASS, 1.83 s | собственные временные Git repos и local bare remote; не upstream ancestry |
| `gate-runner-cli.test.mjs` + `reuse-report.test.mjs` | полный повтор 28 PASS, 31.96 s | tsx 4.21.0 + loader shim; локальные synthetic fixtures/fake Docker. Первый запуск 25 PASS/3 FAIL из-за отсутствующего `tsx` в module resolution; после подключения доступного пакета повторена вся команда |
| `pipeline-runtime.test.mjs` на `979c854` | 22 PASS, 26.96 s | plugin 2.0.23 вместо 2.1.4, tsx loader shim; предыдущие FAIL и их повторное подтверждение описаны в run note |
| `orchestrator-wake.test.mjs` | 4 PASS, 105 ms | Node unit; wake/owner checkpoint/independent lane |
| OpenChamber Bun export/full/typecheck и точные pinned OpenCode checks | NOT RUN | нет полного checkout и pinned dependencies; см. отдельный OpenChamber pointer и его последний SHA |
| Реальный Docker live, production, платные Actions | NOT RUN | запрещён production RUN; только fake Docker/isolated fixtures |

Полные исполнимые команды и локальные логи: `../native-focused-loader.log`, `../preflight-retest.log`, `../installer-test.log`, `../candidate-policy.log`, `../candidate-final.log`, `../git-worktree.log`, `../candidate-producer.log`, `../runtime-full-combined.log`, `../reuse-suite-retest.log`. Длительности Node reporter — не замеры реального RUN или оплаченных токенов. Тесты не доказывают ускорение реального SeVami RUN.

## Ведущее ревью

| Замечание | Commit | Evidence | Статус |
|---|---|---|---|
| `input_kind` без ресурсов не должен ломать post-deploy smoke | `7e0cbbc` | regression FAIL→PASS; policy suite | принято ограниченно |
| Пример RUN в PLAN не должен включать wake | `a059f2c` | actual plugin hook negative/positive | принято для узкого wake-case; не owner consent |
| Candidate нуждается в реальном publisher/identity | `2eee746` | runner и local Git publisher fixtures | принято ограниченно: passed SHA не доказывает semantics внешней команды или текущий remote |
| Противоречие blanket prep в RUN/архитекторе | `f0f236b` | source review и поиск старой фразы | принято по source |
| Independent lane, unknown/reprobe/visible notice, без двух сообщений | `ace82d4`, `7e777ee`, `979c854` | runtime 22 PASS с неподходящей locked plugin version; repeat/restart dedup fixture | принято ограниченно; exactly-once/SDK 404 не доказаны |
| OpenChamber timing/projection | source `279a2b4`, docs HEAD `647e737` | native projection PASS на `279a2b4`, полная команда и blob SHA в `timing-evidence` | source и regression приняты; Bun и integration не пройдены |

## Конкретные открытые вопросы

1. **Live lifecycle.** На актуальном Sevami main `6a4898b` `scripts/testing/pipeline-gate-evidence.ts::resolveTrustedGateEvidence` требует реальный `state.status=in_progress`, frozen manifest hash и принадлежащий gate `.runtime-locks` lock; `vitest.live.config.ts` вызывает adapter до collection. `gate-runner-cli.ts::planProbe` запускает probe без RUN state/runtime lock, поэтому этот consumer не может пройти как PLAN probe. Нужен явный phase-aware PLAN-probe provenance на существующих lock/PID/manifest доказательствах в runner и минимальном test harness, без фальшивого in-progress state; изолированные cross-repo integration tests обязательны. В RUN текущий lock появляется только внутри live batch после предыдущих команд, поэтому дешёвый lifecycle precheck до дорогого набора ещё не сделан.
2. **Reuse safety.** `selectAffectedCommands` расширяет до полного набора при отсутствии карты/базы, dependency/security и unmapped изменениях, сохраняет предыдущие failures; точный случай старых семи команд без исходных input/evidence не реконструирован. `findReusableResults` сверяет source digest, gate, command, test-files и environment digest, но текущий environment digest содержит Node version/PATH и отдельные env values, а не версии или bytes инструментов за тем же PATH и не полное окружение. Контрпример: `/tools/tsc` остаётся по тому же PATH, но его заменяют другой версией; tree и command не меняются, поэтому старый PASS может быть повторно использован. Минимальное исправление в существующем environment digest: включать проверенные версии/хэши всех релевантных executable и зависимостей toolchain либо запрещать reuse при неполной identity. Полный read-set ещё не установлен; 28 PASS не доказывают этот аспект и новый cache не нужен. Существующий cache/runner сохраняется, второй не добавлен.
3. **Owner authority.** Текстовые instructions требуют отдельного owner approval и RUN, но `stage-cli approve` не получает подтверждённый event ID/actual user response и hash предмета согласия; machine binding требует исследования реальных event/approval API и совместимой migration semantics. Внедрять фиктивный owner identity нельзя.
4. **Upstream и delivery.** Нет совместимого набора OpenCode/OpenChamber SHA, реальной проверки installed plugin/binary, итогового Markdown с реальным timing, установки/rollback и полноценных final suites. Требуются полноценный изолированный checkout, Git ancestry, locked dependencies и отдельный тестовый контур. Никакие main, merge/release/deploy/install/paid Actions не выполнялись.

## Продолжение

1. Сверить реальные feature HEAD обеих веток, tree и pending source edits; читать этот отчёт, `DECISIONS.md`, актуальный OpenChamber pointer и последние `runs/`. Не повторять полный аудит неизменившихся областей.
2. Повторить OpenChamber Bun exporter/typecheck/build и sync-context regression на source `279a2b4` или его прямом преемнике в pinned среде; projection result и воспроизводимая команда — в OpenChamber timing-evidence.
3. Проектировать и протестировать существующий phase-aware live-probe contract в отдельном Sevami feature checkout и my-opencode без создания фиктивного RUN. Затем устранить отсутствие надёжной toolchain identity для reuse и доказать owner-answer/manifest binding существующим источником ответов.
4. В checkout с настоящей ancestry проверить актуальные stable tags, выполнить предусмотренный upstream merge только в feature, разрешить конфликты и проверить оба набора pins/install; потом запустить оставшиеся полные affected/integration suites и обновить отчёт/указатель. До этого общий статус остаётся частичным.
