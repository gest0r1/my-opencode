# Запуск OpenCode

OpenCode работает как user-service systemd по шаблону `config/systemd/opencode-web.service`:
`opencode serve` на `127.0.0.1`, порт `OPENCODE_WEB_PORT` (по умолчанию `4096`), переменные —
из `~/.config/opencode.env`. Шаблон ставит установщик из того же pinned config SHA; вручную
unit не редактировать. OpenChamber запускается своим сервисом `openchamber.service`.

## Правила перезапуска

- Агент **не** перезапускает сервисы сам, а даёт пользователю команду:
  ```bash
  systemctl --user restart opencode-web
  ```

## Обновление OpenCode и runtime-пакетов

Только через установщик и процедуру `project/opencode-updates.md`: версии бинарника и пакетов
`@opencode/*` меняются вместе, lockfile пересобирается Bun. Ручной `npm install` в
`~/.config/opencode` не выполнять — он расходится с `bun.lock`.
