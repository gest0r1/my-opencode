# Upstream

## Правильный upstream

**Repo:** https://github.com/anomalyco/opencode  
**Git remote:** `upstream`  
**Stable release synced:** v1.18.30 (2026-09-09)  
**Default development branch upstream:** `dev`  
**Version scheme:** v1.x.x (совпадает с npm-пакетами `@opencode-ai/*`)

## Legacy (не использовать)

~~https://github.com/opencode-ai/opencode~~ — archived/legacy.  
Не является источником binary/config update.

## Ветки и release policy

- `upstream` должен указывать на `anomalyco/opencode`.
- Для production/runtime синхронизации ориентируемся на последний stable release/tag `v1.*`, а не на произвольный HEAD `dev`.
- `dev` используем для анализа будущих изменений и совместимости, но не как автоматический production target.

## Текущая схема обновления

`gest0r1/my-opencode` — не source-fork OpenCode: это управляемая конфигурация и обвязка. Поэтому upstream OpenCode **не merge-ится целиком** в этот репозиторий. Синхронизация означает:

1. Проверить последний stable release `anomalyco/opencode`.
2. Обновить бинарник официальным installer (`https://opencode.ai/install`).
3. Обновить совместимые runtime-пакеты до той же версии:
   - `@opencode-ai/plugin`
   - `@opencode-ai/sdk`
4. Проверить upstream изменения в config/agents/plugins/task/session APIs против наших кастомизаций.
5. Если upstream уже реализовал аналогичную функцию, использовать upstream-поведение и удалить/не развивать дублирующую кастомизацию.
6. Сохранить только те изменения `my-opencode`, которые остаются необходимыми поверх upstream.
7. После обновления проверить загрузку конфигурации, агентов, plugins и OpenChamber integration.

## Agent directories в v1.18.30

Upstream OpenCode v1.18.30 загружает agent markdown из `{agent,agents}/**/*.md` для всех config directories. В список config directories входят глобальный config dir, проектные `.opencode` и `$HOME/.opencode`. Поэтому текущий install-dir `~/.opencode/agent/` остаётся нативно поддерживаемым OpenCode; отдельный workaround в самом OpenCode не требуется.

Официальная документация при этом рекомендует `~/.config/opencode/agents/` как публичный global path. Наш `~/.opencode/agent/` сохраняется как managed install-dir до отдельной миграции, поскольку он поддерживается loader'ом upstream и используется текущей OpenChamber integration.

## Model fallback

В agent schema OpenCode v1.18.30 поле `model` является одной строкой. Нативного `fallback`/списка моделей в agent frontmatter нет, и `task` tool не принимает fallback list.

**Политика проекта:** автоматический model/provider fallback не реализуем собственным router/runtime-слоем и не патчим OpenCode ради этого. Используем fallback только если он появляется как штатная upstream-функция OpenCode. До этого при недоступности модели ошибка должна быть явной, а смена модели — осознанной операцией пользователя/оркестратора через поддерживаемые upstream-механизмы.

Исключение возможно только при критической необходимости и после отдельного решения с доказательством, что задача не решается штатным upstream API/конфигурацией.

## Проверка версии

```bash
/home/guber/.opencode/bin/opencode --version
```

После установки версия бинарника и версии `@opencode-ai/plugin` / `@opencode-ai/sdk` должны быть совместимы; для stable deployment держим их на одном release line.
