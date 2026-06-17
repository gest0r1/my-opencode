| # | Агент | Тип | Описание | Модель | Temp | Top_p | Права (кратко) |
|---|-------|-----|----------|--------|------|-------|----------------|
| 1 | OpenAgent | primary | Universal agent — вопросы, задачи, координация | **opencode-go/deepseek-v4-flash** | 0.2 | — | bash: ask (rm -rf/sudo/deny /dev); edit: deny .env/.key/.secret/node_modules/.git |
| 2 | OpenCoder | primary | Orchestration — архитектура, рефакторинг, параллельное исполнение | **opencode-go/deepseek-v4-pro** | 0.1 | — | bash: ask (rm -rf/sudo/chmod/curl/wget/docker/kubectl); edit: deny .env/.key/.secret/node_modules/pycache/.pyc/.git |
| 3 | OpenStageOrchestrator | primary | Сложные feature: user story → senior review → архитектура → implementation → build → review → tests → docs → handoff | **opencode-go/deepseek-v4-pro** | 0.1 | — | bash: ask (stage-cli/task-cli/router allow); edit/write: deny .env/.key/.secret/node_modules/.git; task: все основные subagents allow |
| 4 | build | system | Дефолтный агент. Выполняет инструменты по permissions | **opencode-go/deepseek-v4-flash** | — | — | doom_loop: ask; external_directory: allow (opencode/skills/); read: ask .env; plan_exit/task/context7_/exa_*/gh_grep_*/webfetch: deny |
| 5 | explore | system | Быстрое исследование кодовой базы | **opencode-go/deepseek-v4-flash** | — | — | read-only (исследование) |
| 6 | general | system | Универсальный агент для исследования и анализа | **opencode-go/qwen3.7-plus** | — | — | базовые permissions |
| 7 | plan | system | Режим планирования, запрещает edit/write | **opencode-go/deepseek-v4-pro** | — | — | edit: deny all; write: deny all; bash: ask |
| 8 | ContextScout | subagent | Discovery контекстных файлов, ранжирование | **opencode-go/deepseek-v4-flash** | — | — | read/grep/glob: allow; bash/edit/write/task: deny |
| 9 | ExternalScout | subagent | Документация внешних библиотек (MCP) | **opencode-go/deepseek-v4-flash** | — | — | (определяется через OpenAgent/OpenCoder routing) |
| 10 | TaskManager | subagent | JSON-driven декомпозиция фич в subtask-и | **opencode-go/deepseek-v4-flash** | 0.1 | — | bash: deny (task-cli/mkdir/mv allow); edit: deny .env/.key/.secret/node_modules/.git; task: contextscout/externalscout allow; skill: task-management allow |
| 11 | CoderAgent | subagent | Исполнение кодинг-задач, self-review | **opencode-go/mimo-v2.5** | 0 | — | bash: deny (router.sh complete/status allow); edit: deny .env/.key/.secret/node_modules/.git; task: contextscout/externalscout/TestEngineer allow |
| 12 | CodeReviewer | subagent | Code review — безопасность, качество, read-only | **openai/gpt-5.5** | 0.1 | — | bash/edit/write: deny all; task: contextscout allow |
| 13 | TestEngineer | subagent | TDD, тестирование (vitest/jest/pytest/go/cargo/bun) | **opencode-go/deepseek-v4-flash** | 0.1 | — | bash: test-runners allow (rm -rf ask, sudo deny); edit: deny .env/.key/.secret; task: contextscout/externalscout allow |
| 14 | BuildAgent | subagent | Type check, сборка (tsc/mypy/go/cargo/npm) | **opencode-go/deepseek-v4-flash** | 0.1 | — | bash: only build-commands allow; edit/write: deny all; task: contextscout allow |
| 15 | DocWriter | subagent | Документация, markdown-файлы | **opencode-go/deepseek-v4-flash** | 0.2 | — | bash: deny; edit: .md allow; task: contextscout allow |
| 16 | ContextOrganizer | subagent | Управление контекстом: harvest/extract/organize/update/create | **opencode-go/deepseek-v4-flash** | — | — | (определён в command/context.md и system-builder) |
| 17 | OpenDevopsSpecialist | subagent | CI/CD, инфраструктура, деплой (docker/k8s/terraform) | **opencode-go/deepseek-v4-pro** | 0.1 | — | bash: docker/kubectl/terraform/npm allow; edit: deny .env/.key/.secret; task: contextscout allow |
| 18 | OpenFrontendSpecialist | subagent | UI/дизайн, темы, анимации, design-системы | **opencode-go/minimax-m3** | 0.2 | — | write: deny .ts/.js/.py; edit: .html/.css в design_iterations allow; task: contextscout/externalscout allow |
| 19 | BatchExecutor | subagent | Параллельное выполнение батчей (5+ задач) | **opencode-go/mimo-v2.5** | 0.1 | — | bash: deny (task-cli allow); edit: deny .env/.key/.secret/node_modules/.git; task: contextscout/externalscout/coderagent allow |
| 20 | ContextManager | subagent | Lifecycle контекста: discover/catalog/validate/propose/maintain | **opencode-go/deepseek-v4-flash** | 0.1 | — | read/grep/glob: allow; bash: find/ls/mkdir/mv .opencode/context allow; edit/write: .opencode/context/** allow; task: contextscout allow |
| 21 | ContextRetriever | subagent | Поиск и навигация по контексту через navigation.md | **opencode-go/deepseek-v4-flash** | — | — | read/grep/glob: allow; bash/edit/write: deny |
| 22 | StoryMapper | subagent | User journey mapping, epics, stories, vertical slices | **opencode-go/deepseek-v4-flash** | 0.1 | — | bash: deny; edit: deny .env/.key/.secret/node_modules/.git; task: contextscout/externalscout allow |
| 23 | ArchitectureAnalyzer | subagent | DDD-driven анализ: bounded contexts, module boundaries, aggregates | **opencode-go/deepseek-v4-pro** | 0.2 | — | bash: deny (mkdir .tmp/architecture allow); edit: deny .env/.key/.secret/node_modules/.git; task: contextscout/externalscout allow |
| 24 | ContractManager | subagent | API contract management, contract-first design (OpenAPI/Swagger) | **opencode-go/deepseek-v4-pro** | 0.1 | — | bash: deny (mkdir .tmp/contracts allow); edit: deny .env/.key/.secret/node_modules/.git; task: contextscout/externalscout allow |
| 25 | PrioritizationEngine | subagent | RICE/WSJF scoring, MVP identification, release slicing | **opencode-go/deepseek-v4-flash** | 0.1 | — | bash: deny; edit: deny .env/.key/.secret/node_modules/.git; task: contextscout allow |
| 26 | ADRManager | subagent | Architecture Decision Records: создание/поиск/обновление ADR | **opencode-go/deepseek-v4-pro** | — | — | bash: deny (mkdir docs/adr allow); edit: docs/adr/** allow; task: contextscout allow |
| 27 | AgentGenerator | subagent | Генерация scaffolding новых агентов | **opencode-go/deepseek-v4-pro** | — | — | bash/edit: deny; task: contextscout allow |
| 28 | CommandCreator | subagent | Генерация scaffolding команд | **opencode-go/deepseek-v4-pro** | — | — | bash/edit: deny; task: contextscout allow |
| 29 | DomainAnalyzer | subagent | Анализ домена и bounded contexts | **opencode-go/deepseek-v4-pro** | — | — | bash/edit: deny; task: contextscout allow |
| 30 | WorkflowDesigner | subagent | Дизайн workflow и orchestration | **opencode-go/deepseek-v4-pro** | — | — | bash/edit: deny; task: contextscout allow |
| 31 | ImageSpecialist | subagent | Работа с изображениями (editing/generation через Gemini) | **google/gemini-2.5-flash** | — | — | bash: deny; edit: deny; task: contextscout allow; gemini: allow |
| 32 | SimpleResponder | subagent | Базовый responder для тестирования | **opencode-go/deepseek-v4-flash** | — | — | минимальные permissions |
| 33 | SeniorStoryReviewer | subagent | Senior review user stories — полнота, edge cases, противоречия | **openai/gpt-5.5** | 0.1 | — | read/grep/glob: allow; bash/edit/write: deny; task: deny |
| 34 | SeniorTechnicalPlanReviewer | subagent | Senior review архитектуры, контрактов, dependencies, рисков | **openai/gpt-5.5** | 0.1 | — | read/grep/glob: allow; bash/edit/write: deny; task: deny |
| 35 | OpenRepoManager | primary | Управление репозиторием: git, PR, issues, releases | **opencode-go/deepseek-v4-flash** | — | — | базовые permissions |
| 36 | OpenSystemBuilder | primary | Генерация и scaffold систем и агентов | **opencode-go/deepseek-v4-pro** | — | — | базовые permissions |
| 37 | OpenCopywriter | primary | Маркетинговый контент | **opencode-go/deepseek-v4-flash** | — | — | базовые permissions |
| 38 | OpenTechnicalWriter | primary | Техническая документация | **opencode-go/deepseek-v4-flash** | — | — | базовые permissions |
| 39 | OpenDataAnalyst | primary | Анализ данных, визуализация | **opencode-go/deepseek-v4-pro** | — | — | базовые permissions |
| 40 | eval-runner | system | Testing/evaluation quality gate | **opencode-go/deepseek-v4-flash** | — | — | context:standards-tests dependency |

## Сводка моделей

| Модель | Агенты |
|--------|--------|
| **openai/gpt-5.5** | CodeReviewer, SeniorStoryReviewer, SeniorTechnicalPlanReviewer |
| **opencode-go/mimo-v2.5** | CoderAgent, BatchExecutor |
| **opencode-go/deepseek-v4-pro** | OpenCoder, OpenStageOrchestrator, plan, OpenDevopsSpecialist, ArchitectureAnalyzer, ContractManager, ADRManager, AgentGenerator, CommandCreator, DomainAnalyzer, WorkflowDesigner, OpenSystemBuilder, OpenDataAnalyst |
| **opencode-go/deepseek-v4-flash** | OpenAgent, build, explore, ContextScout, ExternalScout, TaskManager, TestEngineer, BuildAgent, DocWriter, ContextOrganizer, ContextManager, ContextRetriever, StoryMapper, PrioritizationEngine, SimpleResponder, OpenRepoManager, OpenCopywriter, OpenTechnicalWriter, eval-runner |
| **opencode-go/qwen3.7-plus** | general |
| **google/gemini-2.5-flash** | ImageSpecialist |
| **opencode-go/minimax-m3** | OpenFrontendSpecialist |

## Источники

| Путь | Тип |
|------|-----|
| `~/.config/opencode/agents/*.md` | Модель задана явно в frontmatter |
| `~/.config/opencode/agent/core/*.md` | Primary agents (модель задана в frontmatter) |
| `~/.config/opencode/agent/subagents/**/*.md` | Subagents (модель задана в frontmatter) |
| `~/.config/opencode/agent/meta/*.md` | Meta agents (модель задана в frontmatter) |
| `~/.config/opencode/agent/content/*.md` | Content agents (модель задана в frontmatter) |
| `~/.config/opencode/agent/data/*.md` | Data agents (модель задана в frontmatter) |
| `~/.config/opencode/opencode.json` | Global: model=qwen3.7-plus, small_model=deepseek-v4-flash |
