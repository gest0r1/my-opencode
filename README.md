# My Opencode Configuration

Бэкап конфигурации opencode: агенты, плагины, скиллы, systemd-сервис, скрипты.

## Структура

```
config/                          # Глобальная конфигурация opencode
  opencode/                      # ~/.config/opencode/
  agents/                        # ~/.agents/skills/ (claude-совместимые скиллы)
  systemd/                       # systemd user-юниты
  opencode.env.example           # единый env для OpenCode CLI и OpenChamber
scripts/                         # Пользовательские скрипты
  opencode-web-reboot/           # Скрипт перезапуска opencode-web сервиса
mcp/1c-buddy/                    # Pinned upstream, Compose и инструкция
```

> ⚠️ **Канон агентов (с 2026-08-01):** `~/.opencode/agent/` — install-дир, его читает бинарник.  
> Зеркало в git: `config/opencode/agent/`. Дубли в `~/.config/opencode/agent(s)/` УДАЛЕНЫ (не читались).  
> Править агентов ТОЛЬКО в `~/.opencode/agent/`, затем `cp -r ~/.opencode/agent/. config/opencode/agent/` + commit/push.

> ⚠️ **Скиллы `~/.agents/skills/` (с 2026-08-11):** читаются opencode нативно (agent-compatible dir).  
> Зеркало в git: `config/agents/skills/`. Править в `~/.agents/skills/`, затем `cp -r ~/.agents/skills/. config/agents/skills/` + commit/push.

## Credentials и единый runtime env

Для OpenCode и OpenChamber используется одна схема независимо от способа запуска.

### LLM credentials

OpenCode Go / OpenCode Zen / OpenAI OAuth настраиваются штатно:

```bash
opencode auth login
opencode auth list
```

Каноническое хранилище:

```text
~/.local/share/opencode/auth.json
```

`OPENAI_API_KEY` и `OPENCODE_API_KEY` в общий env намеренно не кладутся, чтобы env не перекрывал credentials из `auth.json`.

### Общие env-переменные

Единый runtime-файл:

```text
~/.config/opencode.env
```

Он предназначен для MCP/интеграционных секретов и общих runtime-настроек, например:

```bash
YANDEX_DISK_TOKEN=...
YANDEX_METRIKA_TOKEN=...
ONEC_AI_TOKEN=...
OPENCODE_DISABLE_DEFAULT_PLUGINS=1
```

Никогда не добавлять реальные значения в Git, issue или логи. `chmod 600 ~/.config/opencode.env`. Пример имён переменных без значений: `config/opencode.env.example`.

Обычная команда `opencode` запускается через managed launcher `/usr/local/bin/opencode`, который загружает `~/.config/opencode.env` перед запуском настоящего `~/.opencode/bin/opencode`.

OpenChamber использует тот же `~/.config/opencode.env` как при ручном запуске, так и через systemd startup. Поэтому CLI и OpenChamber получают одинаковые env и тот же `auth.json`.

Legacy-файл `~/.config/opencode-web.env` больше не используется. Installer один раз мигрирует его содержимое в `~/.config/opencode.env`, удаляет старые LLM API-key overrides и затем удаляет legacy-файл. В репозитории `config/opencode-web.env.example` также отсутствует.

## MCP

Поддерживаются ровно семь серверов: `context7`, `gh_grep`, `exa`, `yadisk`, `memory`, `ya-metrika`, `1c-buddy`. Первые три — удалённые сервисы; `yadisk` ставится в изолированный uv tool; версии npm-пакетов для `memory` и `ya-metrika` зафиксированы в `opencode.json`. Для `1c-buddy` установщик скачивает исходник строго по SHA из `mcp/1c-buddy/source.lock` и собирает собственный Docker-образ; порт доступен только на 127.0.0.1:6002. Подробнее: `mcp/1c-buddy/README.md`.

Для полного `install.sh` требуются доступ к Docker Engine и Compose v2, `npx`, а также `ONEC_AI_TOKEN` в локальном env. Если компонент ещё не подготовлен, установка завершается с явной ошибкой и не заменяет чужой контейнер. Чтобы выполнить **только обновление конфигурации**, не устанавливая MCP, можно явно задать `OPENCODE_SKIP_MCP_INSTALL=1` (это не означает, что MCP работают). Не запускай установку под другим пользователем через sudo: `$HOME` определяет пути окружения и Docker-контейнера.

## Upstream

| Remote | URL | Назначение |
|--------|-----|------------|
| `origin` | `https://github.com/gest0r1/my-opencode.git` | Наш бэкап конфигов |
| `upstream` | `https://github.com/anomalyco/opencode.git` | Исходный код opencode (источник обновлений) |

> ⚠️ **Важно:** Старый upstream `opencode-ai/opencode` — archived/legacy, не использовать.  
> Подробнее: `project/upstream.md`

## Установка OpenCode на отдельную машину

Требуется установленный и авторизованный GitHub CLI (`gh auth login`). Рабочий clone репозитория на целевой машине не создаётся.

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install.sh | bash
```

Установщик:
- устанавливает или обновляет сам OpenCode официальным установщиком `https://opencode.ai/install` в `~/.opencode/bin/opencode`;
- проверяет установленную версию OpenCode;
- скачивает `main` этого репозитория во временный каталог через GitHub API;
- копирует глобальные конфиги, включая скрытые файлы, в `~/.config/opencode/`;
- ставит агентов из `config/opencode/agent/` в `~/.opencode/agent/`;
- ставит скиллы в `~/.agents/skills/`;
- создаёт или мигрирует единый `~/.config/opencode.env`;
- удаляет legacy `~/.config/opencode-web.env` после миграции;
- создаёт managed launcher `/usr/local/bin/opencode`, который всегда загружает единый env;
- устанавливает поддерживаемые локальные MCP из GitHub и pinned-пакетов, проверяет 1c-buddy;
- удаляет временные файлы после установки.

Для установки другой ветки/тега:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install.sh | OPENCODE_CONFIG_REF=<branch-or-tag> bash
```

## Полная установка OpenCode + private config + OpenChamber RU

Для новой Ubuntu-машины используется один bootstrap из приватного `my-opencode`:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | bash
```

Он устанавливает/обновляет OpenCode и конфигурацию, затем ставит OpenChamber RU из проверенного GitHub bundle для точного SHA. Если bundle отсутствует, установка останавливается; сборка из исходников выполняется только с явным `--build-from-source`. Подключает общий `~/.config/opencode.env` через launcher и systemd drop-in. Runtime-файлы не берутся из dev-папки.

### Проверка

```bash
opencode --version
openchamber --version
opencode auth list
opencode mcp list
```

### Запуск и порт

OpenChamber по умолчанию слушает порт **3000** на localhost.

```bash
openchamber --ui-password '<password>'
```

Явно задать другой порт:

```bash
openchamber --port 3001 --ui-password '<password>'
```

Короткая форма:

```bash
openchamber -p 3001 --ui-password '<password>'
```

Для доступа не только с localhost используй сетевые параметры OpenChamber осознанно; сам по себе `--port` не меняет интерфейс, на котором слушает сервер.

### Автозагрузка OpenChamber

Для Linux используется штатный `openchamber startup enable`. Наш launcher использует общий env, а systemd drop-in подключает `~/.config/opencode.env` напрямую.

Пример для Docker bridge, чтобы HTTP-порт OpenChamber не публиковался на внешнем интерфейсе:

```bash
openchamber startup enable \
  --host <DOCKER_BRIDGE_IP> \
  --port 3000 \
  --ui-password '<password>'
```

Если запуск идёт от `root` и сервис должен стартовать после reboot без интерактивного login:

```bash
loginctl enable-linger root
```

Проверка:

```bash
openchamber startup status
openchamber status
systemctl --user status openchamber.service
```

## Подход к установке и обновлению

Схема намеренно разделяет разработку и runtime-установку:

```text
разработка в рабочем clone
        ↓
git commit / git push
        ↓
GitHub: gest0r1/my-opencode + gest0r1/openchamber-ru
        ↓
install-openchamber.sh
        ↓
проверенный GitHub bundle → runtime install
```

### Обновление сервера

После изменений и `git push` в `my-opencode` или `openchamber-ru` на сервере выполняется та же команда установки:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | bash
```

Обновление сверяет SHA дистрибутива и OpenChamber, сохраняя существующий env. Рабочий clone на сервере не нужен. Встроенный `openchamber update` ориентирован на upstream, а не наш fork, поэтому для fork следует использовать установщик.

Для установки конкретной ветки или тега fork:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | OPENCHAMBER_REF=<branch-or-tag> bash
```

Для другой версии private config:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | OPENCODE_CONFIG_REF=<branch-or-tag> bash
```

## Разработка

Для разработки используется отдельная постоянная рабочая копия:

```bash
mkdir -p ~/projects
cd ~/projects
gh repo clone gest0r1/my-opencode
cd my-opencode
```

После изменений — обычные `git add`, `git commit`, `git push`. Установка на другие машины выполняется только через install-скрипты, а не из этой рабочей копии.

OpenChamber разрабатывается отдельно в `gest0r1/openchamber-ru`. Bootstrap не создаёт его рабочую копию на сервере.

## Ручное восстановление

```bash
mkdir -p ~/.config/opencode ~/.opencode/agent ~/.agents/skills

# Глобальные конфиги, включая скрытые файлы
cp -a config/opencode/. ~/.config/opencode/

# Агенты должны находиться в ~/.opencode/agent/, а не ~/.config/opencode/agent/
rm -rf ~/.config/opencode/agent
cp -a config/opencode/agent/. ~/.opencode/agent/

# Скиллы агентов
cp -a config/agents/skills/. ~/.agents/skills/

# Единый env; существующий runtime-файл не перезаписываем
[ -f ~/.config/opencode.env ] || cp config/opencode.env.example ~/.config/opencode.env
chmod 600 ~/.config/opencode.env

# Legacy env больше не используется
rm -f ~/.config/opencode-web.env
```

Для восстановления локальных MCP отдельно запустить GitHub-установщик либо `scripts/install-mcp.sh` из проверенного snapshot после настройки Docker и `ONEC_AI_TOKEN`.

Дополнительные компоненты при необходимости:

```bash
# legacy opencode-web systemd сервис тоже использует общий opencode.env
mkdir -p ~/.config/systemd/user
cp config/systemd/opencode-web.service ~/.config/systemd/user/
systemctl --user daemon-reload

# Скрипты
mkdir -p ~/Opencode/scripts
cp -a scripts/. ~/Opencode/scripts/
```
