# Handoff: удаление legacy Claude plugin, переход на штатный Claude Agent

**Дата:** 2026-11-18  
**Статус:** изменения в обоих репозиториях смержены в `main`, CI успешен; **очистка действующего хоста, установка и live-smoke НЕ выполнялись**.  
**Цель следующей сессии:** завершить переход на штатный `claude-agent`, исключить повторное появление `@openchamber/opencode-claude`, проверить выбранные модели и работу OpenChamber на хосте.

## Согласованное решение владельца

- Полностью убрать поддерживающий legacy-плагин код **включая установщик**, а не сохранять постоянную миграцию `claude-code/` → `claude-agent/`.
- Не устанавливать/проверять Claude CLI при каждом обновлении OpenCode/OpenChamber: авторизация Claude — отдельный штатный процесс (`claude auth login`).
- Не менять автоматически выбранные пользователем модели, `variant`, настройки агентов и авторизацию. Если старые ID моделей остались, сначала сверить фактические доступные модели; **не подменять выбор предположительно «эквивалентной» моделью**.
- Не удалять универсальные механизмы сохранения настроек (`merge-user-plugins.mjs`, `preserve-agent-colors.mjs`) или сторонние пользовательские плагины.

## Источник истины: уже выполнено

### my-opencode

- Репозиторий: https://github.com/gest0r1/my-opencode
- PR **#74** (MERGED): https://github.com/gest0r1/my-opencode/pull/74
- Кодовый merge SHA: **`baa005e0de3e6e5bfd51e1212d69764bcd06da47`**
- Удалены `scripts/migrate-claude-provider.mjs`, `scripts/verify-claude-models.mjs`, `tests/test_claude_migration.mjs`.
- Из `scripts/install-opencode-generation.sh` удалены migration-report, преобразование ID и специфический preflight `opencode models claude-agent`.
- Из `install.sh` и `install-openchamber.sh` удалены вызовы `ensure_claude_cli`; из `scripts/bootstrap-runtime-tools.sh` — сама функция.
- Из `config/opencode/plugin-policy.json` удалено исключение `@openchamber/opencode-claude`. Сохранены другие исключения.
- Исправлены связанные CI workflow и тесты. Не затронуты `scripts/merge-user-plugins.mjs`, `scripts/preserve-agent-colors.mjs` и credentials.
- CI **PASS**: [Canonical installer](https://github.com/gest0r1/my-opencode/actions/runs/44258200042), [Pipeline contracts](https://github.com/gest0r1/my-opencode/actions/runs/44258200247).

### openchamber-ru

- Репозиторий: https://github.com/gest0r1/openchamber-ru
- PR **#28** (MERGED): https://github.com/gest0r1/openchamber-ru/pull/28
- Кодовый merge SHA: **`01bdcf510b180ff87a4e5154e0a98bc142736cbb`**
- Удалён `packages/ui/src/components/sections/usage/ClaudeCodeSignIn.tsx`, использовавший integration `claude-code` от стороннего плагина.
- `UsagePage.tsx` теперь показывает `claude auth login`, без legacy OAuth UI.
- `packages/web/server/lib/opencode/routes.js`: специальная проверка CLI-auth перенесена с ID `claude-code` на штатный `claude-agent`.
- Удалены legacy alias квот и специальное ограничение OAuth-браузера для `claude-code`; обновлены тесты/техническая документация.
- CI **PASS**: [PR checks — tests, type-check, build, lint](https://github.com/gest0r1/openchamber-ru/actions/runs/44258857051).

**Важно:** репозиторные тесты ≠ проверка реально установленного сервера; утверждать, что Claude уже работает на хосте, нельзя.

## Критическая зависимость перед установкой

`scripts/merge-user-plugins.mjs` **сохраняет плагины из активной пользовательской конфигурации**. Теперь, когда `@openchamber/opencode-claude` удалён из `plugin-policy.json`, новый установщик способен вновь перенести его из старого пользовательского `opencode.json` / `opencode.jsonc`.

**Поэтому сначала — одноразовая безопасная очистка старого плагина на хосте, и только затем — новая установка.** Не следует возвращать постоянную миграцию/исключение ради этого случая.

## Что осталось сделать в следующей сессии

### 1. Актуализировать факты (read-only)

1. Проверить последние SHA обоих `main` и отсутствие новых изменений, конфликтующих с PR #74/#28.
2. Проверить реальное окружение **под runtime-пользователем `opencode`**, а не root: установленные версии, активные конфиги `~/.config/opencode/opencode.json` и `opencode.jsonc`, содержимое массива `plugins` / старого `plugin`, локальные plugin paths, актуальные выбранные `model` и agent frontmatter `model:`.
3. Найти старые ID `claude-code/...` в настройках и агентах. Сопоставлять по точному каталогу штатного `claude-agent`; **не заменять ID автоматически**. Отдельно проверить выбор модели через OpenChamber.
4. Проверить `claude --version`, `claude auth status` и `opencode models claude-agent` под тем же runtime-пользователем, не публикуя credentials/токены/содержимое auth.
5. Выполнить локальный `rg` в обоих репозиториях по `opencode-claude|claude-code|ClaudeCodeSignIn|migrate-claude|ensure_claude_cli` для финального инвентаря. Остаточные упоминания могут относиться к **названию продукта или его иконке**, а не к legacy-провайдеру. В частности, в `packages/ui/src/hooks/useProviderLogo.ts` встречалась пара `claude-agent` → `claude-code` для поиска лого; проверить назначение и не ломать логотип простой глобальной заменой.

### 2. Выпустить новый OpenChamber runtime из правильного SHA

- До текущей работы опубликованный fork-релиз был **`v2.7.1.1`**, собранный из более старого SHA; новый код из PR #28 вошёл в `main` только в `01bdcf51…`.
- На момент handoff `.github/release-request.json` в `openchamber-ru` содержит **`{"version":"2.7.1.1"}`**. **Нельзя считать, что старый release-package включает новый код**.
- Проверить правила fork release и фактический статус текущих релизов. При необходимости оформить следующий совместимый уникальный release/version, получить verified package+manifest, убедиться в source SHA и успешном release CI. Не менять OpenCode pin без необходимости (целевой OpenCode `2.2.7`, OpenChamber version `2.7.1` в конфигурационном README).

### 3. Очистить хост и установить

1. Перед изменениями — локальный защищённый backup активной конфигурации с возможностью rollback; не выгружать секреты в чат/GitHub.
2. Удалить **только** точные записи пакета `@openchamber/opencode-claude` из активных пользовательских конфигов (включая JSONC, versioned package spec и возможный legacy `plugin`). Проверить, нет ли отдельно установленного локального экземпляра именно этого плагина.
3. Если найдены выбранные модели `claude-code/...`, согласовать их точную замену **до** установки либо остановить применение: нельзя терять модель, variant или подменять их молча.
4. Убедиться, что native Claude CLI установлен/авторизован штатно; новая версия установщика этого не делает.
5. Установить **точно зафиксированные** `my-opencode` SHA и соответствующий verified OpenChamber package из нового релиза. Не выдавать source fallback/старый package за новый релиз. Учесть защиту встроенного терминала от restart (`PENDING APPLY`).
6. Убедиться, что после установки `@openchamber/opencode-claude` не загружается и не возвращается при повторном запуске установки. Авторизация, другие plugins и настройки сохранены.

### 4. Live acceptance и закрытие

- `opencode auth list`, `claude auth status`, `opencode models claude-agent`: без раскрытия секретов; штатный провайдер доступен.
- Из CLI и OpenChamber выполнить **реальный запрос** с выбранной моделью `claude-agent`; проверить инструменты/сессию и сообщения об ошибках.
- В OpenChamber: выбор модели, повторное открытие сессии, сохранение model/variant, показ Claude usage/quota и корректная подсказка `claude auth login` при отсутствующем логине.
- Проверить повторную установку и rollback (при ошибке — восстановить конфигурацию/версию без потери данных), обновить итоговый отчёт: SHA, установленный release, тесты PASS/FAIL/NOT RUN.

## Границы и запреты

- **НЕ выполнено:** SSH/live cleanup, фактическая установка после PR, end-to-end Claude запрос, проверка host auth, выпуск нового форк-релиза из нового Claude SHA.
- Не удалять `~/.local/share/opencode/opencode.db` (auth/sessions), домашний каталог, user secrets или все plugin caches «заодно».
- Не создавать новый механизм постоянной backward compatibility для retired plugin.
- Архивные changelog/документация и продуктовые иконки `Claude Code` не являются сами по себе активной интеграцией; оценивать отдельно.
- Для отчёта следующей сессии разделять подтверждённые факты, предположения и непроверенные места.

## Краткая инструкция для новой сессии

> Продолжи `project/handoff-native-claude-cleanup-20261118.md` из `gest0r1/my-opencode@main`. Сначала проверь актуальные SHA и фактическое состояние хоста, затем очисти активный legacy Claude plugin и выбранные legacy модели безопасно, подготовь корректный OpenChamber release из нового source SHA, установи обе обновлённые части и проведи live acceptance. Не повторяй завершённую разработку, не вводи постоянную миграцию, не меняй пользовательские модели или авторизацию без проверяемого основания. Отмечай PASS/FAIL/NOT RUN.
