# Pipeline optimization — current status (2026-11-06)

**Source fixes F1–F5 prepared; independent native retest NOT RUN. Upstream OpenChamber/OpenCode integration NOT DONE.** No release, main merge, install or production change. This document is the **only current snapshot**; historical snapshots are in `runs/`, Git history and [20261106 REVIEW](reviews/20261106/REVIEW.md). Older baseline PASS is not acceptance of the changed HEAD.

## Canonical inputs

| Repo | Initial reviewed source | Current source checkpoint before this report | Base main |
|---|---|---|---|
| [my-opencode feature](https://github.com/gest0r1/my-opencode/tree/feature/pipeline-optimization-20261104) | `891a5c53d0fd3325e208402cf48fee5cdddc8c55` (review; subsequent review-docs changed HEAD) | `574062d585fb487d43b9cbb302126bbe15153a9e` | `c58f452047df3806ea6e946d1909b075344bc069` |
| [openchamber-ru feature](https://github.com/gest0r1/openchamber-ru/tree/feature/pipeline-optimization-20261104) | `06afd56dffe3e0fc0c2863d0017ae243b037cc1b` | same — no source edits in this implementation run | `f9521f168c894cb17dc60ba4f929d4df0722e263` |

Current HEAD **after** REPORT/docs commits must be read from the live feature branch. The code above was edited only in my-opencode; OpenChamber source, Sevami, main, production, managed deployment and paid Actions were not touched. No foreign worktrees, processes or locks have been removed.

## Defect matrix — source and test are different statuses

| Finding | Root cause and implemented source correction | Regression source | Test status on changed HEAD |
|---|---|---|---|
| **F1 P1 — nested ignored input causes stale PASS** | `gate-snapshot.mjs`: Git `--directory` entries are expanded **only for non-generated ignored directories**, bounded at 256 dirs/8192 files, canonical sorted set shared by snapshot copy and reuse digest. Unsupported/outside-checkout or symlink inputs reject optimization instead of disappearing. Unchanged valid pnpm reuse preserved. | `gate-snapshot-inputs.test.mjs`, `gate-reuse-identity.test.mjs`, `gate-snapshot.test.mjs`, actual `gate-runner-cli.test.mjs` negative source reproduction. | **NOT RUN** after source fix |
| **F2 P1 — RUN starts expensive commands before lifecycle preflight** | `gate-runner-cli.ts`: PLAN and RUN use one `livePreflight` with `--pipeline-preflight`. RUN preflight holds existing gate lock, phase-marked runtime lock and heavy→live slot; it executes before allocating a gate attempt, snapshot, expensive command or Docker. RUN state, manifest SHA, HEAD and declared candidate revalidated after precheck. Advisory live RUN also checked. Pure gates retain their earlier late-lock timing. PLAN stays stateless with candidate null. | `gate-runner-cli.test.mjs` (native negative repro, no attempt/Docker, advisory); existing PLAN live and real live gate suites. | **NOT RUN** after source fix |
| **F3 P1 — SHA substring is treated as installed identity** | `dev-deploy-cli.ts`: shared `currentContourSha` for `record` and service verifier. Requires exact current top-level `status.sha`, rejects missing/malformed/ambiguous and contradictory `current.sha`; no use of requested/history/message SHA. Missing status file rejects install. Actual root-owned producer remains unchanged, its adapter contract is documented in `scripts/setup-opencode-deploy-sudo.sh`. | `dev-deploy-cli.test.mjs` (current good/bad, requested SHA, ambiguity, missing file, target), prior review reproduction. | **NOT RUN** after source fix |
| **F4 P2 — false failing renamed producer fixture** | `gate-testing-policy.test.mjs`: full rename of profile/testing keys and strict orphan-owner negative control; policy source not weakened. | Existing policy suite. | **NOT RUN** after test fix |
| **F5 P2 — snapshot test lacks verifiable local tool** | `gate-snapshot.test.mjs::snapshotFixture`: bounded exact `pnpm@1.0.0`, project-root `node_modules/.bin/vitest`, package metadata/manager executable, fixture-only inherited NODE_PATH removal (not production environment override). Added real nested ignored file snapshot assertion. | Existing snapshot suite + new nested scenario. | **NOT RUN** after test fix |
| **F6 P2 — current report contradicts historical blocks** | Replaced REPORT with **one current status**; old versions remain in Git, `runs/`. Updated links/testing handoff. | Verify source SHA and document links. | Remote file read/commit PASS |

## Test evidence

- **Actual review on old source `891a5c53...`:** 158 PASS / 3 FAIL / 1 SKIP in initial 162 tests, one environment loader FAIL later separately PASS. Remaining F4/F5 were fixture FAIL; three extra native negative reproductions F1–F3 demonstrated the faults. These are historical inputs, not current results. See [REVIEW.md](reviews/20261106/REVIEW.md) and archived native logs.
- **Current development source:** GitHub source commits/compare verified; JS parser via V8 (imports removed **only for parsing**) **6/6 PASS** for F1 policy/fixture modules. One native Git fixture verified that `git ls-files --others --ignored --directory` collapses an ignored directory and targeted `git ls-files` expands it. This checks Git semantics, **not** the updated project Node tests.
- **Full native Node/tsx, Bun, OpenCode SDK and Docker/PG:** **NOT RUN** on this changed HEAD; repository-independent container currently has Node 22.16.0, no Bun, no pinned source checkout or authenticated GitHub remote clone. Do not claim any full suite PASS or measured speed gain. Source-ready ≠ reviewed ≠ tested ≠ integration-ready.

## Upstream/pins — separate unfinished stage

Upstream tags verified via official GitHub tag refs 2026-11-06: OpenChamber `v2.6.1@ce853f415704d1bfe8d076a5cfb2caabac00fffd`; OpenCode `v2.2.5@9bbb8ce18c80f099e0e448775f59d965ead40a21`. Fork common base is `c4919abc1e7a0a3beeaa126666487806bf79cfe0`. Existing three-way inventory: **98 both-modified** text, **80 clean**, **18 conflict files/29 regions**, **6 delete/modify**. No genuine merge commit/tree or target package lock was published; see [UPSTREAM_PREPARATION.md](UPSTREAM_PREPARATION.md). In OpenChamber, `AGENTS.md` requires `bun run check:changed` **before source commit**, which is not available here. Exact target package integrity cannot be guessed. Do not restore deleted workflow triggers or consume paid Actions.

## Next single action

**Independent testing on an isolated exact feature HEAD**. Run the updated F1/F2/F3 native regressions and F4/F5 fixtures before advancing; full commands in [TESTING_HANDOFF.md](TESTING_HANDOFF.md) and [20261106 review test list](reviews/20261106/TEST_COMMANDS.md). Return exact exit codes, durations, loaded pin versions, and logs. Then resolve upstream conflicts in an isolated Bun-supported checkout, test and regenerate both repos' pins before source publication and integration acceptance.

**Final disposition: «Исправления подготовлены частично; требуется ревью и тестирование ChatGPT».** Source-only fixes F1–F5 published on feature; OpenChamber upstream/pins and final installed-runtime tests remain open.
