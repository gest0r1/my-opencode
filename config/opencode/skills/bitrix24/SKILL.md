---
name: bitrix24
description: Работа с Bitrix24: отправка сообщений, cron-рассылка, REST API, управление чатами и проектами
version: 1.0.0
author: opencode
type: skill
category: integrations
tags:
  - bitrix24
  - b24
  - messaging
  - cron
  - im
  - notifications
---

# Bitrix24 Skill

> **Purpose**: Интеграция с Bitrix24: отправка сообщений в чаты, личные диалоги и проекты, отложенная отправка через cron, управление через REST API.

---

## Доступные инструменты

Через MCP доступны следующие инструменты Bitrix24:

| Метод | Назначение |
|-------|-----------|
| `b24_im_message_add` | Отправить личное сообщение пользователю |
| `b24_im_message_to_chat` | Отправить сообщение в групповой чат/канал |
| `b24_user_search` | Найти пользователя по имени/email |
| `b24_user_get` | Получить данные пользователя по ID |
| `b24_user_current` | Получить текущего пользователя (владельца вебхука) |
| `b24_tasks_*` | Работа с задачами |
| `b24_disk_*` | Работа с файлами |

### Вебхук

URL для прямых REST-вызовов:
```
https://freshlogic.bitrix24.ru/rest/54/pfdivgc328bnpzhe/
```

Методы вызываются как `POST {webhook_url}{method}` с JSON-телом.

---

## Отложенная отправка сообщений через cron

### Архитектура

```
configs/bitrix24-cron.json  ──→  scripts/sender.js  ──→  Bitrix24 REST API
                                  │                        (im.message.add)
                                  ├─ JSONL-лог
                                  ├─ идемпотентность (почасово)
                                  ├─ retry (2 попытки, 429/5xx)
                                  ├─ rate-limit (500ms между каналами)
                                  └─ exit code 0/1
                                          │
                                   systemd timer / cron
```

### Файлы (в корне проекта)

| Файл | Назначение |
|------|-----------|
| `scripts/sender.js` | Основной скрипт (Node.js, без npm-зависимостей) |
| `configs/bitrix24-cron.json` | Конфигурация каналов |
| `cron/bitrix24-cron-sender.service` | systemd oneshot service |
| `cron/bitrix24-cron-sender.timer` | systemd timer (каждые 5 мин) |
| `cron/INSTALL.md` | Инструкция по установке |
| `logs/cron-sender-bitrix24/` | JSONL-логи отправок |

### Конфигурация (`configs/bitrix24-cron.json`)

```json
{
  "webhook_url": "https://ваш-портал.bitrix24.ru/rest/1/ваш_вебхук/",
  "timezone": "Europe/Moscow",
  "channels": [
    {
      "id": "my-chat",
      "type": "chat",
      "chat_id": "chat123",
      "label": "Название чата",
      "enabled": true
    },
    {
      "id": "my-user",
      "type": "user",
      "user_id": 1,
      "label": "Имя Фамилия",
      "enabled": true
    },
    {
      "id": "my-project",
      "type": "chat",
      "chat_id": "sg1",
      "label": "Название проекта",
      "enabled": true
    }
  ],
  "message": {
    "template": "[ТЕСТ отложенной отправки] Сообщение от агента Opencode. Время: {timestamp}. Канал: {channel}."
  }
}
```

### Использование sender.js

```bash
# Отправить сейчас (--once)
node scripts/sender.js --once

# Отложить на N минут
node scripts/sender.js --once --delay-minutes 10

# Тест без реальной отправки
node scripts/sender.js --dry-run

# Только один канал
node scripts/sender.js --once --force-channel ruslan-gagaev

# Справка
node scripts/sender.js --help
```

### Формат сообщения

Обязательные элементы в каждом сообщении:
- Начинается с `[ТЕСТ отложенной отправки]`
- Содержит `агент Opencode`

Шаблон настраивается в `configs/bitrix24-cron.json`:
- `{timestamp}` — подставляется время отправки
- `{channel}` — подставляется название канала

### JSONL-логи

Путь: `logs/cron-sender-bitrix24/{YYYY-MM-DD}/{execution_id}.jsonl`

Формат записи:
```json
{
  "ts": "2026-06-25T13:27:21.000+03:00",
  "channel_id": "my-channel",
  "channel_label": "Мой канал",
  "status": "success|failed|skipped_duplicate",
  "message_preview": "[ТЕСТ отложенной отправки] ...",
  "b24_message_id": 123456,
  "b24_raw_error": null,
  "duration_ms": 425,
  "retries": 0,
  "idempotency_hit": false
}
```

### Установка systemd timer

```bash
cp cron/bitrix24-cron-sender.service ~/.config/systemd/user/
cp cron/bitrix24-cron-sender.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable bitrix24-cron-sender.timer
systemctl --user start bitrix24-cron-sender.timer
```

---

## REST API — типовые вызовы

### Единый метод для всех типов сообщений: `im.message.add`

```bash
# Личное сообщение пользователю
curl -X POST {webhook_url}im.message.add \
  -H "Content-Type: application/json" \
  -d '{"DIALOG_ID":"1","MESSAGE":"текст"}'

# Групповой чат
curl -X POST {webhook_url}im.message.add \
  -H "Content-Type: application/json" \
  -d '{"DIALOG_ID":"chat123","MESSAGE":"текст"}'

# Workgroup/проект
curl -X POST {webhook_url}im.message.add \
  -H "Content-Type: application/json" \
  -d '{"DIALOG_ID":"sg1","MESSAGE":"текст"}'
```

Параметры:
- `DIALOG_ID` — для пользователя: его user_id (число), для чата: `chat{N}`, для workgroup: `sg{N}`
- `MESSAGE` — текст сообщения (поддерживает HTML)

### Проверка доступности

```bash
curl {webhook_url}b24_user_current
```

### Поиск пользователя

```bash
# Через API
curl -X POST {webhook_url}user.search \
  -H "Content-Type: application/json" \
  -d '{"FILTER":{"NAME":"Иван"}}'

# Через MCP инструмент
b24_user_search name="Иван"
```

### Форматы DIALOG_ID

| Тип | Формат | Пример |
|-----|--------|--------|
| Личный чат | user_id (число) | `1` |
| Групповой чат | `chat{id}` | `chat123` |
| Workgroup/проект | `sg{group_id}` | `sg1` |

---

## Типовые сценарии

### 1. Отправка тестового сообщения

```javascript
// Через MCP
b24_im_message_add({
  to_user_id: 1,
  message: "[ТЕСТ отложенной отправки] Привет! Я — агент Opencode."
});
```

### 2. Отправка в проект из OpenStageOrchestrator

```javascript
b24_im_message_to_chat({
  chat_id: "sg1",
  message: "[ТЕСТ отложенной отправки] Сообщение от агента Opencode."
});
```

### 3. Запланировать отложенную отправку

```bash
node scripts/sender.js --once --delay-minutes 15
```

### 4. Получить логи отправки

```bash
cat logs/cron-sender-bitrix24/$(date +%F)/*.jsonl
```

---

---

## Агенты Bitrix24

Агенты в Bitrix24 (не путать с AI-агентами) — это PHP-функции, которые выполняются по расписанию на стороне портала. В отличие от нашего cron-решения, агенты Bitrix24:
- Работают только когда портал загружен (независимый cron надёжнее)
- Ограничены PHP-окружением Битрикс
- Не имеют доступа к файловой системе сервера

Наше cron-решение использует внешний systemd timer, что даёт:
- Полную независимость от uptime портала Bitrix24
- Детерминированное выполнение
- Полный контроль над retry/logging/monitoring

---

## File Locations

- **Skill**: `.opencode/skills/bitrix24/`
- **Sender script**: `scripts/sender.js`
- **Config**: `configs/bitrix24-cron.json`
- **Systemd**: `cron/bitrix24-cron-sender.service`, `cron/bitrix24-cron-sender.timer`
- **Logs**: `logs/cron-sender-bitrix24/`
- **Install guide**: `cron/INSTALL.md`

---

**Bitrix24 Skill** — интеграция с порталом, отправка сообщений, отложенная cron-рассылка.
