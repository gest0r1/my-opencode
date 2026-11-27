# My OpenCode Configuration

Конфигурация OpenCode 2.x и канонический установщик OpenCode + OpenChamber RU.

## Документация

- [Pipeline разработки: Issue → PLAN → RUN → PR](project/pipeline.md)
- [Анализ reuse: сбор, выгрузка и решение о развитии/отключении](project/reuse-analysis.md)

## Целевые версии ветки 2.x

- OpenCode: `2.3.2`
- OpenChamber RU: `2.8.0`
- архитектура runtime: Linux x64

Версии включены в `main`; связанные репозитории:

- `gest0r1/my-opencode@main`
- `gest0r1/openchamber-ru@main`

## Канонические пути OpenCode 2.x

```text
~/.opencode/bin/opencode              # бинарник OpenCode
/usr/local/bin/opencode               # managed launcher
~/.local/share/opencode/opencode.db   # SQLite credentials/sessions (OpenCode V2)
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

Пользовательские агенты сохраняются из canonical `~/.config/opencode/agents/`. Installer обновляет только свои managed agents; завершённая миграция singular roots больше не входит в установку.

## Credentials и runtime env

LLM credentials настраиваются штатно:

```bash
opencode auth login
opencode auth list
```

Каноническое хранилище:

```text
~/.local/share/opencode/opencode.db
```

Общий runtime-файл:

```text
~/.config/opencode.env
```

Он используется OpenCode CLI и OpenChamber. `OPENAI_API_KEY` и `OPENCODE_API_KEY` намеренно не должны перекрывать штатное SQLite-хранилище V2.

Legacy `~/.config/opencode-web.env` мигрируется и выводится из использования. OpenChamber UI password при миграции сохраняется отдельно и затем переносится в native startup env.

## Установка только OpenCode + private config

Требуется авторизованный GitHub CLI:

```bash
gh auth login
```

Каноническая команда:

```bash
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/gest0r1/my-opencode/contents/install.sh?ref=main' | bash
```

Для явного выбора config ref:

```bash
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/gest0r1/my-opencode/contents/install.sh?ref=main' \
  | OPENCODE_CONFIG_REF=main bash
```

Standalone `install.sh` делегирует полную установку в `scripts/install-opencode-generation.sh`: устанавливает OpenCode `2.3.2`, атомарно подготавливает и переключает config/skills generation, нормализует OpenCode 2.x paths и сохраняет существующие credentials/runtime secrets. Binary-only fast path используется только из pinned OpenChamber orchestration, когда state подтверждает, что exact config SHA уже активен.

## OpenCode + OpenChamber RU 2.x

### Runtime OpenChamber и независимое подтверждение

Системный `openchamber.service` работает от `opencode`. Он запускает единственный managed OpenCode `2.3.2` от того же пользователя. Проекты, Chats, плагины и данные OpenCode остаются в профиле `opencode`. Дистрибутив хранит проверенные web-пакеты под `/var/lib/my-openchamber/runtime/releases/<package-sha256>` и атомарно переключает `current`. Версия OpenChamber остаётся `2.8.0`.

Брокер хранит защищённый журнал отдельно. Веб-верификатор работает от `opencode-approval` и принимает HTTP через systemd Unix socket `/run/my-opencode-verifier/http.sock`. Для отдельного DNS-имени настройте HTTPS на доверенном reverse proxy. Сохраните исходный `Host`, обеспечьте процессу proxy доступ к сокету через группу `opencode-approval-proxy` и направьте это имя только на сокет верификатора. Если proxy работает в контейнере, передайте каталог сокета и его числовую группу. Группа недоступна `opencode`.

При первой установке передайте `OPENCHAMBER_OWNER_APPROVAL_ORIGIN=https://approval.example.com`. Origin фиксируется в root-owned policy и задаёт WebAuthn RP для всех Passkey. Установщик проверит доступность `/healthz` через HTTPS. `OPENCHAMBER_BIND_HOST` и `OPENCHAMBER_BIND_PORT` задают обычный интерфейс приложения, по умолчанию `0.0.0.0:3000`.

После первой установки зарегистрируйте Passkey отдельной root-командой из административной SSH-сессии:

```bash
python3 /usr/local/lib/my-opencode/opencode-owner-approval-admin.py enroll
```

Откройте выведенную одноразовую ссылку в системном браузере владельца в течение десяти минут. После регистрации используйте **Pipeline Approval** в OpenChamber. Ссылка откроет точный запрос на отдельном origin. Для отзыва используйте `opencode-owner-approval-admin.py revoke <credential-id>`. Храните выданную ссылку только на время регистрации.

### Обновление и миграция

Установщик разрешает обе ветки в точные SHA, проверяет manifest Linux-релиза и SHA-256 пакета до остановки сервисов. При неизменной паре SHA и здоровых сервисах повторный запуск ничего не перезапускает. Если поменялись только метаданные исходного SHA, локально сохранённый пакет переиспользуется по digest. Режим `release` обязателен для этого установщика.

Первый переход переносит активный профиль OpenChamber из `/root/.config/openchamber`. При конфликте файлов используется активная копия, уникальные файлы исторического профиля сохраняются. Отчёт о конфликтах и снимок конфигурации находятся в `/var/lib/my-openchamber/install/<transaction>`. Предыдущее пользовательское дерево сохраняется рядом с активным после атомарного переключения. Старый root-профиль, база OpenCode и исторический ledger остаются доступны для восстановления. Если Chrome использовал системное хранилище ключей другого пользователя, может понадобиться повторный вход.

Запускайте активацию с `OPENCHAMBER_RESTART_MODE=now` из внешнего SSH. Из терминала OpenChamber установщик только подготавливает пакет. Если процесс активации был прерван, повторный запуск в режиме `now` сначала восстановит предыдущие сервисы и профиль. После восстановления снова запустите обновление.

На хосте с зарегистрированным dev-контуром администратор сначала устанавливает `scripts/setup-opencode-deploy-sudo.sh` из проверенного SHA и переносит clone продукта в `/var/lib/opencode-dev/targets/<key>`. В root-owned `/etc/opencode/deploy-targets/<key>.conf` задаются `REPO_DIR`, относительный `INSTALLER`, фиксированные `ARGS` и `STATUS_ARGS`. Checkout, запуск installer и чтение status выполняются от `opencode-dev` с запретом повышения прав. Системные сервисы и доступ к отдельным портам настраивает администратор для этого пользователя. Проверка `sudo /usr/local/sbin/opencode-deploy-target --check-isolation` должна завершиться успешно до перехода на Passkey. Для отдельной установки OpenCode действует user-unit `opencode-web.service`. После перехода OpenChamber отключает старый user-unit.

При использовании `STATUS_ARGS` результат помечается `candidate-reported`. Для независимой проверки администратор указывает абсолютный путь `STATUS_READER` к своему защищённому скрипту. Он получает ключ контура и путь clone, выполняется от `opencode-dev` и возвращает JSON с SHA реально запущенного продукта.

Через `ENV_<NAME>=<value>` задаются несекретные параметры продукта, например его отдельный каталог установки. Для Docker-контуров helper использует принадлежащий `opencode-dev` rootless-сокет `/run/user/<uid>/docker.sock`, если администратор заранее запустил daemon для этого пользователя. Проверка изоляции отклоняет учётную запись с административным `sudo` или привилегированными группами Docker/LXD.

Если образ содержит `org.opencontainers.image.revision`, установите `scripts/opencode-dev-image-status.sh` в защищённый каталог под root и укажите путь как `STATUS_READER`. Задайте `ENV_COMPOSE_PROJECT_NAME` и `ENV_DEV_STATUS_SERVICE`. Проверка читает revision у образа фактически запущенного контейнера в rootless daemon.

В существующих RUN с историческим подтверждением откройте исходную сессию и выполните `stage-cli owner-reauthorize <run-id> --owner-source-session <id>` через установленный `tsx`. Повторите эту же команду после подтверждения каждого запрошенного checkpoint в Pipeline Approval. Брокер свяжет Passkey с имеющимся frozen manifest и точным кандидатом. Исторические записи сохраняются.

## Обновление OpenCode

При обновлении upstream или дистрибутива обязательно выполнить
[процедуру согласования версий](project/opencode-updates.md).

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
    OPENCHAMBER_RESTART_MODE=now \
    OPENCHAMBER_OWNER_APPROVAL_ORIGIN=https://approval.example.com \
    bash
```

Так wrapper, core, private config и OpenChamber release относятся к заранее выбранным immutable commits.

Если команда запущена из terminal, который обслуживает текущий OpenChamber, `OPENCHAMBER_RESTART_MODE=auto` сохранит текущую консоль и при необходимости оставит `PENDING APPLY`. Для окончательного применения с SSH/внешней консоли повторить ту же установку с:

```bash
OPENCHAMBER_RESTART_MODE=now
```

## Проверка после установки

```bash
systemctl show openchamber.service opencode-owner-approval.service opencode-owner-verifier.service -p User -p MainPID -p ActiveState
readlink /var/lib/my-openchamber/runtime/current
cat /var/lib/my-openchamber/install/active-sha
curl -fsS http://127.0.0.1:3000/health
```

Ожидаемые версии:

```text
OpenCode 2.3.2
OpenChamber 2.8.0
```

## Повторные обновления

Для обновления из `main` используется тот же `install-openchamber.sh`. Отдельный clone и `git pull` на сервере не нужны.

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

Выборочные диагностики и временная БД для live-тестов: [контракт тестирования](config/opencode/skills/task-management/gate-testing.md). Аудит остатков v1: [проверка и варианты очистки](project/v1-audit.md).

Исследование документации, библиотек и GitHub встроено в существующие гейты: [механика и права](config/opencode/PIPELINE.md#external-research-within-existing-gates).


### Пользовательские модели и Claude Code (issue #18)

При обновлении дистрибутива сохраняются `model` на уровне глобального `opencode.json` и пользовательские `model`/`variant` в существующих управляемых Markdown-агентах. Отсутствие этих полей в существующем агенте сохраняет наследование вместо закрепления нового дефолта. Содержимое и права управляемого агента обновляются из дистрибутива. Новые агенты получают проектные дефолты. Изменение модели только в открытой сессии OpenCode не переписывает конфигурацию: выбор для следующих сессий нужно сохранить явно в конфиге. Недоступный провайдер/вариант не заменяется установщиком молча — проверяйте доступность через `opencode models`.

`models.txt` больше не поставляется: список доступных моделей определяется OpenCode и подключёнными провайдерами. Начиная с версии 2.2.3, Claude Code поддерживается встроенным провайдером OpenCode без `@openchamber/opencode-claude`. Существующая авторизация `claude` не удаляется; для новой установки CLI опционален (`OPENCODE_INSTALL_CLAUDE_CLI=1`), затем `claude auth login --claudeai`. Перед использованием проверить `claude auth status` и наличие нужных моделей в OpenCode. Учётные данные OpenCode V2 находятся в SQLite (точный путь: `opencode debug paths db`); старый `auth.json` используется только для импорта при миграции.

**Перед публичным доступом:** обязательна отдельная процедура из [протокола очистки истории](project/issue18-security-cleanup-runbook.md). Удаление файлов из `main` не устраняет секреты из старых веток, PR, merge-коммитов и GitHub-кэшей.

При удалении старого Claude-плагина установщик переносит `claude-code/<model>` в `claude-agent/<model>`, сохраняя суффикс модели и `#variant`. Перед переключением конфигурации он сверяет выбранные модели с `opencode models claude-agent`. Если модель или вход не доступны, установка прерывается **до активации** и оставляет прежнюю рабочую конфигурацию. Для старых сессий, где выбор записан только в SQLite и не в файлах настройки, при возобновлении может потребоваться выбрать модель штатным способом; база не переписывается.
