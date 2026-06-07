# My Opencode Configuration

Бэкап конфигурации opencode: агенты, плагины, скиллы, systemd-сервис, скрипты.

## Структура

```
config/                          # Глобальная конфигурация opencode
  opencode/                      # ~/.config/opencode/
  systemd/                       # systemd user-юниты
  opencode-web.env.example       # env-файл (секреты в .env, не в git)
project/                         # Проектная конфигурация
  .opencode/                     # bot-project/.opencode/
scripts/                         # Пользовательские скрипты
  opencode-web-reboot/           # Скрипт перезапуска opencode-web сервиса
```

## Восстановление

```bash
# 1. Конфиги opencode
cp -r config/opencode/* ~/.config/opencode/

# 2. systemd сервис
cp config/systemd/opencode-web.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 3. Проектный конфиг
cp -r project/.opencode ~/bot-project/.opencode/

# 4. Скрипты
cp -r scripts ~/Opencode/scripts/

# 5. Секреты
cp config/opencode-web.env.example ~/.config/opencode-web.env
# Отредактировать ~/.config/opencode-web.env, вставить реальные ключи
```
