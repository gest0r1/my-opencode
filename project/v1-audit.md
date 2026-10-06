# Аудит остатков OpenCode/OpenChamber v1 — 2026-10-06

Проверены деревья и основные runtime/installer/API/plugin-модули:
`my-opencode@97a0f92cac6702b2c467d67bebc74622a74c7287` и
`openchamber-ru@76012dd351a0f402b01387ffb8a5539120a20e76`.
Это аудит исходников и контрактов дистрибутива, а не инвентаризация работающего
сервера. Установленные бинарники, systemd, базы, credentials и пользовательские
плагины на сервере здесь не прочитаны и не изменены. Отсутствие совпадений в
GitHub code search не использовано как доказательство отсутствия старого кода.

## Исходное состояние v2 до согласования pins

- `my-opencode/install.sh` выбирает OpenCode `2.0.23`; standalone
  `scripts/install-openchamber-v2-core.sh` имеет собственный default `2.0.21`.
  `config/opencode/package.json` использует `@opencode/plugin@2.0.21`.
  Это разные v2 pins, не остатки v1. Отдельно можно согласовать единый pin,
  проверив совместимость и версии CLI, SDK и plugin API.
- В OpenChamber root/UI/web/VS Code manifests и `bun.lock` активный клиент —
  `@opencode/client@2.0.22`; schema/protocol также v2. Electron pin и Docker CLI —
  `2.0.22`. Старого `@opencode-ai/sdk` в проверенных manifest/lockfile нет.
- UI API boundary и web proxy используют `/api/*`. Managed runtime допускает
  только v2, минимум `2.0.20`, через `compatibility.js`.
- В дереве OpenChamber нет отслеживаемых CLI/EXE/DLL/SO-архивов старого runtime;
  Electron binary resources содержат placeholder, бинарник готовится сборкой.
  Это не доказывает отсутствие старых файлов на установленной машине.

## Решение после сверки upstream — 2026-10-06

Upstream OpenChamber проверен на
`f5b42d92031b083a5a5e0d5fdc763f483a70d3cc`.

- Reboot-helper, его plugin, path/oneshot units, машинный symlink и документация
  удалены из дистрибутива. Scheduler и отдельный интерфейс автозапуска исключены
  владельцем. Остаётся штатный systemd user-service OpenCode.
- Мусорный отслеживаемый blob `node_modules` удалён. Реальные зависимости и
  пользовательские данные не удаляются.
- Одноразовый cleanup первой миграции и его инструкции удалены. В installer
  убраны перенос singular agent roots, старого env-файла и fallback старого
  поля `restart_pending`, чтение старого OpenChamber env и удаление старого Bun
  global package после каждого обновления. Канонические пользовательские agents и plugin options
  продолжают сохраняться.
- Сервис OpenCode использует единый tracked шаблон: `serve`, `127.0.0.1`.
- CLI/plugin/client/schema/protocol pins согласованы на `2.0.23`.
  Правила последующих обновлений: [opencode-updates.md](opencode-updates.md).

## Сохранено по upstream

| Элемент | Причина |
|---|---|
| `v1-migration-topup.js`, startup hook и тесты | Ещё присутствуют upstream; migration cursor и базы не меняются |
| `/global/health` | Upstream распознаёт неподдерживаемый внешний v1 |
| Старая внутренняя форма auth entry | Upstream адаптирует credentials из актуального `/api/credential` |
| Legacy env/CLI lookup в OpenChamber | Upstream ещё ищет пути и пакет `opencode-ai`; запуск проверяет v2 |
| OpenChamber `.opencode/agent/` | Upstream сохраняет singular-каталог development tooling |
| Нормализация plugin tuples в нашем merger | Сохраняет пользовательские options, а не запускает v1 API |

`schema_version: 1`, сторонние plugins `1.x`, `i18n.v1`, fingerprint version
и Windows PowerShell `v1.0` относятся к независимым контрактам.

Владелец подтвердил завершённую миграцию своего единственного окружения.
Дополнительная инвентаризация сервера исключена. Исходники дистрибутива изменены;
работающие процессы, systemd пользователя, базы и credentials сервера в этой
задаче не изменялись.
