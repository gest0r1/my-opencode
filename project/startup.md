# Запуск opencode-web

Всегда запускать только с флагом `--pure`:
```
/home/guber/.opencode/bin/opencode web --port 4096 --hostname 0.0.0.0 --pure
```

Без `--pure` opencode читает все конфиги системы, что приводит к нестабильной работе.

systemd-сервис: `~/.config/systemd/user/opencode-web.service`
Бинарник: `~/.opencode/bin/opencode`
Конфиги: `~/.config/opencode/`

## Правила перезапуска

- ❌ Агент **не** перезапускает сервис самостоятельно
- ✅ Агент даёт пользователю команду на restart
- Команда для restart:
  ```bash
  systemctl --user restart opencode-web
  ```
- Для stop + start раздельно:
  ```bash
  systemctl --user stop opencode-web && \
  systemctl --user start opencode-web
  ```

## Обновление npm-пакетов

**Обязательно при каждом обновлении бинарника из upstream!**

Какие пакеты обновлять:
| Пакет | Путь (runtime) | Путь (backup в repo) |
|-------|---------------|---------------------|
| `@opencode-ai/plugin` | `~/.config/opencode/package.json` | `config/opencode/package.json` |
| `@opencode-ai/sdk` | `~/.config/opencode/package.json` | `config/opencode/package.json` |
| `@opencode-ai/plugin` | `~/.opencode/package.json` | — |

Порядок обновления:
1. Обновить версии в 3 package.json
2. `npm install --prefix ~/.config/opencode --legacy-peer-deps`
3. `npm install --prefix ~/.opencode`
4. Перезапустить opencode-web для применения

**Зачем:** `@opencode-ai/plugin` и `@opencode-ai/sdk` — runtime opencode. Без их обновления новый бинарник может не загружать плагины или работать нестабильно.

## Upstream

Правильный upstream: `https://github.com/anomalyco/opencode` (см. `project/upstream.md`).
~~`opencode-ai/opencode`~~ — archived, не использовать.
