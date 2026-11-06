# Pipeline optimization — handoff for isolated testing

**Scope:** `my-opencode` + `openchamber-ru` feature branches, not `main`. This is a **test handoff**, not a merge/release approval. Source changes are not installed on any running server. Full task remains partially blocked by upstream/pin integration.

## Canonical inputs

- Source: [my-opencode feature](https://github.com/gest0r1/my-opencode/tree/feature/pipeline-optimization-20261104), base `main@c58f452047df3806ea6e946d1909b075344bc069`. Tester must record the **current immutable HEAD SHA** before running; the HEAD at handoff is written in `REPORT.md`.
- UI: [openchamber-ru feature](https://github.com/gest0r1/openchamber-ru/tree/feature/pipeline-optimization-20261104), HEAD `06afd56dffe3e0fc0c2863d0017ae243b037cc1b`, base `main@f9521f168c894cb17dc60ba4f929d4df0722e263`.
- Current pins in feature (not target upgrade): `@opencode/plugin 2.1.4`, `tsx 4.23.15` from `config/opencode/package.json`; OpenChamber monorepo `2.5.2`, `bun@1.4.4` declared in its package.json. Do **not** assume these are installed versions.
- Upstream review targets: OpenChamber `v2.6.1@ce853f415704d1bfe8d076a5cfb2caabac00fffd`, OpenCode `v2.2.5@9bbb8ce18c80f099e0e448775f59d965ead40a21`. **Not merged or pinned.** Exact conflict metadata: `handoff-assets/upstream-conflicts-20261105/manifest.jsonl`. This dependency must be resolved in a separate, fully checked feature worktree before declaring the entire optimization complete.
- Primary status: [REPORT.md](REPORT.md); decisions: [DECISIONS.md](DECISIONS.md).
- Timing documentation: [OpenChamber timing evidence](https://github.com/gest0r1/openchamber-ru/blob/feature/pipeline-optimization-20261104/project/pipeline-optimization-20261104/timing-evidence.md); [explicitly synthetic nested export example](artifacts/markdown-timing-synthetic.md).

## Changes since the independent review on 2026-11-06

The reviewer examined source `891a5c53d0fd3325e208402cf48fee5cdddc8c55` and found **three genuine safety failures** plus two faulty fixtures and report drift. All former PASS/FAIL totals belong to that **older source**, not to the current feature HEAD. [Review and native reproductions](reviews/20261106/REVIEW.md).

- **F1 — false PASS reuse:** run `gate-runner-cli.test.mjs` test `nested ignored local config change invalidates actual cached PASS in same runner`; gate must reexecute after `.local-config/nested/mode.txt` bytes change, with no PASS reuse. Run `gate-snapshot-inputs.test.mjs`, `gate-reuse-identity.test.mjs` and `gate-snapshot.test.mjs` for membership/add/remove/rename, symlink, and snapshot copy. Keep control: unchanged verified local pnpm toolchain still reuses.
- **F2 — RUN lifecycle preflight:** run `gate-runner-cli.test.mjs` test `RUN preflight rejects before expensive commands or Docker`; require rejected preflight → no attempt evidence, scratch, expensive commands, Docker or lingering owned locks. Verify positive normal/advisory RUN and existing `PLAN live probe validates` cases, including phase, candidate, held lock PID and cleanup.
- **F3 — installed SHA identity:** run `dev-deploy-cli.test.mjs`: canonical current top-level `status.sha` must match published candidate exactly. `requested_sha`/message/history must not count; reject missing/ambiguous/malformed running identity and changed status; verify both `record` and `verifyDeployedServiceGate`.
- **F4/F5 — fixtures:** `gate-testing-policy.test.mjs` now fully renames `assemble` to `release-assemble` and explicitly tests rejected orphan owner. `gate-snapshot.test.mjs` provides pinned project manager and `.bin/vitest` rather than expecting reuse without toolchain proof.
- **F6 — reports:** current [REPORT.md](REPORT.md) is the single status snapshot, with old audit in `runs/` and Git. [UPSTREAM_PREPARATION.md](UPSTREAM_PREPARATION.md) describes verified tags, deleted workflows and the **unresolved** merge requirement.

**Current source tests are NOT RUN by the implementing agent.** Do not copy `158 PASS/3 FAIL/1 SKIP` from the reviewed old SHA, or infer native PASS from parser checks.

## Test environment

Use fresh **isolated** checkouts of both refs, not current production RUN or active project worktrees. Preserve the original branch refs and working trees; use detached checkout or separate worktree for tests. No GitHub Actions, deploy, release, privileged Docker against an existing database or service restart. Record `git rev-parse HEAD`, `git status --porcelain`, `node --version`, `bun --version` and installed runtime/plugin version. Fetch/install dependencies only in the isolated environment using the repository's own lockfiles.

### my-opencode: focused gates and runtime

From the my-opencode checkout root:

```bash
bash tests/test_contextscout_installation.sh
node --test config/opencode/skills/task-management/scripts/build-output-proof.test.mjs
node --test config/opencode/skills/task-management/scripts/gate-testing-policy.test.mjs
node --test config/opencode/skills/task-management/scripts/gate-snapshot-inputs.test.mjs
node --test config/opencode/skills/task-management/scripts/gate-reuse-identity.test.mjs
node --test config/opencode/skills/task-management/scripts/gate-runner-cli.test.mjs
node --test config/opencode/skills/task-management/scripts/gate-snapshot.test.mjs
node --test config/opencode/skills/task-management/scripts/dev-deploy-cli.test.mjs
node --test config/opencode/skills/task-management/scripts/reuse-report.test.mjs
node --test config/opencode/skills/task-management/scripts/orchestrator-wake.test.mjs
node --test config/opencode/skills/task-management/scripts/pipeline-runtime.test.mjs
node --test config/opencode/skills/task-management/scripts/pipeline-v2-contract.test.mjs
node --test config/opencode/skills/task-management/scripts/plan-probe-identity.test.mjs
```

Runner tests invoke `npx --yes tsx` and require the repo's pinned toolchain. On an offline environment, record **BLOCKED/dependency unavailable** rather than passing tests using ad-hoc module stubs.

Verify negative and positive cases explicitly: producer/consumer file SHA, changed/replaced artifact after producer PASS, missing/foreign producer evidence, identical tree reuse, changed ignored local inputs, disposable DB recreation and cleanup, failed/retried wake, unknown background child retained, independent lane resumes. After focused checks, run the project-defined affected/complete validation for the actual package set and record elapsed times.

### OpenChamber timing/runtime and pins

From the openchamber-ru feature checkout root, with its declared `bun@1.4.4` toolchain:

```bash
bun test packages/ui/src/lib/exportSession.timing.test.ts packages/ui/src/lib/fullSessionExport.test.ts
bun run check:changed
bun run type-check
bun run build
```

Before any future **OpenChamber source commit**, `bun run check:changed` must pass as required by its `AGENTS.md`. Test nested child export, running/error/interrupted and legacy timing, parallel call overlaps, 1,726,500 ms, exact `session_id/call_id`, generated_at/timezone and UI seconds parity. Pin checker and upstream integration must be run only after compatible sources/lockfiles have been prepared and verified.

### Cross-repo acceptance and rollback (no production)

1. Run the same PLAN fixture on the frozen refs and confirm ContextScout can write within `.tmp/pipelines/**/planning/**` but cannot write runtime state or protected probes.
2. Approve a narrow baseline without initiating RUN; a separate explicit RUN intent is required. Verify unchanged technical carry, rejected stale approval and GitHub comment audit.
3. Execute two independent lanes with shared and disjoint paths. Check prep `required_by`, no duplicate owner checkpoint, no duplicate child dispatch, no stuck RUN after background child completion; observe real model/session ID if the SDK exposes it.
4. Run local tree, candidate, **build-output** and deployed-service fixture gates under disposable test resources only. Verify per-command PASS reuse and **non-reuse** of live/service/build artifact checks, cleanup after failure and verified artifact SHA before/after consumer.
5. Export parent/child Markdown session timing and compare with the test fixture above. Missing endpoints must remain unavailable rather than made-up zeros.
6. Test installer **only into a temporary directory**, then verify the pre-install local ref/config can be restored without rewriting `main` or affecting other users. Do not run a server update to verify rollback.

## Blocking facts / acceptance threshold

- For **old source** the previous handoff included build-output unit tests (2/2) and isolated policy cases; review on `891a5c53...` reported `158 PASS / 3 FAIL / 1 SKIP` followed by a separate environment fix recheck. **None of these results validates the new F1–F5 source.** The current native Node/tsx regression suite is **NOT RUN**.
- Recent runner, OpenCode SDK and Bun tests are **NOT RUN**, not green. Any failure must be recorded with exact source SHA, command, exit code, environment and short logs in a new run report.
- OpenChamber upstream is **not merged**: 98 both-modified text inputs, including 18 conflicting files, plus 6 delete/modify choices at the historical target; required Bun validation is unavailable here.
- Actual cost improvement (wall-clock, tokens, reviewer invocations) is not measured on comparable PLAN/RUN inputs; no numerical benefit is claimed.

**F1–F5 source changes are available for independent isolated review/testing. Upstream source merge, target package pins, Bun and final integration are NOT DONE. No merge/release/installation acceptance.**
