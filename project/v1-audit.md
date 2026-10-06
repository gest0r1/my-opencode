# Аудит остатков OpenCode/OpenChamber v1 — 2026-10-06

Проверены деревья и основные runtime/installer/API/plugin-модули:
`my-opencode@97a0f92cac6702b2c467d67bebc74622a74c7287` и
`openchamber-ru@76012dd351a0f402b01387ffb8a5539120a20e76`.
Это аудит исходников и контрактов дистрибутива, а не инвентаризация работающего
сервера. Установленные бинарники, systemd, базы, credentials и пользовательские
плагины на сервере здесь не прочитаны и не изменены. Отсутствие совпадений в
GitHub code search не использовано как доказательство отсутствия старого кода.

## Подтверждённое состояние v2

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

## Найденное и предложение по очистке

| Находка | Статус | Предлагаемое действие |
|---|---|---|
| `my-opencode/scripts/opencode-web-reboot/plugin/index.js`: импорт `@opencode-ai/plugin`, `client.session.prompt_async`; helper installer/uninstaller | Реальное старое plugin API в отдельном helper, не в текущем managed plugin manifest | Удалить весь helper и его документацию/ссылки, если сценарий больше не нужен. Если нужен — портировать на v2 с тестом уведомления. Не возвращать старый plugin в автозагрузку |
| `scripts/opencode-web-reboot/plugin/node_modules`: отслеживаемый symlink `/home/guber/.config/opencode/node_modules` | Привязка к машине разработчика, не переносимый модуль | Удалить symlink вместе с helper либо восстановить зависимости штатно из manifest; не копировать целевой каталог |
| Корневой отслеживаемый `my-opencode/node_modules` содержит текст `cat: node_modules: Is a directory` | Мусорный файл, не зависимости | Удалить именно этот git blob, добавить/проверить ignore для реального каталога. Локальный каталог зависимостей не удалять |
| `scripts/cleanup-openchamber-v1-before-v2.sh` и README-раздел первой миграции | Одноразовый перенос/cleanup, не текущий runtime | После подтверждения завершённой миграции убрать из активного дистрибутива вместе с ссылками и связанными тестами. Не запускать очистку повторно и не встраивать её в обычное обновление |
| Installer legacy env/lookup/launcher handling и `merge-user-plugins.mjs` нормализация v1 tuple | Совместимость с пользовательскими конфигурациями | Удалять только после инвентаризации оставшихся старых конфигов. Новый installer не должен молча терять пользовательские plugins/options/credentials |
| OpenChamber `v1-migration-topup.js`, вызывается из `lifecycle.js` перед managed start | Действующая миграция поздних v1-сессий, меняет migration cursor | Сначала read-only проверить отсутствие недоперенесённых сессий и отсутствие активного v1 writer, подготовить backup. Затем отдельным изменением убрать startup hook/module/tests и обновить skill. Не удалять таблицы/строку `migration.v1-v2`: в модуле документирован риск повторного разрушительного импорта |
| `compatibility.js` fallback `GET /global/health` | Только распознавание и отказ неподдерживаемому внешнему v1, не поддержка v1 execution | Предлагаю сохранить: это даёт понятную причину несовместимости. Если убрать — оставить fail-closed отказ и проверить HTML/auth/timeout cases; сообщение станет менее точным |
| `auth.js` преобразует `/api/credential` в старую внутреннюю форму auth entry | Адаптер внутренней модели, источник credentials уже v2 | Сохранить до отдельного изменения всех потребителей quota/voice/routing; это не чтение старого auth-файла |
| OpenChamber `.opencode/agent/` содержит repo-development agents | Singular lookup root в tooling, не bundled product binary | Проверить lookup установленного v2, затем нормализовать в canonical plural `agents/` и проверить бот-workflows. По одному имени папки не удалять |

`schema_version: 1` у release manifest/project policy, версии сторонних plugins
`1.x`, `i18n.v1`, fingerprint version и Windows PowerShell `v1.0` сами по себе
не являются OpenCode v1. Их массовая замена ломает независимые контракты.

## Адресная проверка установленного окружения перед отдельной очисткой

1. Без чтения секретов перечислить пути CLI через `type -a`/`command -v` и
   разрешить symlinks; получить версии каждого кандидата с bounded timeout.
2. Проверить реальные `ExecStart` и executable работающих PID. Новое приложение
   должно запускать именно проверенный v2 binary, а не другой экземпляр из PATH.
3. Сверить active config lookup roots и plugin manifests с политикой managed
   generation. Пользовательские plugins проверять по API/imports, не по major
   версии самого плагина.
4. Подготовить точный список неиспользуемых файлов/сервисов и rollback/backup;
   удалять только адресно после проверки замены. Не применять `prune`, wildcard
   cleanup, удаление session tables или сброс credentials.

Предложения этого отчёта не выполняют очистку: нужна отдельная реализация после
выбора сохраняемых сценариев. Рабочий runtime и данные остаются нетронутыми.
