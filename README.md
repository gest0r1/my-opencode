# My OpenCode Configuration

Конфигурация OpenCode 2.x и канонический установщик OpenCode + OpenChamber RU.

## Документация

- [Pipeline разработки: Issue → PLAN → RUN → PR](project/pipeline.md)
- [Анализ reuse: сбор, выгрузка и решение о развитии/отключении](project/reuse-analysis.md)

## Целевые версии ветки 2.x

- OpenCode: `2.0.21`
- OpenChamber RU: `2.1.0`
- архитектура runtime: Linux x64

`main` не обновляется до завершения проверки. Рабочие upgrade-ветки:

- `gest0r1/my-opencode@main`
- `gest0r1/openchamber-ru@main`

## Канонические пути OpenCode 2.x

```text
~/.opencode/bin/opencode              # бинарник OpenCode
/usr/local/bin/opencode               # managed launcher
~/.local/share/opencode/auth.json     # штатные credentials OpenCode
~/.config/opencode/                   # активная конфигурация
~/.config/opencode/agents/            # активные agents
~/.agents/skills/                     # активные skills
~/.config/opencode.env                # общий runtime env
```

Git-зеркала в этом репозитории:

```text
config/opencode/agent/                -> ~/.config/opencode/agents/
config/agents/skills/                 -> ~/.agents/skills/
```

Legacy agent roots `~/.opencode/agent/` и `~/.config/opencode/agent/` после миграции выводятся из active lookup path. Пользовательские агенты сначала переносятся в canonical plural path, а legacy roots архивируются в state backup.

## Credentials и runtime env

LLM credentials настраиваются штатно:

```bash
opencode auth login
opencode auth list
```

Каноническое хранилище:

```text
~/.local/share/opencode/auth.json
```

Общий runtime-файл:

```text
~/.config/opencode.env
```

Он используется OpenCode CLI и OpenChamber. `OPENAI_API_KEY` и `OPENCODE_API_KEY` намеренно не должны перекрывать штатный `auth.json`.

Legacy `~/.config/opencode-web.env` мигрируется и выводится из использования. OpenChamber UI password при миграции сохраняется отдельно и затем переносится в native startup env.

## Установка только OpenCode + private config

Требуется авторизованный GitHub CLI:

```bash
gh auth login
```

После merge 2.x в `main` каноническая команда будет:

```bash
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/gest0r1/my-opencode/contents/install.sh?ref=main' | bash
```

До merge для проверки upgrade-ветки:

```bash
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/gest0r1/my-opencode/contents/install.sh?ref=main' \
  | OPENCODE_CONFIG_REF=main bash
```

Standalone `install.sh` делегирует полную установку в `scripts/install-opencode-generation.sh`: устанавливает OpenCode `2.0.21`, атомарно подготавливает и переключает config/skills generation, нормализует OpenCode 2.x paths и сохраняет существующие credentials/runtime secrets. Binary-only fast path используется только из pinned OpenChamber orchestration, когда state подтверждает, что exact config SHA уже активен.

## OpenCode + OpenChamber RU 2.x

### Runtime OpenChamber

Канонический runtime хранится как immutable generations:

```text
~/.local/share/openchamber-v2/releases/<source-sha>/
~/.local/share/openchamber-v2/current -> releases/<source-sha>/
```

Native OpenChamber управляет systemd unit и startup env; unit запускает стабильный managed launcher. Переключение `current` атомарное. При ошибке возвращается предыдущий бинарник, затем native startup повторно применяет сервис. Installer не восстанавливает unit/env вручную.

По умолчанию OpenChamber слушает:

```text
http://172.18.0.1:3000
```

Это адрес Docker bridge для доступа из Nginx Proxy Manager. Его можно переопределить через `OPENCHAMBER_BIND_HOST` и `OPENCHAMBER_BIND_PORT`.

### Release package и fingerprint reuse

Producer workflow `openchamber-ru/.github/workflows/v2-linux-web-package.yml` для каждого OpenChamber source SHA публикует маленький exact-SHA `manifest.json`.

Manifest содержит:

- `source_sha`;
- `runtime_fingerprint`;
- `package_source_sha`;
- имя `.tgz` package;
- SHA-256 package;
- версию OpenChamber.

Если runtime-входы не менялись, workflow **не пересобирает package**: новый manifest ссылается на ранее проверенный `package_source_sha`. Это сохраняет GitHub Actions minutes и повторяет полезную семантику installer 1.x.

Установщик сначала читает manifest. Большой package скачивается только если требуемого verified package ещё нет локально и runtime действительно требует обновления.

`OPENCHAMBER_PACKAGE_MODE`:

- `release` — использовать только verified release package; если manifest/package отсутствует, завершиться ошибкой;
- `auto` — release package предпочтителен, но при его отсутствии разрешён exact-SHA source fallback;
- `source` — принудительный exact-SHA source build.

Для серверной миграции рекомендуется `release`, чтобы отсутствие producer release не превращалось в неожиданную локальную сборку.

## Инкрементальная логика обновления

Canonical `install-openchamber.sh` независимо определяет изменения OpenCode config, OpenCode binary, OpenChamber runtime metadata и service state.

| Состояние | Действие |
|---|---|
| Ничего не изменилось | config обновляется атомарно с сохранением пользовательских plugins; OpenCode binary, release lookup и OpenChamber package переиспользуются; native startup перезапускает сервис для загрузки config |
| Изменился только private config, OpenCode `2.0.21` уже установлен | запускается config-only install с `OPENCODE_SKIP_BINARY_INSTALL=1`; официальный binary installer не вызывается |
| Требуется обновить только OpenCode binary, а pinned `config_sha` уже активен | config обновляется; официальный OpenCode installer обновляет binary с backup/rollback и version validation |
| Изменился OpenChamber source SHA, но `runtime_fingerprint/package_source_sha` прежние | скачивается только маленький exact-SHA manifest; OpenChamber package не скачивается и не переустанавливается |
| Изменился runtime package | используется verified local cache либо скачивается новый `.tgz`, затем проверяется SHA-256 |
| Изменился только host/port/env/service state | runtime package не трогается; выполняется только service reconciliation |

Двигающиеся branch refs на границе транзакции разрешаются в exact SHA. Core/config/runtime helper далее получают только pinned SHA, поэтому branch update во время установки не смешивает разные поколения.

## Миграция с 1.x

Полное удаление legacy runtime **не зашито скрыто** в основной installer. Для первой миграции предусмотрен отдельный cleanup script. Он сохраняет credentials/UI password, переносит пользовательские agents и архивирует legacy lookup roots.

До merge, для текущей upgrade-ветки:

```bash
CONFIG_SHA="$(gh api \
  'repos/gest0r1/my-opencode/commits/main' --jq .sha)"

gh api -H 'Accept: application/vnd.github.raw' \
  "repos/gest0r1/my-opencode/contents/scripts/cleanup-openchamber-v1-before-v2.sh?ref=$CONFIG_SHA" \
  | bash
```

Если cleanup запускается из embedded terminal самого OpenChamber, режим `auto` не убивает активный runtime под текущей консолью: destructive runtime cleanup откладывается. Из SSH/внешней консоли можно явно использовать `OPENCHAMBER_CLEANUP_RUNTIME_MODE=now`.

## Проверочная установка upgrade-веток

Для теста перед merge лучше pin-ить обе ветки заранее и запретить source fallback:

```bash
CONFIG_SHA="$(gh api \
  'repos/gest0r1/my-opencode/commits/main' --jq .sha)"
OPENCHAMBER_SHA="$(gh api \
  'repos/gest0r1/openchamber-ru/commits/main' --jq .sha)"

gh api -H 'Accept: application/vnd.github.raw' \
  "repos/gest0r1/my-opencode/contents/install-openchamber.sh?ref=$CONFIG_SHA" \
  | OPENCODE_CONFIG_REF="$CONFIG_SHA" \
    OPENCHAMBER_REF="$OPENCHAMBER_SHA" \
    OPENCHAMBER_PACKAGE_MODE=release \
    bash
```

Так wrapper, core, private config и OpenChamber release относятся к заранее выбранным immutable commits.

Если команда запущена из terminal, который обслуживает текущий OpenChamber, `OPENCHAMBER_RESTART_MODE=auto` сохранит текущую консоль и при необходимости оставит `PENDING APPLY`. Для окончательного применения с SSH/внешней консоли повторить ту же установку с:

```bash
OPENCHAMBER_RESTART_MODE=now
```

## Проверка после установки

```bash
opencode --version
openchamber --version
opencode auth list
openchamber startup status
systemctl --user status openchamber.service
ss -lnt | grep '172.18.0.1:3000'
```

Ожидаемые версии:

```text
OpenCode 2.0.21
OpenChamber 2.1.0
```

## Повторные обновления

После merge в `main` используется тот же `install-openchamber.sh`. Отдельный clone и `git pull` на сервере не нужны.

Встроенный `openchamber update` не является каноническим механизмом для нашего fork: установка должна идти через verified release manifest/package из `gest0r1/openchamber-ru`.

## Разработка

Для разработки используется отдельный clone:

```bash
mkdir -p ~/projects
cd ~/projects
gh repo clone gest0r1/my-opencode
cd my-opencode
```

OpenChamber разрабатывается отдельно в `gest0r1/openchamber-ru`. Runtime installer не создаёт dev clone на сервере.

## Ручное восстановление конфигурации

```bash
mkdir -p ~/.config/opencode/agents ~/.agents/skills
cp -a config/opencode/. ~/.config/opencode/
rm -rf ~/.opencode/agent ~/.config/opencode/agent
cp -a config/opencode/agent/. ~/.config/opencode/agents/
cp -a config/agents/skills/. ~/.agents/skills/

[ -f ~/.config/opencode.env ] || cp config/opencode.env.example ~/.config/opencode.env
chmod 600 ~/.config/opencode.env
rm -f ~/.config/opencode-web.env
```

### Пользовательские плагины

При обновлении `scripts/merge-user-plugins.mjs` переносит пользовательские plugin entries из JSON/JSONC и локальные файлы `plugins/` в staging до проверки зависимостей. V1 tuples нормализуются в V2 objects; дубли по package ID устраняются, обязательная запись репозитория имеет приоритет. Явные исключения задаёт `config/opencode/plugin-policy.json`. Некорректный config прерывает staging, активное поколение остаётся прежним.


## Перенос root-runtime на отдельного пользователя

Скрипт `scripts/migrate-root-runtime-to-opencode.sh` запускается от root; он **не останавливает текущий runtime и терминал**. Это подготовка, а не завершённый cutover. Отдельный пользователь называется `opencode`. Оба установщика принимают любого sudo-capable пользователя, создают runtime account при необходимости, обновляют ограниченные root-owned helpers и переключаются с чистым HOME/XDG/PATH и cwd в домашний каталог `opencode`.

При подготовке источник сохраняется, имеющиеся файлы назначения не перезаписываются. SQLite копируется через backup API вместе с committed WAL. Исправляются физические Git worktree links и admin metadata, выполняются repair/list/status без reset/clean/prune. Активный runtime назначения блокирует подготовку. Node 22+ проверяется от runtime user; при отсутствии совместимой версии ставится пользовательский Node 24.21.0 с проверкой SHA-256 официального архива.

Финальный запуск установщика выполняется из внешней SSH-консоли. Старые systemd/native services останавливаются с сохранением возможности восстановления. Process inventory проверяется fail-closed. Затем root делает свежий снимок источника, а **все записи в домашний каталог выполняет пользователь opencode**. Изменённые после подготовки файлы назначения блокируют перезапись. Миграция SQLite проверяется сначала на копии, затем выполняется транзакционно с integrity/FK, сохранением session/history counts и проверкой идемпотентности. Совместимые дубли составных ключей объединяются; конфликт metadata или referenced identity требует явной реконсиляции. Search DB, JSON sandboxes и base64 registries мигрируют отдельно. MISSING targets и immutable history сохраняются, фиктивные каталоги не создаются.

Резервные копии, `rollback-index.json` и отчёты находятся в `~/.local/state/my-opencode/state-migration-*`; исходные данные root не удаляются. Не восстанавливайте SQLite поверх работающего сервиса: остановите писателей и используйте backup API. При ошибке final sync сначала восстанавливаются файлы назначения, затем прежние сервисы. Изменение metadata при открытом старом UI требует обновления вкладки и выбора нового `/home/opencode/...` пути.

OpenCode unit запускает проверенный `serve --hostname/--port` на loopback. OpenChamber по умолчанию слушает `0.0.0.0:3000`: Docker proxy сохраняет доступ, а managed callback выбирает loopback, обходя MASQUERADE. UI password, same-machine и bearer проверки сохранены. Browser использует доступный native Chrome вместо root wrapper; отсутствие native Chrome при включённом server-browser — явный блокер. CLI Claude устанавливается в пользовательский prefix при включённом плагине. Незавершённый Claude login отражается как `CLAUDE_LOGIN_REQUIRED`, без подмены credentials.

Cutover проверяет API, enable/linger, UID/HOME/PATH/cwd сервисов и аутентифицированный UI/API; повторяет проверку после restart. Реальный reboot и платную генерацию установщик автоматически не выполняет. После reboot отдельно повторите `verify-runtime-services.py` с теми же bind/password env; browser.open/snapshot и реальную генерацию провайдера проверьте из OpenChamber. Только успешные проверки позволяют зафиксировать отключение старых сервисов.

```bash
# root, внешняя SSH-консоль
CONFIG_SHA="$(gh api repos/gest0r1/my-opencode/commits/main --jq .sha)"
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/gest0r1/my-opencode/contents/scripts/migrate-root-runtime-to-opencode.sh?ref=$CONFIG_SHA" \
  > /tmp/migrate-opencode-user.sh
OPENCODE_CONFIG_REF="$CONFIG_SHA" OPENCODE_RUNTIME_USER=opencode bash /tmp/migrate-opencode-user.sh
sudo -iu opencode

# opencode, новая login shell
export OPENCODE_RUNTIME_USER=opencode
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"
gh auth status
CONFIG_SHA="$(gh api repos/gest0r1/my-opencode/commits/main --jq .sha)"
OPENCHAMBER_SHA="$(gh api repos/gest0r1/openchamber-ru/commits/main --jq .sha)"
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/gest0r1/my-opencode/contents/scripts/cleanup-openchamber-v1-before-v2.sh?ref=$CONFIG_SHA" \
  > /tmp/cleanup-opencode-v1.sh
bash /tmp/cleanup-opencode-v1.sh
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/gest0r1/my-opencode/contents/install-openchamber.sh?ref=$CONFIG_SHA" \
  > /tmp/install-openchamber-v2.sh
OPENCODE_CONFIG_REF="$CONFIG_SHA" OPENCHAMBER_REF="$OPENCHAMBER_SHA" \
  OPENCHAMBER_PACKAGE_MODE=release OPENCHAMBER_RESTART_MODE=now \
  bash /tmp/install-openchamber-v2.sh
```

При миграции root устанавливает ограниченный root-owned helper с NOPASSWD только для установки пакетов из системных APT-репозиториев.
Обычный installer проверяет доступ; сам он не может выдавать себе права root.
Для уже созданного `opencode` отдельно выполните от root
`scripts/setup-opencode-package-sudo.sh` с `OPENCODE_RUNTIME_USER=opencode`.

```bash
sudo -n /usr/local/sbin/opencode-install-packages --check
sudo -n /usr/local/sbin/opencode-install-packages update
sudo -n /usr/local/sbin/opencode-install-packages install python3-pip ffmpeg
```

OpenCode запрашивает подтверждение инструмента перед вызовом package helper.
Произвольный root shell и APT-опции через helper не разрешены.


## Подготовка окружения проекта и модели конвейера

Перед dispatch `/pipeline-run` выполняет `stage-cli prepare-environment <manifest.json>`, затем environment preflight. Менеджер выбирается по точному `packageManager` проекта; package.json и lockfiles остаются неизменными. pnpm/npm устанавливаются в пользовательский versioned cache с отключёнными lifecycle scripts; launcher выбирает кеш по проекту. Для Yarn и integrity-qualified pins используется Corepack. Подготовка другого PLAN не переключает версию pnpm уже выполняющегося проекта. PATH сервиса включает `~/.local/bin`. Установка не использует APT, не ремонтирует глобальные root symlinks и не расходует fix-cycles. Несовместимый Node, неподдерживаемые engine ranges, registry/auth/network failures остаются environment BLOCKED. Исправление окружения позволяет продолжить тот же RUN.

Preflight различает EXECUTABLE_NOT_FOUND, EXECUTABLE_BROKEN_SYMLINK, EXECUTABLE_NOT_ACCESSIBLE, EXECUTABLE_START_FAILED и PACKAGE_MANAGER_VERSION_MISMATCH; проверяет реальный запуск и engines из cwd проекта. Команда prepare-environment валидирует frozen manifest до установки и не меняет pipeline state. Установщики окружения проекта выполняются от opencode.

`pipeline_runtime_preflight` сверяет явно заданные модели агентов с живым enabled-каталогом текущего runtime. Отсутствующий точный provider/model возвращает PIPELINE_MODEL_UNAVAILABLE; пустой каталог не считается успешной проверкой. Автоматической смены провайдера нет. SeniorTechnicalPlanReviewer использует `claude-code/claude-opus-5-5[1m]` через `@openchamber/opencode-claude@1.3.4` и Claude.ai login пользователя opencode. Каталог подтверждает регистрацию, а не успешность генерации/остаток квоты. Проверка реальным вызовом reviewer требуется после изменения модели или подписки.

Проверки восстановления: `python3 tests/test_runtime_state_recovery.py`, `python3 tests/test_runtime_user_migration.py`, тесты project-tooling, manifest-preflight, capability-preflight и динамические installer/activation fixtures. Они дополняют, а не заменяют acceptance на установленном сервере.
