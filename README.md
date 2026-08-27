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
- временно скачивает snapshot `gest0r1/openchamber-ru@main`;
- выполняет `bun install --frozen-lockfile` и `bun run build:web`;
- пакует именно собранный fork в `.tgz` и устанавливает его глобально через npm;
- создаёт `/usr/local/bin/openchamber`, чтобы CLI был доступен из обычного PATH;
- удаляет временный исходный код после установки.

В результате сервер не содержит dev-clone `openchamber-ru`: установлен runtime-пакет, собранный из текущего GitHub `main`.

### Проверка

```bash
opencode --version
openchamber --version
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
временный snapshot → build → runtime install → удаление исходников
```

### Обновление сервера

После изменений и `git push` в `my-opencode` или `openchamber-ru` на сервере выполняется **та же команда**, что и при первой установке:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | bash
```

Она повторно:
1. обновит OpenCode;
2. установит актуальный private config из `my-opencode@main`;
3. скачает текущий `openchamber-ru@main`;
4. пересоберёт fork;
5. заменит установленный runtime OpenChamber новой сборкой.

Отдельный `git pull` на сервере не нужен: рабочая копия исходников там не хранится.

> **Важно:** для нашего fork не использовать `openchamber update` как основной механизм обновления. Встроенный updater ориентирован на официальный `@openchamber/web` и upstream OpenChamber. Наш канонический способ обновления — повторный запуск `install-openchamber.sh` из приватного `my-opencode`.

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
