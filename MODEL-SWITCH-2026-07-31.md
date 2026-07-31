# Смена модели субагентов: deepseek-v4-pro → deepseek-v4-flash

**Дата:** 2026-07-31
**Изменение:** `model: opencode-go/deepseek-v4-pro` → `model: opencode-go/deepseek-v4-flash`

## Затронутые агенты (8 субагентов)

| Агент | Файл (runtime) | Было | Стало |
|-------|---------------|------|-------|
| OpenDevopsSpecialist | `~/.config/opencode/agent/subagents/development/devops-specialist.md` | opencode-go/deepseek-v4-pro | opencode-go/deepseek-v4-flash |
| ADRManager | `~/.config/opencode/agent/subagents/planning/adr-manager.md` | opencode-go/deepseek-v4-pro | opencode-go/deepseek-v4-flash |
| ArchitectureAnalyzer | `~/.config/opencode/agent/subagents/planning/architecture-analyzer.md` | opencode-go/deepseek-v4-pro | opencode-go/deepseek-v4-flash |
| ContractManager | `~/.config/opencode/agent/subagents/planning/contract-manager.md` | opencode-go/deepseek-v4-pro | opencode-go/deepseek-v4-flash |
| AgentGenerator | `~/.config/opencode/agent/subagents/system-builder/agent-generator.md` | opencode-go/deepseek-v4-pro | opencode-go/deepseek-v4-flash |
| CommandCreator | `~/.config/opencode/agent/subagents/system-builder/command-creator.md` | opencode-go/deepseek-v4-pro | opencode-go/deepseek-v4-flash |
| DomainAnalyzer | `~/.config/opencode/agent/subagents/system-builder/domain-analyzer.md` | opencode-go/deepseek-v4-pro | opencode-go/deepseek-v4-flash |
| WorkflowDesigner | `~/.config/opencode/agent/subagents/system-builder/workflow-designer.md` | opencode-go/deepseek-v4-pro | opencode-go/deepseek-v4-flash |

## Что изменено в каждом файле

1. Frontmatter: `model: opencode-go/deepseek-v4-pro` → `model: opencode-go/deepseek-v4-flash`
2. Frontmatter `description`: добавлена пометка `Model: opencode-go/deepseek-v4-pro → opencode-go/deepseek-v4-flash`

## Где изменено

Каждый файл изменён в трёх местах:

- **Runtime (рабочий источник):** `~/.opencode/agent/subagents/...` — читает бинарник `~/.opencode/bin/opencode`
- **Global (singular, legacy):** `~/.config/opencode/agent/subagents/...` — дубль той же структуры
- **Git-бэкап:** `/home/guber/Opencode/my-opencode/config/opencode/agent/subagents/...`

> ⚠️ Важно (расследование 2026-08-01): бинарник читает агентов из **install-дира** `~/.opencode/agent/`,
> а не из `~/.config/opencode/agent/` (singular). До 2026-08-01 мы правили только `~/.config` + git —
> изменения не подхватывались. Исправлено: `~/.opencode/agent/**` синхронизирован с `~/.config`.
> Правильная глобальная директория по доке opencode: `~/.config/opencode/agents/` (plural) —
> там наших 8 субагентов нет (лежат в install-дире как часть OAC).

## Действия после изменения

- Перезапустить OpenCode: `systemctl --user restart opencode-web` (или перезапуск клиента)
- Проверить: вызов субагента должен вернуть `opencode-go/deepseek-v4-flash`

## Не затронуто

- Primary/system-агенты с `deepseek-v4-pro` (OpenCoder, OpenStageOrchestrator, plan, OpenSystemBuilder, OpenDataAnalyst и др.) — не менялись
- `models.txt` — каталог доступных моделей, без привязки к агентам; `deepseek-v4-pro` остаётся (используется primary-агентами)

## Справочники (обновлены)

- `agents.md` — 8 строк субагентов + сводка моделей (про → flash)
- `subagent-delegation-rules.md` — сводка моделей (про → flash)
- Изменены в 2 местах: `/home/guber/Opencode/dev/` и `/home/guber/Opencode/my-opencode/`
