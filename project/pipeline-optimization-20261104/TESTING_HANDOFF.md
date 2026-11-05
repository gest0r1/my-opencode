# Pipeline optimization — handoff for isolated testing

**Scope:** `my-opencode` + `openchamber-ru` feature branches, not `main`. This is a **test handoff**, not a merge/release approval. Source changes are not installed on any running server. Full task remains partially blocked by upstream/pin integration.

## Canonical inputs

- Source: [my-opencode feature](https://github.com/gest0r1/my-opencode/tree/feature/pipeline-optimization-20261104), base `main@c58f452047df3806ea6e946d1909b075344bc069`. Tester must record the **current immutable HEAD SHA** before running; the HEAD at handoff is written in `REPORT.md`.
- UI: [openchamber-ru feature](https://github.com/gest0r1/openchamber-ru/tree/feature/pipeline-optimization-20261104), HEAD `f9e8831586efc5b6ef975102bc3facef968561e3`, base `main@f9521f168c894cb17dc60ba4f929d4df0722e263`.
- Current pins in feature (not target upgrade): `@opencode/plugin 2.1.4`, `tsx 4.23.15` from `config/opencode/package.json`; OpenChamber monorepo `2.5.2`, `bun@1.4.4` declared in its package.json. Do **not** assume these are installed versions.
- Upstream review targets: OpenChamber `v2.6.1@ce853f415704d1bfe8d076a5cfb2caabac00fffd`, OpenCode `v2.2.5@9bbb8ce18c80f099e0e448775f59d965ead40a21`. **Not merged or pinned.** Exact conflict metadata: `handoff-assets/upstream-conflicts-20261105/manifest.jsonl`. This dependency must be resolved in a separate, fully checked feature worktree before declaring the entire optimization complete.
- Primary status: [REPORT.md](REPORT.md); decisions: [DECISIONS.md](DECISIONS.md).
- Timing documentation: [OpenChamber timing evidence](https://github.com/gest0r1/openchamber-ru/blob/feature/pipeline-optimization-20261104/project/pipeline-optimization-20261104/timing-evidence.md); [explicitly synthetic nested export example](artifacts/markdown-timing-synthetic.md).

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

- At handoff, only **native Node build-output proof tests 2/2** were executed against locally materialized files verified by `git hash-object` equal to the current remote blobs. Seven isolated V8 cases covered the new policy ordering and artifact path checks; they do not replace full project tests.
- Recent runner, OpenCode SDK and Bun tests are **NOT RUN**, not green. Any failure must be recorded with exact source SHA, command, exit code, environment and short logs in a new run report.
- OpenChamber upstream is **not merged**: 98 both-modified text inputs, including 18 conflicting files, plus 6 delete/modify choices at the historical target; required Bun validation is unavailable here.
- Actual cost improvement (wall-clock, tokens, reviewer invocations) is not measured on comparable PLAN/RUN inputs; no numerical benefit is claimed.

**Testing handoff is ready for the existing feature implementation. Overall specification is *not* yet ready for merge or independent final acceptance until blockers above are resolved.**
