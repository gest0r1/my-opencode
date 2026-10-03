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
