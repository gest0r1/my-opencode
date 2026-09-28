# My Opencode Configuration

Бэкап конфигурации opencode: агенты, плагины, скиллы, systemd-сервис, скрипты.

## Документация

- [Pipeline разработки: Issue → PLAN → RUN → PR](project/pipeline.md)

## Структура

```
config/                          # Глобальная конфигурация opencode
  opencode/                      # ~/.config/opencode/
  agents/                        # ~/.agents/skills/ (claude-совместимые скиллы)
  systemd/                       # systemd user-юниты
  opencode.env.example           # единый env для OpenCode CLI и OpenChamber
scripts/                         # Пользовательские скрипты
  opencode-web-reboot/           # Скрипт перезапуска opencode-web сервиса
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
YONOTE_API_KEY=...
YANDEX_METRIKA_TOKEN=...
OPENCODE_DISABLE_DEFAULT_PLUGINS=1
```

Обычная команда `opencode` запускается через managed launcher `/usr/local/bin/opencode`, который загружает `~/.config/opencode.env` перед запуском настоящего `~/.opencode/bin/opencode`.

OpenChamber использует тот же `~/.config/opencode.env` как при ручном запуске, так и через systemd startup. Поэтому CLI и OpenChamber получают одинаковые env и тот же `auth.json`.

Legacy-файл `~/.config/opencode-web.env` больше не используется. Installer один раз мигрирует его содержимое в `~/.config/opencode.env`, удаляет старые LLM API-key overrides и затем удаляет legacy-файл. В репозитории `config/opencode-web.env.example` также отсутствует.

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
- разрешает exact SHA `gest0r1/openchamber-ru@main`;
- скачивает маленький exact-SHA manifest из GitHub Release;
- использует проверенный Linux x64 bundle, указанный manifest; если runtime-входы не менялись, manifest может ссылаться на bundle предыдущего SHA;
- повторно не скачивает большой bundle, если его `bundle_source_sha` уже есть в локальном cache;
- проверяет SHA-256 bundle перед установкой;
- устанавливает/обновляет OpenCode config из приватного `gest0r1/my-opencode`;
- мигрирует runtime на единый `~/.config/opencode.env`;
- создаёт managed launchers и systemd user service/drop-in.

Сборка OpenChamber выполняется только в GitHub Actions producer workflow. Сервер не содержит dev-clone и не запускает source build.

### Проверка

```bash
opencode --version
openchamber --version
opencode auth list
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

Для Linux используется штатный `openchamber startup enable`. Наш launcher автоматически запрещает snapshot общего env, а systemd drop-in подключает `~/.config/opencode.env` напрямую.

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
GitHub Actions: fingerprint → reuse или verified Linux x64 bundle release
        ↓
install-openchamber.sh
        ↓
exact-SHA manifest → verified bundle → runtime install
```

### Обновление сервера

После изменений и `git push` в `my-opencode` или `openchamber-ru` на сервере выполняется **та же команда**, что и при первой установке:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | bash
```

Она повторно:
1. определит текущий `openchamber-ru@main` SHA;
2. проверит exact-SHA Linux x64 manifest;
3. скачает bundle только если указанный `bundle_source_sha` ещё не закеширован локально;
4. проверит SHA-256 и переключит runtime;
5. установит актуальный private config из `my-opencode@main`;
6. обновит launchers и systemd drop-in при необходимости.

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

# Единый env; существующий runtime-файл не перезаписываем
[ -f ~/.config/opencode.env ] || cp config/opencode.env.example ~/.config/opencode.env
chmod 600 ~/.config/opencode.env

# Legacy env больше не используется
rm -f ~/.config/opencode-web.env
```

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
