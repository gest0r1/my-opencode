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

## Upstream

Правильный upstream: `https://github.com/anomalyco/opencode` (см. `project/upstream.md`).
~~`opencode-ai/opencode`~~ — archived, не использовать.
