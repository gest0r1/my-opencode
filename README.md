# My Opencode Configuration

Бэкап конфигурации opencode: агенты, плагины, скиллы, systemd-сервис, скрипты.

## Структура

```
config/                          # Глобальная конфигурация opencode
  opencode/                      # ~/.config/opencode/
  agents/                        # ~/.agents/skills/ (claude-совместимые скиллы)
  systemd/                       # systemd user-юниты
  opencode-web.env.example       # env-файл (секреты в .env, не в git)
scripts/                         # Пользовательские скрипты
  opencode-web-reboot/           # Скрипт перезапуска opencode-web сервиса
```

> ⚠️ **Канон агентов (с 2026-08-01):** `~/.opencode/agent/` — install-дир, его читает бинарник.  
> Зеркало в git: `config/opencode/agent/`. Дубли в `~/.config/opencode/agent(s)/` УДАЛЕНЫ (не читались).  
> Править агентов ТОЛЬКО в `~/.opencode/agent/`, затем `cp -r ~/.opencode/agent/. config/opencode/agent/` + commit/push.

> ⚠️ **Скиллы `~/.agents/skills/` (с 2026-08-11):** читаются opencode нативно (agent-compatible dir).  
> Зеркало в git: `config/agents/skills/`. Править в `~/.agents/skills/`, затем `cp -r ~/.agents/skills/. config/agents/skills/` + commit/push.

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
- создаёт `~/.config/opencode-web.env` из примера только если файла ещё нет;
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

Он последовательно:
- устанавливает/обновляет OpenCode и всегда накатывает актуальную конфигурацию из приватного `gest0r1/my-opencode`;
- проверяет Node.js и при необходимости ставит Node.js 22 через nvm;
- ставит Bun, если его нет;
- временно скачивает `gest0r1/openchamber-ru@main`;
- выполняет `bun install --frozen-lockfile` и `bun run build:web`;
- пакует именно собранный fork в `.tgz` и устанавливает его глобально через npm;
- создаёт `/usr/local/bin/openchamber`, если каталог доступен для записи, чтобы CLI был виден сразу после запуска installer через pipe;
- удаляет временный исходный код после установки.

В результате сервер не содержит dev-clone `openchamber-ru`: установлен runtime-пакет, собранный из текущего GitHub `main`.

Проверка:

```bash
opencode --version
openchamber --version
```

Запуск:

```bash
openchamber --ui-password '<password>'
```

Для установки другой ветки/тега fork:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | OPENCHAMBER_REF=<branch-or-tag> bash
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

# Секреты — не перезаписывать существующий env
[ -f ~/.config/opencode-web.env ] || cp config/opencode-web.env.example ~/.config/opencode-web.env
```

Дополнительные компоненты при необходимости:

```bash
# systemd сервис
mkdir -p ~/.config/systemd/user
cp config/systemd/opencode-web.service ~/.config/systemd/user/
systemctl --user daemon-reload

# Скрипты
mkdir -p ~/Opencode/scripts
cp -a scripts/. ~/Opencode/scripts/
```
