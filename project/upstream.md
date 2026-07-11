# Upstream

## Правильный upstream

**Repo:** https://github.com/anomalyco/opencode
**Git remote:** `upstream`
**Latest tag:** v1.17.18 (на момент последнего обновления)
**Version scheme:** v1.x.x (совпадает с npm-пакетами @opencode-ai/*)

## Legacy (не использовать)

~~https://github.com/opencode-ai/opencode~~ — archived, переехал в charmbracelet/crush.  
Не является источником binary/config update.

## Ветки

- `upstream` remote всегда указывает на anomalyco/opencode
- У upstream нет ветки `main` — только `master` или feature-ветки
- Для версионирования используем теги `v1.*`

## Обновление

Перед обновлением:
1. `git fetch upstream --tags`
2. Проверить latest tag: `git tag -l 'v1*' | sort -V | tail -5`
3. Сравнить с текущей версией бинарника: `/home/guber/.opencode/bin/opencode --version`
4. Если версия новее — следовать плану обновления (см. план в OpenStageOrchestrator)
5. После обновления — обновить этот файл с актуальной версией
