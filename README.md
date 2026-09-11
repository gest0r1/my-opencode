# my-opencode

Configuration and harness layer around **stock OpenCode**. The repository does not fork or patch OpenCode core.

## Architecture

```text
stock OpenCode
  + my-opencode agents / commands / skills / permissions / MCP / installer
  + OpenChamber UI
```

Primary workflows:

- `OpenAgent` — universal assistant and business/integration work;
- `OpenCoder` — short/local code changes;
- `OpenStageOrchestrator` — full controlled development pipeline.

See [`agents.md`](agents.md) for active role contracts. Historical OAC agents are preserved in branch `archive/legacy-oac-agents-2026-09-11` and are not part of active runtime.

## Runtime paths

Repository source:

```text
config/opencode/agent/       agent definitions in Git
config/opencode/command/     OpenCode commands
config/opencode/skills/      OpenCode skills
config/agents/skills/        agent-compatible skills
config/opencode/opencode.json
```

Installed runtime:

```text
~/.config/opencode/agents/   canonical agent path used by OpenCode and OpenChamber
~/.config/opencode/          config / commands / skills / plugins
~/.agents/skills/            compatible global skills
~/.config/opencode.env       runtime integration secrets/settings
~/.local/share/opencode/auth.json  OpenCode-managed LLM auth
```

The old managed `~/.opencode/agent/` directory is removed by the installer to prevent duplicate agent definitions.

## Installation / update

`install.sh`:

1. installs/updates OpenCode using the official installer;
2. downloads an immutable snapshot of this repository/reference from GitHub;
3. replaces only directories managed by `my-opencode`, removing stale files deleted from Git;
4. normalizes agent definitions into `~/.config/opencode/agents/`;
5. installs shared skills;
6. preserves the existing runtime secret file instead of overwriting it.

Example:

```bash
OPENCODE_CONFIG_REPO=gest0r1/my-opencode \
OPENCODE_CONFIG_REF=main \
bash install.sh
```

`install-openchamber.sh` installs/updates this configuration first and then the configured OpenChamber build.

## Credentials

LLM/provider authentication is managed by stock OpenCode via:

```text
opencode auth login
~/.local/share/opencode/auth.json
```

Do not put OpenAI/OpenCode API credentials into the repository env file.

MCP/integration credentials referenced by `opencode.json` use `{env:...}` placeholders and live only in:

```text
~/.config/opencode.env
```

Use `config/opencode.env.example` as the list of supported variables. Historical literal credentials that ever existed in Git history must be considered compromised until revoked/reissued by the external provider.

## OpenStage pipeline

The full pipeline is intentionally retained:

```text
Context/intake
→ user stories
→ independent story review
→ architecture + contracts + priorities
→ ADR
→ independent technical-plan review
→ task graph
→ implementation
→ build sanity
→ independent code review
→ technical fix loops
→ tests/integration
→ release validation when relevant
→ documentation when relevant
→ handoff
```

Role prompts are model-independent. Model allocation is runtime policy and can change without changing the role contract.

### Session reuse

OpenCode's native `task_id` resumes a known child session. `plugins/pipeline-runtime.ts` is retained only as the semantic routing/safety layer needed to decide which exact logical work item may reuse which native task ID, including parallel same-role tasks.

Logical identity:

```text
{run_id, pipeline_id, stage, role, work_item_id}
```

Reuse is limited to `CoderAgent`, `BuildAgent`, and `TestEngineer` technical-fix loops for the same exact work item. Review/planning sessions remain fresh.

## Model fallback

There is no custom fallback implementation. Do not patch OpenCode core or add a local routing layer solely to emulate model fallback. Use fallback only if/when stock OpenCode exposes supported semantics for it.

## Context policy

Project `AGENTS.md`, scoped skills and directly relevant files are preferred. The remaining global `config/opencode/context/` files are optional references and must be discovered on demand; they are not preloaded as a global context corpus.

## Safety model

- tools/permissions are the hard boundary;
- planning/review/build roles are read-only for product source;
- TestEngineer writes tests/fixtures only;
- DevOps uses a narrow non-destructive command allowlist;
- business MCP tools are denied globally and explicitly exposed to `OpenAgent`;
- development agents cannot write secret files;
- the pipeline does not rely on a specific LLM following prose perfectly.
