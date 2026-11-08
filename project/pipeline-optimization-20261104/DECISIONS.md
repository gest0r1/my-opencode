# Карта решений после приёмки — 2026-11-08

Актуальная проверка и SHA: [REPORT.md](REPORT.md). Предыдущая инвентаризация сохранена в Git history.

| Механизм | Канонический владелец / потребители | Принятое решение и доказательство |
|---|---|---|
| Approval / PLAN / RUN | stage-cli, owner audit, команды PLAN/RUN | Сохранён существующий ledger; согласие связано с предметом/hash, RUN требует отдельного намерения. Контракты проходят |
| ContextScout | metadata роли, path helper, installer | planning/** сохранён, machine artifacts защищены; повторная установка проверена |
| Prep / DAG / frozen work items | manifest-v2-policy + stage-cli | required_by для потребителей, порядок/циклы/пересечения scope; совместимость старых frozen RUN сохранена |
| Gate runner | gate-runner-cli | Один executor PLAN/RUN/advisory/final; lifecycle preflight до дорогой работы |
| Input identity | gate-testing-policy + publication/deploy evidence | tree/candidate/build-output/service не смешиваются; проверены missing/foreign/stale proofs |
| Affected/reuse | snapshot read-set + reuse identity + existing evidence | Вложенные ignored inputs и замена toolchain инвалидируют PASS; focused PASS не заменяет final |
| Live/cleanup | существующие locks/slots/live-postgres | Очистка и прерывание проверены fixtures; живой Docker/PG отдельно NOT RUN |
| Scope / budgets / class review | stage-cli existing state | Без второго approval registry; ограниченные technical fixes и общие бюджеты проходят тесты |
| Wake / unknown / recovery | plugin доставляет, stage-cli владеет состоянием | Сохранение unknown leases, retry/dedup и независимых lanes; native engine активировал pipeline-runtime |
| Native plugin discovery | штатный loader OpenCode | Отдельные .ts в config/plugins/ обнаруживаются; лишний package adapter отклонён после реальной проверки |
| Timing / full child export | projection + общий timing renderer | Один путь происхождения времени; measured/unfinished/unknown и межвызовные gaps проверены |
| Page/secret routing | runtimeFetch + control service | Ответ страницы передаёт directory; обе API сохранены и протестированы |
| Telegram completion | existing watch + session-activity probe | Общий shell read, неизвестное не становится idle; native tests проходят |
| PR watchers / merge-follow | upstream runtime factories + feature routes/shutdown | Потерянный init восстановлен; обычный no-undef lint подключён к server entrypoint; настоящий пакет запущен |
| Локали | существующие словари и store | Новые RU строки переведены, мёртвые ключи удалены; runtime store не менялся в последнем fix, test ждёт observable state |
| Upstream/release | upstream2.6.1 + fork policy | Двухродительский merge, x64 и retired workflow policy сохранены; source mode для пилота |
| Модели / retired roles | Markdown ролей + exact tests | Утверждённые defaults сохранены; StageOrchestrator не возвращён |

Четыре prompt-файла суммарно +3,9% bytes. Экономия рабочего времени и токенов не измерена; правильность reuse доказана исполняемыми fixtures (2 команды → 0 на неизменённом входе; частичный reuse 1+1).
