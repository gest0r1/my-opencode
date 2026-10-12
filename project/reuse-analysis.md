# Session reuse: measurement and export

Reuse is an optimization hypothesis. Keep independent reviews fresh and use machine evidence as authority regardless of conversation history.

CoderAgent reuse includes healthy same-work-item continuations at `loop=0` (PARTIAL, advisory corrections, completion redispatch), not only charged repairs. TestEngineer/BuildAgent remain repair-only. The runtime binds the frozen contract/scope and previous machine-persisted result, checks state/evidence/session availability, and falls back fresh for unsafe or legacy entries. Interrupted/error sessions are not treated as healthy merely because their ID exists. Inspect continuation metrics separately from formal repair loops; no cycle budget is charged by resume.

## Collect

Run `/pipeline-run RUN` normally. Runtime records `.tmp/pipelines/RUN/reuse-metrics/events.jsonl` with worker decisions, fallback reasons, call latency, prompt/response sizes, full model-context bytes (including history), model request count/model and tool/read counts; parent reads/tool calls and compactions are recorded separately. Missing telemetry stays unknown. Every gate-runner invocation also appends to `reuse-metrics/gates.jsonl` (purpose, mode, status, duration, commands run, reuse); the report groups it under `gates`, which is where most RUN wall-clock goes. UTF-8 bytes are not tokens, cached tokens or billed cost.

For a fresh-session comparison use `/pipeline-run RUN --no-session-reuse` on a separately planned comparable run. Keep task, model, reasoning, source baseline, acceptance criteria and gates equivalent. Record successful outcomes and repair counts. Ordinary fresh fallback differs from a controlled fresh run; do not treat it as an A/B experiment.

## Export for analysis

From the project worktree:

```bash
node "$HOME/.config/opencode/skills/task-management/scripts/reuse-report.mjs" RUN ./reuse-report
```

The directory contains `summary.json`, `summary.csv` and allowlisted `events.jsonl`. Attach these files to an analysis conversation. Export excludes source contents, prompts, raw tool results, secrets and absolute file paths. Review run/work-item identifiers before sharing if their names are sensitive.

Provider usage is not inferred from bytes. If available, attach a separately reviewed OpenCode session usage export with input/output/reasoning/cache tokens and model/version. Record whether its totals are per turn or cumulative to avoid double counting. Until this evidence exists, report operation counts and time, not token/cost savings.

## Decide

Compare several matched runs, not a single successful loop. Inspect total parent + worker cost, success rate, repairs, latency distribution and fallback reasons. Distinguish provider cache savings from history growth.

- Develop reuse when matched results show lower total measured cost/time without worse acceptance outcomes or repairs.
- Narrow reuse by role/loop when savings concentrate there or later history grows without useful progress.
- Disable with `--no-session-reuse` when matched results worsen or debugging needs independent sessions.
- Fix dispatch/session availability when most eligible repairs fall back; an inactive mechanism cannot demonstrate savings.

No automatic threshold is enabled. The owner decides from exported evidence; the runtime never weakens identity, scope or review freshness to improve a metric.

Agent prompt UTF-8 sizes before/after are in `agent-prompt-sizes.json`; these are configuration sizes, not actual RUN token usage.
