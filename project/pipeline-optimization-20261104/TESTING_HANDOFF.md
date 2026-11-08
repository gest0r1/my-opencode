# Проверка завершена — 2026-11-08

Текущий результат: [REPORT.md](REPORT.md). Накатка и возврат: [ROLLOUT.md](ROLLOUT.md). Исторические NOT RUN по прежним исходникам не описывают текущую приёмку.

## Воспроизведение проверки

- Принятые source SHA и версии указаны в REPORT.
- Bun1.4.4 frozen install, Node24.22.1, tsx4.23.15, реальный @opencode/plugin2.2.5.
- Pipeline: все 50 tracked *.test.mjs из config/opencode/skills/task-management/scripts, Node --test --test-concurrency=4.
- В sandbox npx --yes tsx направлялся в настоящий tsx loader через node --import, без IPC CLI tsx. Исходники и policy-проверки не подменялись, SDK не stub.
- OpenChamber: check:changed относительно upstream ce853..., десять затронутых Vitest server suites, десять изолированных Bun UI/export suites, native release contracts.
- Затем SDK build → web production build → bun pm pack → bun add --global в отдельный BUN_INSTALL.
- Настоящий CLI2.2.5 установлен в отдельный prefix. Packaged OpenChamber стартовал в empty HOME, UI HTTP200 и health.ready проверены; штатно остановлен с дочерним OpenCode.
- Второй запуск использовал canonical plugins/ auto-discovery. /api/plugin подтвердил active для pipeline-runtime и github-handoff. Ни пользовательские credentials, ни платные LLM/provider calls не нужны.

## Пределы

Два environment SKIP (Docker и procfs namespace); Windows artifact, реальный systemd rollback и продуктовые данные не тестировались. Полный web-suite PASS не заявляется; затронутые серверные suites прошли195/195. Никакие main/release/production операции не выполнялись.
