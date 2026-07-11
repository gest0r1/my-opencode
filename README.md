# My Opencode Configuration

Бэкап конфигурации opencode: агенты, плагины, скиллы, systemd-сервис, скрипты.

## Структура

```
config/                          # Глобальная конфигурация opencode
  opencode/                      # ~/.config/opencode/
  systemd/                       # systemd user-юниты
  opencode-web.env.example       # env-файл (секреты в .env, не в git)
scripts/                         # Пользовательские скрипты
  opencode-web-reboot/           # Скрипт перезапуска opencode-web сервиса
```

> Рабочее правило: `~/.config/opencode` — единственный редактируемый конфиг; `~/.opencode` — runtime-установка, вручную не правим.

## Upstream

| Remote | URL | Назначение |
|--------|-----|------------|
| `origin` | `https://github.com/gest0r1/my-opencode.git` | Наш бэкап конфигов |
| `upstream` | `https://github.com/anomalyco/opencode.git` | Исходный код opencode (источник обновлений) |

> ⚠️ **Важно:** Старый upstream `opencode-ai/opencode` — archived/legacy, не использовать.  
> Подробнее: `project/upstream.md`

## Восстановление

```bash
# 1. Конфиги opencode
cp -r config/opencode/* ~/.config/opencode/

# 2. systemd сервис
cp config/systemd/opencode-web.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 3. Скрипты
cp -r scripts ~/Opencode/scripts/

# 4. Секреты
cp config/opencode-web.env.example ~/.config/opencode-web.env
# Отредактировать ~/.config/opencode-web.env, вставить реальные ключи
```
