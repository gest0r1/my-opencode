# Markdown tool timing — происхождение и пример (20261104)

Статус: **код в feature-ветке OpenChamber, регрессии не выполнены**; пример ниже **синтетический**, не измерение реальной сессии.

## Текущий путь данных

| Поле в Markdown | Достоверный источник | Ограничения |
|---|---|---|
| `session_id`, `call_id`, `name` | OpenCode v2 tool item → `packages/ui/src/lib/opencode/projection.ts::projectToolPart` → `ToolPart` `sessionID/callID/tool` | Это ID **самого** вызова; subagent ID находится в metadata и не подставляется вместо parent session |
| `status` | `ToolState.status`: `pending/running/completed/error` | Отдельный `interrupted` в ToolState отсутствует: native cancellation может стать error, нельзя угадывать причину по строке |
| `started_at` | `part.state.time.start`, UTC ISO-8601 | `projection.ts` использует `wire.time.ran ?? wire.time.created` как start; это **time source caveat**: если нет фактического ran, wire.created может предшествовать исполнению |
| `completed_at` | Только `part.state.time.end` для completed/error, UTC ISO-8601 | `projection.ts` строит `end = wire.time.completed ?? start`. Нулевой интервал при отсутствующем completed мог быть синтетическим, а не измеренным! Требует upstream/schema correction прежде чем считать все 0ms доказанными |
| `duration_ms` | `end - start` только для finished при валидных временах | В running/pending либо при испорченных/отсутствующих timestamp — `unavailable`; UI показывает текущий elapsed отдельно, не persisted final duration |
| `duration_source` | `persisted_tool_state` или `unavailable` | Не считывается с DOM и не рассчитывается по времени следующей команды |
| `next_tool_started_at` | Старт следующего сохранённого tool part **в той же sessionID**, отдельная сортировка для main/каждого child | Используются сохранённые timestamps; не знает удалённых/невыгруженных исторических вызовов |
| `next_tool_start_gap_ms` | `next.start - current.start` | Это приближённая owner next-start метрика; **не** process runtime и не «ожидание теста» |
| `overlaps_next` | `next.start < current.end` | Помечает параллельное наложение call windows, не суммировать их в wall-clock |
| `generated_at`, `timezone` | Клиент, создающий Markdown export, `new Date().toISOString()`, `Intl.DateTimeFormat().resolvedOptions().timeZone` | Экспортное время/зона **не** исходные часы инструмента |
| Process duration / live wait | `gate-runner-cli` / `live-postgres` должны давать отдельные evidence | Экспорт tool part **не умеет** выделить эти величины, в MD не выдумывать |

**UI origin**: `packages/ui/src/components/chat/message/parts/ToolPart.tsx::formatDuration(start,end,now)` показывает persisted finished duration в секундах с точностью до десятых (`(end-start)/1000`), running — счётчик от `Date.now`. Значение `1726.5s` на исходном скриншоте — только иллюстрация конвертации в 1 726 500 ms, не доказательство времени исходного исторического вызова.

**Export owner**: `packages/ui/src/lib/exportSession.ts`; `formatSessionAsMarkdown` и `formatChildSessionAsMarkdown` вызывают общий formatter записи с картой следующего инструмента, сортированной в пределах одной sessionID. Базовый Markdown текст/роль/модель сохраняются, вместо второго renderer добавляются JSON-маркеры tool timing. Случай вызова `formatMessageRecordAsMarkdown` отдельно сохраняет поля текущего инструмента, но следующая команда неизвестна.

## Пример одного синтетического экспорта

```markdown
# Pipeline demo

*Exported on 2026-11-04*

*generated_at: 2026-11-04T20:00:00.000Z; timezone: Europe/Amsterdam; timestamps: UTC ISO-8601*

---

**Assistant**

*... (openai/example)*

Запускаю команду.

**Tool call timing**

```json
{"session_id":"session-main","call_id":"tool-1","name":"shell","status":"completed","started_at":"2026-11-04T19:00:00.000Z","completed_at":"2026-11-04T19:28:46.500Z","duration_ms":1726500,"duration_source":"persisted_tool_state","next_tool_started_at":"2026-11-04T19:28:50.000Z","next_tool_start_gap_ms":1730000,"overlaps_next":false}
```

---

## Sub-agent: Coder — coder

---

**Assistant**

**Tool call timing**

```json
{"session_id":"session-child","call_id":"child-1","name":"shell","status":"running","started_at":"2026-11-04T19:15:00.000Z","completed_at":"unavailable","duration_ms":"unavailable","duration_source":"unavailable","next_tool_started_at":"unavailable","next_tool_start_gap_ms":"unavailable","overlaps_next":"unavailable"}
```
```

Файл-пример иллюстрирует контракт; итоговый реальный export и сверка UI/API с фиксированным историческим tool call отсутствуют до запуска тестов на окружении, доступном для OpenChamber.
