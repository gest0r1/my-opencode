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
- Commit: `9de9352c5ff724e5a71f80a2b14f1f4b87b1110b`; final prompt correction is the commit containing this updated checklist.
- Final correction: agent examples now use `subagent(agent=...)`; StageOrchestrator no longer recommends invalid metadata aliases or a primary-agent target. Added regression check over all installed agent prompts.
- Checks: 197 local tests before prompt correction; installer CI, Pipeline CI and real V2 smoke (including identical no-op installation) passed for `9de9352`. Final prompt regression and all 38 agents’ source normalization passed locally; CI runs for the correction commit.
- Remaining functional changes: none. Real model-driven worker turns and user-host upgrade are not performed by these registration/permission smoke tests.

## Installation

```bash
gh api -H 'Accept: application/vnd.github.raw' 'repos/gest0r1/my-opencode/contents/install-openchamber.sh?ref=upgrade/opencode-v2' | OPENCODE_CONFIG_REF=upgrade/opencode-v2 OPENCHAMBER_REF=upgrade/openchamber-2.1.0 bash
```

Existing V2 installations need no cleanup. V1 cleanup stays a separate explicit command and is not embedded in the installer.
