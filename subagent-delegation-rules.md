# Правила вызова субагентов (обновлено 2026-06-16)

---

## OpenAgent

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед любой задачей | **MANDATORY** | Любая bash/write/edit/task операция |
| **ExternalScout** | Внешние библиотеки (npm, pip, gem, cargo) | **MANDATORY** | import/require внешнего пакета, ошибка сборки |
| **TaskManager** | Сложные фичи, 4+ файлов, >60мин | по условию | multi_component, multi_step_dependencies |
| **DocWriter** | Генерация/обновление документации | по запросу | docs-задача |
| **CoderAgent** | Через TaskManager (параллельные батчи) | автоматически | Batch 1-3 из TaskManager |
| **TestEngineer** | Тестирование модуля (1-3 файла, <30мин) | Specialist routing | write tests для модуля |
| **CodeReviewer** | Review кода | Specialist routing | multi-component review |
| **BuildAgent** | Валидация сборки | Specialist routing | build validation |

**Делегирует напрямую** (без TaskManager):
- Простые задачи (1-3 файла, <30мин) → Specialist routing

**Делегирует через TaskManager:**
- Сложные задачи (4+ файлов, >60мин) → TaskManager → CoderAgent (параллельные батчи)

---

## OpenCoder

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед кодингом | **MANDATORY** | Stage 1: Discover |
| **ExternalScout** | Внешние пакеты, ошибки сборки, новые библиотеки | **MANDATORY** | import внешнего пакета |
| **TaskManager** | Сложные фичи (4+ файлов, >60мин) | по условию | Stage 4: Plan |
| **CoderAgent** | Исполнение subtask-ов (1-4 параллельных) | автоматически | Stage 5: Execute (direct) |
| **BatchExecutor** | 5+ параллельных задач | автоматически | Stage 5: Execute (batch) |
| **TestEngineer** | Тестирование после реализации | по условию | Stage 6: ValidateAndHandoff |
| **DocWriter** | Генерация документации | по запросу | docs-задача |

**Делегирует напрямую** (без TaskManager):
- Простые задачи (1-4 файла) → CoderAgent напрямую

**Делегирует через TaskManager:**
- Сложные задачи (4+ файлов) → TaskManager → CoderAgent/BatchExecutor

---

## OpenStageOrchestrator

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед планированием | **MANDATORY** | Stage 2: Context + Intake |
| **ExternalScout** | Внешние пакеты/библиотеки | **MANDATORY** | Stage 2: Context + Intake |
| **StoryMapper** | Формирование user stories, journeys, personas | **MANDATORY** | Stage 3: User Stories + Scenarios |
| **SeniorStoryReviewer** | Senior review user stories (gpt-5.5) | **MANDATORY** | Stage 4: Senior Story Review |
| **ArchitectureAnalyzer** | Архитектурная декомпозиция (DDD) | **MANDATORY** | Stage 6: Architecture + Contracts + Plan |
| **ContractManager** | Определение API/интерфейсных контрактов | **MANDATORY** | Stage 6: Architecture + Contracts + Plan |
| **PrioritizationEngine** | Приоритизация задач (RICE/WSJF) | по условию | Stage 6: Architecture + Contracts + Plan |
| **SeniorTechnicalPlanReviewer** | Senior review архитектуры и плана (gpt-5.5) | **MANDATORY** | Stage 7: Senior Technical Plan Review |
| **TaskManager** | Декомпозиция plan → subtask JSON | **MANDATORY** | Stage 8: Task Breakdown + Test Plan |
| **BatchExecutor** | Параллельное выполнение батчей | по условию | Stage 9: Implementation |
| **CoderAgent** | Исполнение subtask-ов | по условию | Stage 9: Implementation |
| **BuildAgent** | Build sanity check перед code review | **MANDATORY** | Stage 10: Build Sanity Check |
| **CodeReviewer** | Code review после build sanity | **MANDATORY** | Stage 11: Code Review |
| **TestEngineer** | Тесты + интеграция после review | **MANDATORY** | Stage 13: Tests + Integration Validation |
| **DocWriter** | Документация после тестов | по условию | Stage 14: Documentation Update |

**Уникальные правила:**

1. **Startup Policy Check**: Всегда проверяет prompt на `жди верификации userstory пользователем`
   - Если нет → спрашивает явно и ждёт ответа
   - Если да → останавливается после SeniorStoryReviewer
2. **User Story Verification Gate**: Останавливается и показывает user stories на подтверждение
3. **Цикл修正**: Если пользователь меняет stories → повторяет Stage 3-5

---

## StoryMapper

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Перед маппингом историй | по условию | при наличии контекста |
| **ExternalScout** | Внешние паттерны UX/design | по условию | при необходимости |

**Не делегирует** другие subagent-вызовы.

---

## ArchitectureAnalyzer

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Перед анализом архитектуры | по условию | при наличии контекста |
| **ExternalScout** | Внешние архитектурные паттерны | по условию | при необходимости |

**Не делегирует** другие subagent-вызовы.

---

## ContractManager

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Перед определением контрактов | по условию | при наличии контекста |
| **ExternalScout** | Внешние API спецификации | по условию | при необходимости |

**Не делегирует** другие subagent-вызовы.

---

## PrioritizationEngine

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Перед приоритизацией | по условию | при наличии контекста |

**Не делегирует** другие subagent-вызовы.

---

## SeniorStoryReviewer

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| *(нет)* | Read-only, не вызывает других агентов | — | — |

---

## SeniorTechnicalPlanReviewer

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| *(нет)* | Read-only, не вызывает других агентов | — | — |

---

## TaskManager

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Контекст отсутствует или неясен | **MANDATORY** | gaps in standards coverage |
| **ExternalScout** | Внешние библиотеки упомянуты в requirements | по условию | external package in task |
| **ADRManager** | Если существуют ADR в проекте | по условию | docs/adr/ directory |

**Не делегирует** кодинг/тестирование — только создаёт JSON subtask-и.

---

## CoderAgent

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед написанием кода | **MANDATORY** | task JSON не содержит context_files |
| **ExternalScout** | Встречен внешний пакет | **MANDATORY** | import/require внешнего пакета |
| **TestEngineer** | Опционально после реализации | по запросу | после завершения subtask |

**Не делегирует** bash/edit напрямую.

---

## TestEngineer

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед тестированием | **MANDATORY** | test-задача |
| **ExternalScout** | Внешние тестовые библиотеки | по условию | vitest/jest/pytest/go test |

---

## BuildAgent

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед сборкой | **MANDATORY** | build/typecheck task |

---

## CodeReviewer

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед review | **MANDATORY** | review task |

---

## OpenDevopsSpecialist

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед инфраструктурной работой | **MANDATORY** | CI/CD, docker, k8s, terraform |

---

## OpenFrontendSpecialist

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед UI-работой | **MANDATORY** | UI/UX, дизайн, темы |
| **ExternalScout** | Внешние UI-библиотеки | **MANDATORY** | React, Vue, CSS frameworks |

---

## DocWriter

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Всегда перед написанием документации | **MANDATORY** | docs task |

---

## BatchExecutor

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **CoderAgent** | Исполнение каждой подзадачи в батче | **MANDATORY** | parallel batch execution |
| **OpenFrontendSpecialist** | UI-задачи в батче | по условию | frontend subtask |

**Не делегирует** TaskManager/ContextScout — получает plan от вызывающего агента.

---

## ADRManager

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Перед работой с ADR | по условию | архитектурные решения |

---

## ContextManager

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Перед управлением контекстом | **MANDATORY** | context structure work |

---

## ContextRetriever

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| *(нет)* | Read-only, поиск контекста | — | — |

---

## ImageSpecialist

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Перед работой с изображениями | по условию | image tasks |

---

## SimpleResponder

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| *(нет)* | Тестовый responder | — | — |

---

## AgentGenerator / CommandCreator / DomainAnalyzer / WorkflowDesigner

| Субагент | Когда вызывать | Обязательность | Триггер |
|----------|---------------|:--------------:|---------|
| **ContextScout** | Перед генерацией | по условию | system-builder tasks |

---

## Сводка моделей

| Модель | Агенты | Тип использования |
|--------|--------|-------------------|
| **openai/gpt-5.5** | CodeReviewer, SeniorStoryReviewer, SeniorTechnicalPlanReviewer | Старшая модель для review-гейтов |
| **opencode-go/mimo-v2.5** | CoderAgent, BatchExecutor | Основная модель для кодинга |
| **opencode-go/deepseek-v4-pro** | OpenCoder, OpenStageOrchestrator, plan, OpenDevopsSpecialist, ArchitectureAnalyzer, ContractManager, ADRManager, AgentGenerator, CommandCreator, DomainAnalyzer, WorkflowDesigner, OpenSystemBuilder, OpenDataAnalyst | Модель для orchestration, архитектуры и сложного анализа |
| **opencode-go/deepseek-v4-flash** | OpenAgent, build, explore, ContextScout, ExternalScout, TaskManager, TestEngineer, BuildAgent, DocWriter, ContextOrganizer, ContextManager, ContextRetriever, StoryMapper, PrioritizationEngine, SimpleResponder, OpenRepoManager, OpenCopywriter, OpenTechnicalWriter, eval-runner | Быстрая модель для большинства задач |
| **opencode-go/qwen3.7-plus** | general | Универсальный исследовательский агент |
| **google/gemini-2.5-flash** | ImageSpecialist | Работа с изображениями |
| **opencode-go/minimax-m3** | OpenFrontendSpecialist | Frontend/UI дизайн |

---

## Матрица вызовов

```
OpenAgent ──────────┬─→ ContextScout
                    ├─→ ExternalScout
                    ├─→ TaskManager ──→ CoderAgent (parallel)
                    ├─→ CoderAgent (direct)
                    ├─→ TestEngineer
                    ├─→ CodeReviewer
                    ├─→ BuildAgent
                    └─→ DocWriter

OpenCoder ──────────┬─→ ContextScout
                    ├─→ ExternalScout
                    ├─→ TaskManager ──→ CoderAgent / BatchExecutor
                    ├─→ CoderAgent (direct)
                    ├─→ BatchExecutor ──→ CoderAgent (parallel)
                    ├─→ TestEngineer
                    └─→ DocWriter

OpenStageOrchestrator ─┬─→ ContextScout
                       ├─→ ExternalScout
                       ├─→ StoryMapper
                       ├─→ SeniorStoryReviewer (gpt-5.5) ← STOP GATE
                       ├─→ ArchitectureAnalyzer
                       ├─→ ContractManager
                       ├─→ PrioritizationEngine
                       ├─→ SeniorTechnicalPlanReviewer (gpt-5.5) ← STOP GATE
                       ├─→ TaskManager ──→ BatchExecutor ──→ CoderAgent
                       ├─→ BuildAgent
                       ├─→ CodeReviewer
                       ├─→ TestEngineer
                       └─→ DocWriter
```
