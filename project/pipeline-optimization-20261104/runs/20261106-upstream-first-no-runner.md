# 2026-11-06 — upstream-first run: partial GitData staging, full tests blocked

**User order:** first OpenChamber 2.6.1 / OpenCode 2.2.5 upstream update, **then** full tests. No native full-test claims, merge-to-main, release, production install or paid Actions.

## Immutable inputs and boundaries

- [my-opencode feature](https://github.com/gest0r1/my-opencode/tree/feature/pipeline-optimization-20261104): initial `bd0e4fca20acbde4d11a555378d32ee03d59611f` (previous F1–F6 handoff); HEAD before this report `4c6f7aa9dbf1af1a035632b05e8b2823cc4a72f2`; base main `c58f452047df3806ea6e946d1909b075344bc069`. Changes confined to docs and a staging merge helper in this run.
- [openchamber-ru feature](https://github.com/gest0r1/openchamber-ru/tree/feature/pipeline-optimization-20261104): unchanged HEAD `06afd56dffe3e0fc0c2863d0017ae243b037cc1b`; base main `f9521f168c894cb17dc60ba4f929d4df0722e263`. No source edit, no pin edit and no source commit.
- Upstream public git tags verified: `openchamber/openchamber@v2.6.1=ce853f415704d1bfe8d076a5cfb2caabac00fffd`, `anomalyco/opencode@v2.2.5=9bbb8ce18c80f099e0e448775f59d965ead40a21`. Merge-base `c4919abc1e7a0a3beeaa126666487806bf79cfe0`.
- Upstream OC `opencodeCli.version=2.2.5`; workspace `@opencode/client`/`@opencode/schema=2.2.5`; minimum supported OpenCode `2.2.4`; Bun project manager `1.4.4`. Exact target lock needs frozen Bun installation. None of these pins were published to fork branches.

## Upstream work actually done

- Fetched and classified exact base/fork/upstream Git **tree objects**, verified non-truncated: base 7,933 tree entries, fork 7,958, upstream 8,562. Union 8,154 path entries; **5,518 unchanged / 2,398 upstream-only / 132 fork-only / 2 both-same / 104 both-different** (98 both-modified text + six delete/modify workflows). Matches preserved [manifest](../handoff-assets/upstream-conflicts-20261105/manifest.jsonl).
- Created **unreferenced** GitData object `18f1b7cc287adf0507ea1aa92430fd42976c0867`, based on upstream 2.6.1 tree, overlaying 132 fork-only file entries and removing six fork-deleted workflows. This object is a partial merge basis; not a source branch or commit.
- Created conservative [merge helper](../handoff-assets/merge-three-way-conservative.mjs). Its four small isolated V8 unit examples passed **4/4**, but **not** native `git merge-file` and no semantic or Bun proof.
- Applied one clearly non-overlapping text merge for `packages/ui/src/lib/i18n/messages/third-party-integrations.i18n.test.ts` as blob `7a1c9e850bfe679c3ac2ebbc581127edf773f875`, yielding newer **unreferenced** tree `bdacc1ececfa446036e17c9edfd3f4d9ee78e7b7`. GitHub tree fetch succeeded with `truncated=false`; six removed workflows absent, fork timing export source blob `0c2e520c27adedf364ad454891d55378cf5b8be7` preserved. Upstream Bun lock blob `2eb5813b376f849524b35c82138a9c2059e2c702` present in the staging tree only.
- **97 both-modified source files remain unresolved** in the staged tree (the tree contains *upstream* versions of those files and therefore **must not** be checked out/published as an integrated fork). Some bulk blob-fetch/merge calls hit Code Mode tool-call limits before creating any new tree and therefore contributed **no changes**; no staged source was promoted.
- No Git commit with two authentic parents, no moved branch ref, no true fork+upstream merge and no completed version bump. The unreferenced Git tree is recoverable by SHA, but **not** an accepted source update.

## Tests and blockers

| Action | Exact input | Actual result |
|---|---|---|
| GitHub upstream tag/commit/tree fetch and tree-object creation | Tags and tree hashes above | PASS, exact immutable objects |
| GitHub staged-tree recursive read | `bdacc1ececfa446036e17c9edfd3f4d9ee78e7b7` | PASS, `truncated=false`, forbidden workflows absent |
| Conservative merge helper four small V8 cases | `merge-three-way-conservative.mjs` remote source | PASS 4/4 isolated checks; not native module run |
| Native Git `merge-file` for all 98, manual conflicts | No isolated checkout of OC fork plus upstream | **NOT RUN** |
| OpenChamber `bun run check:changed`, frozen Bun install, typecheck, UI/server/full tests/build | Bun 1.4.4 + full checkout unavailable | **NOT RUN** |
| my-opencode full Node/tsx F1–F5 retests, target pinned SDK | No pinned independent checkout | **NOT RUN** |
| Docker/Postgres, compaction/restart/notifications, cross-repo pins, rollback | No eligible isolated test machine | **NOT RUN** |
| Before/after PLAN/RUN wallclock + reviewer/token cost | No comparable complete runs | **UNAVAILABLE** |

**Observed environment:** `/mnt/data` has specs, no complete worktrees; `git ls-remote` fails DNS `Could not resolve host github.com`; Node `v22.16.0`, no Bun executable; GitHub connector supports Git objects but cannot execute native build commands. The only registered Gateway SSH host is **sevami**, which is a production server excluded by task restrictions. Do not borrow it for a merge or test without a changed explicit authorization.

**Cannot safely publish a guessed OC source merge:** `openchamber-ru/AGENTS.md` requires `bun run check:changed` **before each source commit**. Additionally, an incomplete staged tree would discard local behavior in 97 files. This is a technical, not an owner-approval, blocker.

## Handoff / next step

A genuinely isolated Linux/macOS runner with authenticated Git checkout and Bun 1.4.4 plus compatible OpenCode 2.2.5 packages is required. Perform true three-way merge from the refs above, resolve all 97 both-modified text files preserving fork contracts, validate six deleted workflow triggers stay removed, regenerate/verify locks and both repos' pins. Before each OpenChamber source commit run `bun run check:changed`. Then **after upstream integration** run the complete Node/tsx + Bun + UI/server/runtime/installer regression matrix in [TESTING_HANDOFF.md](../TESTING_HANDOFF.md). Preserve exact exit code, runtime duration, commands, SHA and logs; no CI actions.

**Result:** upstream update **PARTIAL / UNPUBLISHED**, full tests **NOT RUN**. Main, release, production, and Sevami repository unchanged. Both feature branches remain available; latest current snapshot [REPORT.md](../REPORT.md), prepared integration tree [UPSTREAM_PREPARATION.md](../UPSTREAM_PREPARATION.md).
