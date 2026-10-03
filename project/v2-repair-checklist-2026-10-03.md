# V2 repair checklist — 2026-10-03

Branches: `my-opencode:upgrade/opencode-v2`; `openchamber-ru:upgrade/openchamber-2.1.0`. No merge to main. Chat width 80% excluded; no UI edits.

## Cycle 1 — permissions/delegation

- Changed: source Markdown/config normalization; exact flat agent IDs; catch-all ordering; installation materializes `$HOME`, `${HOME}` and the installation user's absolute trusted CLI path without general shell allows.
- Checks: all 38 source agents normalize with `markdown_changed=0 / config_changes=0`; protected-path and migration tests pass; GitHub installer contract and real V2 catalog/permissions smoke pass.
- Commit: `330fa1fefae76ffad25c9ec609ed9d231eacfa3f`.
- Remaining: cycles 2–3.

## Cycle 2 — frozen RUN and PR CI

- Changed: effective-view legacy schema-v2 migration from a SHA-authenticated snapshot; explicit repair error if recovery is impossible; refresh no longer requires the retired snapshot for a modern RUN; PR/head/base/merge mapping and stage evidence validation; existing push strictness retained.
- Checks: 193 local tests pass; GitHub Pipeline contracts and real V2 smoke pass for the commit below.
- Commit: `7ef71a9fe50c1f219e61509b7ec0796e97c1d698`.
- Remaining: cycle 3.

## Cycle 3 — capabilities/native tools/no-op

- Changed: live capability preflight checks tools, exact worker IDs, skills and delegation permissions; no permission fallback. Handoff tools register through native V2 Plugin API; legacy dependency removed. Managed-source fingerprint plus installed-file receipt protects no-op decisions for standalone and OpenChamber installation.
- Checks: native V2 plugin/tool registration and missing-delegation negative check; local regression suite; binary-only, no-op, config-only, immutable-runtime and installer checks. Exact repeat installation is additionally tested by real V2 live smoke.
- Commit: `9de9352c5ff724e5a71f80a2b14f1f4b87b1110b`; final prompt correction is included in code SHA `cff7f28e74b3834a771fa7d9cebb8e539a6c1bfb`.
- Final correction: agent examples now use `subagent(agent=...)`; StageOrchestrator no longer recommends invalid metadata aliases or a primary-agent target. Added regression check over all installed agent prompts.
- Checks: 198 local tests pass. All 38 agents normalize with `markdown_changed=0 / config_changes=0`. Pipeline CI and real V2 live smoke, including identical no-op installation, pass for final code SHA `cff7f28e74b3834a771fa7d9cebb8e539a6c1bfb`. Installer CI passed for `9de9352` (installer code unchanged by the final prompt correction).
- CI evidence: [Pipeline contracts](https://github.com/gest0r1/my-opencode/actions/runs/37117271639), [V2 live smoke + no-op](https://github.com/gest0r1/my-opencode/actions/runs/37117271642), [Installer contract](https://github.com/gest0r1/my-opencode/actions/runs/37117012636).
- Remaining functional changes: none. Real model-driven worker turns and user-host upgrade are not performed by these registration/permission smoke tests.

## Installation

```bash
gh api -H 'Accept: application/vnd.github.raw' 'repos/gest0r1/my-opencode/contents/install-openchamber.sh?ref=upgrade/opencode-v2' | OPENCODE_CONFIG_REF=upgrade/opencode-v2 OPENCHAMBER_REF=upgrade/openchamber-2.1.0 bash
```

Existing V2 installations need no cleanup. V1 cleanup stays a separate explicit command and is not embedded in the installer.

## Cycle 4 — always refresh settings; bounded dependency installation

- Supersedes the config no-op policy in cycle 3 by explicit owner decision: every invocation downloads the exact config SHA, stages the full settings/skills tree and validates plugins. No source fingerprint or installed-file receipt controls a config skip. Unchanged OpenCode binary and OpenChamber runtime packages remain reusable.
- Changed: committed `config/opencode/bun.lock`; dependency installation uses `--production --frozen-lockfile`. Default total deadline 300 seconds (`OPENCODE_DEPENDENCY_TIMEOUT_SECONDS`), force termination grace 5 seconds, progress every 15 seconds. Detailed log is overwritten at `~/.local/state/my-opencode/opencode-dependency-install.log` (XDG_STATE_HOME honored). Cancellation is diagnosed separately from activation failure.
- Checks: all 195 pipeline tests pass locally using the installed tsx loader (CLI IPC sockets are unavailable in this environment); 3 helper tests and installer/runtime/agent regressions pass. Real Bun 1.4.2 installs the frozen dependency graph and imports both V2 plugins. Negative tests cover dependency failure, timeout, cancellation and log replacement; full generation timeout preserves active config/skills/binary and removes both staging directories. Updated live CI verifies repeat full config installation with binary reuse.
- Code commit: `c485190cccf95f730f8d10a2da0199f2c7fa219e`.
- GitHub CI: [installer contracts](https://github.com/gest0r1/my-opencode/actions/runs/37119242418) and [real V2 install, 38 agents/permissions and repeat full config refresh with binary reuse](https://github.com/gest0r1/my-opencode/actions/runs/37119242353) passed.
- Remaining: execution on the user's server. A deadline bounds waiting, but cannot guarantee registry/network availability.
