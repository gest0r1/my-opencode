# Upstream

## OpenCode

- Источник бинарника: официальный установщик `https://opencode.ai/v2/install`
  с явной версией (`--version`), см. `scripts/install-opencode-generation.sh`.
- Runtime-пакеты плагинов: `@opencode/plugin`, `@opencode/client`, `@opencode/schema`,
  `@opencode/protocol` той же версии, что и бинарник. Пин — в `config/opencode/package.json`
  и `config/opencode/bun.lock`.
- Пакетов `@opencode-ai/*` и ветки 1.x в дистрибутиве больше нет.

## OpenChamber

- Форк: `gest0r1/openchamber-ru`, upstream — `openchamber/openchamber` (remote `upstream`).
- Устанавливаемая версия — `OPENCHAMBER_EXPECTED_VERSION` в `install-openchamber.sh`;
  остальные копии сверяет `scripts/check-opencode-pins.mjs`.

## Обновление

Порядок и проверки — в `project/opencode-updates.md`. Текущие версии — в README
(раздел «Проверка после установки»); `node scripts/check-opencode-pins.mjs` падает, если
какая-то копия пина разошлась.
