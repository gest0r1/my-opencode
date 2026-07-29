---
name: corporate-mail
description: "Правила работы с корпоративной почтой Exchange (Fresh-Logic):
  перемещение цепочек писем, поиск в подпапках, оформление писем. Использовать
  когда задача связана с почтой Exchange, перемещением писем, поиском в папках,
  форматированием писем, правилами оформления. НЕ использовать для Bitrix24,
  Яндекс.Почты, Gmail — только Exchange."
---

# Corporate Mail — работа с корпоративной почтой Exchange

## Подключение

Exchange MCP сервер уже настроен в opencode.json: `mcp.exchange` → `http://localhost:8001/sse`.

Агент имеет доступ к инструментам `exchange_*`:
- `exchange_search_emails` — поиск писем
- `exchange_list_folders` — дерево папок
- `exchange_find_folder` — поиск папок по имени
- `exchange_move_email` — перемещение писем
- `exchange_get_email_details` — детали письма
- `exchange_search_by_conversation` — поиск по цепочке

---

## 1. Перемещение цепочек писем

### Проблема

При перемещении письма через `exchange_move_email` **message_id меняется**.
Старый ID после перемещения недействителен. Для повторных операций нужно
заново искать письмо.

### Решение: move_thread.py

Скрипт-обёртка в `/home/guber/Opencode/scripts/mcp-wrappers/move_thread.py`.

Использовать когда нужно переместить цепочку писем (все RE: письма одной темы)
в другую папку. Скрипт сам находит цепочку, ищет папку, перемещает.

```bash
# Найти папку по имени
python /home/guber/Opencode/scripts/mcp-wrappers/move_thread.py --find-folder "Geely"

# Показать дерево папок (с _префиксными)
python /home/guber/Opencode/scripts/mcp-wrappers/move_thread.py --list-folders

# Переместить цепочку (покажет список + запрос подтверждения)
python /home/guber/Opencode/scripts/mcp-wrappers/move_thread.py \
  --subject "Статусы по заказам" --target "Geely"

# Переместить без запроса (для агента)
python /home/guber/Opencode/scripts/mcp-wrappers/move_thread.py \
  --subject "RE: Договор" --target "Geely" --yes

# Сухой прогон (только показать, не двигать)
python /home/guber/Opencode/scripts/mcp-wrappers/move_thread.py \
  --subject "Статусы по заказам" --target "Geely" --dry-run
```

**Вариант 2 — вручную (через инструменты агента):**

```yaml
1. exchange_find_folder(query: "Geely", match_mode: "contains", include_hidden: true)
   → найти ID папки Geely (Входящие/_проекты/_подключение клиента/Geely)

2. exchange_search_emails(search_query: "тема", search_scope: ["inbox", folder_id])
   → найти все письма цепочки

3. Для каждого письма: exchange_move_email(message_id, destination_folder_id)
   → переместить письмо

4. После move: message_id изменился — заново искать письмо для проверки
```

### Важные моменты

- **Папки с `_`** (например `_подключение клиента`, `_проекты`) — видны только
  через `include_hidden: true` в `list_folders` / `find_folder`
- **message_id мутирует** после `move_email` — всегда используйте свежий ID
- **Вложенные пути** — папка Geely находится по пути
  `Входящие/_проекты/_подключение клиента/Geely`
- **Поиск в подпапках** — `search_emails` по умолчанию ищет только в Inbox.
  Для поиска в подпапке передавайте её ID в `search_scope`

---

## 2. Поиск писем

```yaml
# Поиск в Inbox (по умолчанию)
exchange_search_emails(search_query: "тема", max_results: 30)

# Поиск в конкретной папке (по ID)
exchange_search_emails(
  search_query: "статусы",
  search_scope: ["AAMkAD..."],   # ID папки
  max_results: 50
)

# Поиск по всем папкам
exchange_search_emails(
  search_query: "отчёт",
  search_scope: ["inbox", "sent"],  # имена папок
  mode: "full_text"
)
```

---

## 3. Правила оформления писем

*Добавить позже:* шрифт, размер, подпись, формат подписи, структура письма,
правила для ответов/пересылок, приоритеты и т.д.

---

## 4. Работа с папками

### Структура почты Fresh-Logic

```
Входящие/
  проекты/
    подключение клиента/
      Geely
      ...
    _открытие складов/
    BI, FinTrack, GEMS, HRM, ...
  ГРиП/
    SD/
  другие подразделения/
    СБ/
  сотрудники/
    Мотивация/
  Финансы/
  яя_закупки/
  яя_хаос/
    отчеты/
```

### Получение дерева папок

```yaml
# Через инструменты агента (все папки включая _префиксные)
exchange_list_folders(
  parent_folder: "inbox",
  depth: 5,
  include_hidden: true
)

# Или через скрипт
python /home/guber/Opencode/scripts/mcp-wrappers/move_thread.py --list-folders --depth 5
```

---

## 5. Типовые сценарии

### Переместить всю переписку по проекту в проектную папку

```yaml
1. Найти ID целевой папки:
   exchange_find_folder(query: "Название", include_hidden: true)

2. Показать что будет перемещено:
   python move_thread.py --subject "тема проекта" --target "Название"
   # Скрипт покажет список и запросит подтверждение

3. Для автоматического режима (без запроса) — с флагом --yes:
   python move_thread.py --subject "тема проекта" --target "Название" --yes

4. Если папка не находится по имени — найти ID через --list-folders
   и использовать --target-id
```

### Найти письмо, которое не находится поиском

```yaml
1. exchange_search_emails(search_query: "уникальная фраза из письма", mode: "full_text")
   → поиск по телу письма (не только по теме)

2. Если не найдено — искать в других папках:
   exchange_search_emails(search_query: "...", search_scope: ["folder_id_1", "folder_id_2"])

3. Если письмо было перемещено — проверить `Входящие/_проекты/...`
```

---

## MCP сервер

Exchange MCP сервер: `http://localhost:8001`
Протокол: SSE (Streaming Server-Sent Events)
Аутентификация: `X-API-Key`

Сервер предоставляет 66 инструментов для работы с Exchange:
поиск, перемещение, копирование, удаление писем, управление папками и т.д.