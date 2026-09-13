# My Opencode Configuration

Бэкап и установочный источник конфигурации OpenCode: агенты, плагины, скиллы, MCP и bootstrap-скрипты.

## Структура

```text
config/
  opencode/                      # ~/.config/opencode/
  agents/                        # ~/.agents/skills/
  opencode.env.example           # единый env для OpenCode CLI и OpenChamber
install.sh                       # установка/обновление OpenCode + private config
install-openchamber.sh           # OpenCode + private config + OpenChamber RU
```

> **Канон агентов:** `~/.opencode/agent/` — install/runtime-дир, который читает OpenCode. Зеркало в Git: `config/opencode/agent/`.

> **Канон agent-compatible skills:** `~/.agents/skills/`. Зеркало в Git: `config/agents/skills/`.

## Credentials и единый runtime env

OpenCode Go / OpenCode Zen / OpenAI OAuth настраиваются штатно:

```bash
opencode auth login
opencode auth list
```

Каноническое хранилище авторизации:

```text
~/.local/share/opencode/auth.json
```

`OPENAI_API_KEY` и `OPENCODE_API_KEY` в общий env намеренно не кладутся, чтобы env не перекрывал штатные credentials из `auth.json`.

Единый runtime-файл для MCP/интеграционных секретов и общих настроек:

```text
~/.config/opencode.env
```

Обычная команда `opencode` запускается через managed launcher `/usr/local/bin/opencode`, который загружает этот env перед запуском `~/.opencode/bin/opencode`.

OpenChamber использует тот же `~/.config/opencode.env` при ручном запуске и через штатный `openchamber startup`. Legacy-файл `~/.config/opencode-web.env` больше не используется.

## Upstream

| Remote | URL | Назначение |
|---|---|---|
| `origin` | `https://github.com/gest0r1/my-opencode.git` | private config/orchestration |
| `upstream` | `https://github.com/anomalyco/opencode.git` | официальный OpenCode |

Старый `opencode-ai/opencode` — legacy/archived и не используется как источник обновлений. Детали: `project/upstream.md`.

## Установка OpenCode

Требуется установленный и авторизованный GitHub CLI (`gh auth login`). Рабочий clone на runtime-машине не создаётся.

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install.sh | bash
```

Установщик:
- устанавливает/обновляет официальный OpenCode в `~/.opencode/bin/opencode`;
- скачивает private config из GitHub во временный каталог;
- устанавливает конфиги, агентов и skills;
- создаёт/мигрирует единый `~/.config/opencode.env`;
- создаёт managed launcher `/usr/local/bin/opencode`;
- удаляет временные исходники.

Для другой ветки/тега:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install.sh | OPENCODE_CONFIG_REF=<branch-or-tag> bash
```

## OpenCode + OpenChamber RU

Полный bootstrap:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | bash
```

Он:
- устанавливает/обновляет OpenCode и private config;
- проверяет Node.js 22 и Bun;
- временно скачивает `gest0r1/openchamber-ru@main`;
- выполняет `bun install --frozen-lockfile` и `bun run build:web`;
- устанавливает собранный runtime OpenChamber;
- создаёт `/usr/local/bin/openchamber` с тем же `~/.config/opencode.env`;
- подключает env к штатному `openchamber.service` через systemd drop-in;
- использует штатный `openchamber startup enable` с `--no-env-snapshot`;
- удаляет временный исходный код.

В runtime нет постоянного dev-clone OpenChamber.

### Проверка

```bash
opencode --version
openchamber --version
opencode auth list
openchamber startup status
openchamber status
systemctl --user status openchamber.service
```

### Запуск и автозагрузка OpenChamber

OpenChamber управляется штатными командами:

```bash
openchamber startup enable --host <HOST> --port 3000 --ui-password '<password>'
openchamber startup status
```

Если сервис запускается от `root` и должен стартовать после reboot без интерактивного login:

```bash
loginctl enable-linger root
```

Отдельные `opencode-web.service`, `opencode-web-reboot.path/service` и custom reboot plugin больше не используются: штатный startup/restart OpenChamber является единственным поддерживаемым механизмом.

## Подход к разработке и runtime

```text
DEV worktree
    ↓
commit / push
    ↓
GitHub immutable SHA
    ↓
clean install/build from GitHub
    ↓
validation runtime
```

Runtime никогда не должен устанавливаться напрямую из DEV checkout.

Для обновления сервера после изменения `my-opencode` или `openchamber-ru` используется та же bootstrap-команда:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | bash
```

`git pull` на runtime-сервере не нужен. Для fork OpenChamber основной механизм обновления — этот bootstrap, а не upstream-oriented `openchamber update`.

Для установки конкретной ветки/тега fork:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | OPENCHAMBER_REF=<branch-or-tag> bash
```

Для другой версии private config:

```bash
gh api -H "Accept: application/vnd.github.raw" repos/gest0r1/my-opencode/contents/install-openchamber.sh | OPENCODE_CONFIG_REF=<branch-or-tag> bash
```

## Разработка

Постоянная рабочая копия используется только для разработки:

```bash
mkdir -p ~/projects
cd ~/projects
gh repo clone gest0r1/my-opencode
cd my-opencode
```

OpenChamber разрабатывается отдельно в `gest0r1/openchamber-ru`. Установка/валидация выполняются из GitHub, а не из этой рабочей копии.

## Ручное восстановление private config

```bash
mkdir -p ~/.config/opencode ~/.opencode/agent ~/.agents/skills
cp -a config/opencode/. ~/.config/opencode/
rm -rf ~/.config/opencode/agent
cp -a config/opencode/agent/. ~/.opencode/agent/
cp -a config/agents/skills/. ~/.agents/skills/
[ -f ~/.config/opencode.env ] || cp config/opencode.env.example ~/.config/opencode.env
chmod 600 ~/.config/opencode.env
rm -f ~/.config/opencode-web.env
```
