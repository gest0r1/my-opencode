# Handoff — OpenStage pipeline

**Date:** 2026-09-14  
**Status:** `/pipeline-plan` is blocked before implementation. No CoderAgent session or source-code change in `otklick` has started.

## Goal

Run a valid design-freeze for:

- project: `/root/projects/otklick`
- run ID: `perf-release-first-v2`

Then obtain explicit owner approval and run:

```text
/pipeline-run perf-release-first-v2 --unattended
```

A hand-made empty manifest is prohibited: RUN must validate real planning, decision and contract artifacts.

## Current blocker

OpenStage can read the project but cannot write planning artifacts:

```text
write .tmp/pipelines/perf-release-first-v2/.write-probe → DENIED
relevant rule: {"permission":"edit","pattern":"*","action":"deny"}
```

This is a `gest0r1/my-opencode` agent-permission defect, not a task/design/git defect.

## Required fix

In the `OpenStageOrchestrator` agent permissions, allow only planning outputs:

```yaml
edit:
  "docs/pipeline-rules.md": allow
  ".tmp/pipelines/**": allow
  "*": deny

write:
  "docs/pipeline-rules.md": allow
  ".tmp/pipelines/**": allow
  "*": deny
```

Also amend `pipeline-plan.md`:

> During PLAN, direct writes are allowed only to `docs/pipeline-rules.md` and `.tmp/pipelines/{run-id}/**`. PLAN must not change source code, `.tmp/tasks`, arbitrary docs, or Git history.

Do **not** permit global edit/write access.

## After the fix

1. Merge the configuration change into `my-opencode/main`.
2. Refresh server config:

   ```bash
   gh api -H "Accept: application/vnd.github.raw" \
     "repos/gest0r1/my-opencode/contents/install-openchamber.sh?ref=main" | bash
   ```

3. Open a **new** OpenStage session (old session retains old permissions).
4. Run `/pipeline-plan`.
5. It must create `docs/pipeline-rules.md`, `.tmp/pipelines/perf-release-first-v2/manifest.json`, state/approval, decision/research/contract artifacts and approved `git_setup`.
6. Owner approves the manifest.
7. Run `/pipeline-run perf-release-first-v2 --unattended`.

## Already merged

Commit `2a002c3fa4a8fea2d7c6ed1521ee9b35b2d4fe88` in `my-opencode` fixes the previous blocker: OpenStage used prohibited arbitrary Bash inspection (`ls`/raw `git`).

It added a read-only `git-worktree-cli.ts inspect`, its exact Bash allowlist, and instructions to use native Read/Glob/Grep plus `inspect`. This is installed; the write-permission blocker appeared afterwards.

## Task facts

```text
repo: /root/projects/otklick
main base SHA: b9cce01e8ac71bc63ca5ad7f7e5fd0011c11651b
run ID: perf-release-first-v2
task validation: PASS
```

Task artifacts already exist:

```text
.tmp/tasks/perf-release-first-v2/task.json
.tmp/tasks/perf-release-first-v2/subtasks/
```

All eight subtasks remain pending.

### git_setup for the future manifest

This object belongs in `.tmp/pipelines/perf-release-first-v2/manifest.json`, **not** `task.json`.

```json
{
  "base_sha": "b9cce01e8ac71bc63ca5ad7f7e5fd0011c11651b",
  "branch": "perf/release-first-v2",
  "source_sha": "d19ce8e7c802db7108345fe062e370f190fc20aa",
  "checkout_paths": [
    "install-update.sh",
    ".env.example",
    ".github/workflows/build-artifact.yml",
    "backend/tests/test_incremental_installer_contract.py",
    "backend/tests/test_build_artifact_contract.py"
  ],
  "must_absent": [
    ".github/workflows/apply-release-first-patch.yml",
    "tools/apply_release_first_patch.py"
  ]
}
```

## Operating constraints

- deterministic gate PASS → continue silently; FAIL → report factual reason;
- no LLM overrides for CI/SHA/git/runtime gates;
- PLAN writes no implementation code;
- do not bypass PLAN by manufacturing a fake manifest;
- OpenStage must not execute arbitrary Bash.
