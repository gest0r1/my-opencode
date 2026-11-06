# 2026-11-06 — F1–F6 fixes, upstream preparation

**Completion statement:** «Исправления и upstream подготовлены частично; требуется ревью и тестирование ChatGPT». No source is approved for merge, release, installation or deployment.

## Immutable inputs

| Repository | Feature at start | Source before this report | Base main |
|---|---|---|---|
| [gest0r1/my-opencode](https://github.com/gest0r1/my-opencode/tree/feature/pipeline-optimization-20261104) | `53a02229117d3d393752a04ce83ab255f2ab343f` | `9025ab7736acb24766c7dfb41e47efd201ee6030` | `c58f452047df3806ea6e946d1909b075344bc069` |
| [gest0r1/openchamber-ru](https://github.com/gest0r1/openchamber-ru/tree/feature/pipeline-optimization-20261104) | `06afd56dffe3e0fc0c2863d0017ae243b037cc1b` | identical | `f9521f168c894cb17dc60ba4f929d4df0722e263` |

`my-opencode` compare commits from start: **23** source/test/docs commits through `9025ab7`, across 14 changed paths; no OpenChamber source change or pins. GitHub branch+compare source: **PASS**. Current HEAD after this report commit can be retrieved from the feature ref.

## Fix matrix

| Finding | Code / tests in feature | Source status | Native test status |
|---|---|---|---|
| F1 false cached PASS on ignored nested files | `gate-snapshot.mjs`; `gate-snapshot-inputs.test.mjs`, `gate-snapshot.test.mjs`, `gate-reuse-identity.test.mjs`, `gate-runner-cli.test.mjs` | Implemented: one bounded read-set, nested bytes and membership, symlink containment, no second cache; unchanged manager reuse retained | **NOT RUN**, actual reviewer negative reproducer pending re-run |
| F2 missing RUN preflight | `gate-runner-cli.ts`, `gate-runner-cli.test.mjs` | Implemented: shared PLAN/RUN validateOnly, existing phase/gate locks and slots before attempt/Docker; state/manifest/ref/candidate recheck; advisory included, pure lock timing unchanged | **NOT RUN**, real live/fake-Docker lifecycle required |
| F3 ambiguous installed SHA | `dev-deploy-cli.ts`, `dev-deploy-cli.test.mjs`, `scripts/setup-opencode-deploy-sudo.sh` comment | Implemented: shared exact current `status.sha`, `record` + consumer; rejects requested/history-only, missing and ambiguous status | **NOT RUN**; project-owned status adapters beyond exact canonical field unknown |
| F4 incomplete producer rename fixture | `gate-testing-policy.test.mjs` | Correct full fixture rename + explicit strict orphan-owner negative | **NOT RUN** |
| F5 incomplete snapshot reuse fixture | `gate-snapshot.test.mjs` | Local pinned manager and `node_modules/.bin/vitest` added; unknown routing stays fail-closed | **NOT RUN** |
| F6 contradictory report and links | `REPORT.md`, `TESTING_HANDOFF.md`, `DECISIONS.md` | Replaced old overlapping report with one current snapshot, correct UI ref and separate [review evidence](../reviews/20261106/REVIEW.md) | Remote GitHub read/commit **PASS** |

## Regressions / commands / environment

- Reviewer baseline source **before our changes**: `891a5c53d0fd3325e208402cf48fee5cdddc8c55`; original native Node24/tsx source suites: 158 PASS / 3 FAIL / 1 SKIP, one environment loader FAIL separately retested PASS; F1–F3 native negative reproductions confirmed failure. These are *historical results* only, at different SHAs. Native logs in `reviews/20261106/logs/`. Do not carry them as PASS.
- Current implementation validation: GitHub exact source commit/compare **PASS**. Parser-only V8 syntax of six changed JS modules/tests after stripping imports/exports: **6/6 PASS**, this is **not** module load, typecheck or `node --test`. Local native Git pathspec probe: nested ignored `.local-config/` directory collapse and targeted expansion **PASS**; this does not execute the runner.
- Node version in current generic isolated container `22.16.0` (historically observed); Git available. No authenticated clone from this runtime, no pinned `tsx 4.23.15`, no `bun@1.4.4`, no OpenCode 2.2.5 installed SDK, no Docker or isolated OpenChamber source workspace. This task's full **native Node suite, TS/typecheck, Bun, OpenCode SDK, Docker, installation/rollback and live service tests are NOT RUN**. No exit code or elapsed duration exists for those commands. Do not synthesize it.
- Exact native commands and ordering: [TESTING_HANDOFF.md](../TESTING_HANDOFF.md) and [review TEST_COMMANDS.md](../reviews/20261106/TEST_COMMANDS.md). Re-run actual review repro file against exact HEAD before broad suites. Check code drift against real runner, not copied helper logic.

## Upstream/pins

- Verified official tags via GitHub refs: OpenChamber `v2.6.1@ce853f415704d1bfe8d076a5cfb2caabac00fffd`, OpenCode `v2.2.5@9bbb8ce18c80f099e0e448775f59d965ead40a21`. Common merge base `c4919abc1e7a0a3beeaa126666487806bf79cfe0`.
- Historic exact tree metadata in `handoff-assets/upstream-conflicts-20261105/manifest.jsonl`: 98 both-modified text files (80 clean / 18 conflict files / 29 conflict regions), plus six fork workflow deletions to preserve pending explicit review. [UPSTREAM_PREPARATION.md](../UPSTREAM_PREPARATION.md) records the at-risk caller/contracts and verification sequence.
- **No merged upstream source, two-parent commit, resolution patch, package pin update, Bun lockfile regeneration or changed version compatibility evidence**. OpenChamber `AGENTS.md` demands `bun run check:changed` before any source commit, which could not run. Pushing a guessed GitData tree would not satisfy task.
- No replaced upstream workaround removed without a verified replacement. Changes in `my-opencode` are only for F1–F6.

## Limits and next action

No testable provider-model calls or comparable PLAN/RUN measurement from this turn. Idle coder time, hashing overhead, number of repeated review loops and token costs on new source **unavailable**; no optimization percentage is claimed.

No production installs, altered `main`, releases, paid GitHub Actions, Sevami repository access, external host changes or other people's worktrees. Foreign processes/locks not inspected; none removed. No local source checkout or unpublished patch held by the implementing agent, only remote GitHub feature commits.

**Next single concrete step:** independent review and **native** F1–F3 negative reproductions plus F4/F5 tests on immutable my-opencode feature HEAD with pinned Node/tsx; record exact versions/SHA/exit/duration/logs. Only after PASS proceed to OpenChamber upstream resolution and pinned Bun validation in a fully isolated checkout, never production.
