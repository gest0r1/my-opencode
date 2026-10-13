# Session reuse: measurement and export

Reuse is an optimization hypothesis. Keep independent reviews fresh and use machine evidence as authority regardless of conversation history.

CoderAgent reuse includes healthy same-work-item continuations at `loop=0` (PARTIAL, advisory corrections, completion redispatch), not only charged repairs. TestEngineer/BuildAgent remain repair-only. The runtime binds the frozen contract/scope and previous machine-persisted result, checks state/evidence/session availability, and falls back fresh for unsafe or legacy entries. Interrupted/error sessions are not treated as healthy merely because their ID exists. Inspect continuation metrics separately from formal repair loops; no cycle budget is charged by resume.

## Background workers

OpenCode 2.x `subagent` with `background: true` returns at once with "The subagent is working in the background (sessionID: …)". Runtime registers that child as `background`, not `healthy`, waits for the child session to go idle (`session.wait`) and only then marks it reusable. The parent's compact result shows `status: running`, `child_running: true`. A dispatch of the same work item while the child still works goes fresh with `child_still_running`; a watcher lost to a restart is recovered at the next dispatch. Before this, a background acknowledgement was stored as a finished result, which is the most likely reason the RUN `issues-50-57-62-63-68-74` resumed 0 of 77 sessions.

## What the parent sees

Every compact subagent result carries `session_reuse: resumed` or `fresh:<reason>`. Runtime strips any `sessionID` a model passes; only `session_reuse: resumed` proves a continuation. Each dispatch and result also flags `runtime_reload_required` (the distribution on disk differs from what OpenCode loaded, so the running hooks enforce old rules; restart OpenCode) and `runtime_changed_during_run` (OpenCode was restarted with a newer distribution in the middle of this RUN). Both are logged as `runtime_version` events.

## Collect

Run `/pipeline-run RUN` normally. Runtime records `.tmp/pipelines/RUN/reuse-metrics/events.jsonl` with worker decisions, fallback reasons, call latency, prompt/response sizes, full model-context bytes (including history), model request count/model and tool/read counts; parent reads/tool calls and compactions are recorded separately. Missing telemetry stays unknown. Every gate-runner invocation also appends to `reuse-metrics/gates.jsonl` (purpose, mode, status, duration, commands run, reuse); the report groups it under `gates`, which is where most RUN wall-clock goes. UTF-8 bytes are not tokens, cached tokens or billed cost.

For a fresh-session comparison use `/pipeline-run RUN --no-session-reuse` on a separately planned comparable run. Keep task, model, reasoning, source baseline, acceptance criteria and gates equivalent. Record successful outcomes and repair counts. Ordinary fresh fallback differs from a controlled fresh run; do not treat it as an A/B experiment.

## Export for analysis

From the project worktree:

```bash
node "$HOME/.config/opencode/skills/task-management/scripts/reuse-report.mjs" RUN ./reuse-report
```

This is the mandatory last step of every RUN (`pipeline-run.md`, Status semantics). The directory contains `summary.json`, `summary.csv`, `gates.csv` and allowlisted `events.jsonl`. `summary.json` keeps agent session reuse (`groups`, `agents`, `fallback_reasons`) and gate evidence reuse (`gates`) in separate sections; never add them up. Attach these files to an analysis conversation. Export excludes source contents, prompts, raw tool results, secrets and absolute file paths. Review run/work-item identifiers before sharing if their names are sensitive.

Provider usage is not inferred from bytes. If available, attach a separately reviewed OpenCode session usage export with input/output/reasoning/cache tokens and model/version. Record whether its totals are per turn or cumulative to avoid double counting. Until this evidence exists, report operation counts and time, not token/cost savings.

## Decide

Compare several matched runs, not a single successful loop. Inspect total parent + worker cost, success rate, repairs, latency distribution and fallback reasons. Distinguish provider cache savings from history growth.

- Develop reuse when matched results show lower total measured cost/time without worse acceptance outcomes or repairs.
- Narrow reuse by role/loop when savings concentrate there or later history grows without useful progress.
- Disable with `--no-session-reuse` when matched results worsen or debugging needs independent sessions.
- Fix dispatch/session availability when most eligible repairs fall back; an inactive mechanism cannot demonstrate savings.

No automatic threshold is enabled. The owner decides from exported evidence; the runtime never weakens identity, scope or review freshness to improve a metric.

Agent prompt UTF-8 sizes before/after are in `agent-prompt-sizes.json`; these are configuration sizes, not actual RUN token usage.

## Live check on OpenCode 2.0.27

Unit tests drive the hooks with a simulated OpenCode; resume with a real provider has not been measured yet. On the next real RUN, after the first repair cycle or `loop=0` continuation of a CoderAgent work item:

1. `jq '.agents, .fallback_reasons' .tmp/pipelines/RUN/reuse-report/summary.json` (after the closing export, or run the export by hand): `agents.resumed` must be above 0. With background workers, `background_settled` must equal `background_children` once they finished.
2. The resumed dispatch prompt contains `<session_reuse_delta path=…/>` and its compact result says `session_reuse: resumed`.
3. If `resumed` stays 0, the dominant `fallback_reasons` entry names the cause (`no_prior_session`, `child_still_running`, `contract_changed`, `stale_state`, `session_unavailable`, `runtime_reload_required`). Fix that cause before judging savings.
