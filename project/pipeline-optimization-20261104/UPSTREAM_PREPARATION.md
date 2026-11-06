# Upstream preparation — 2026-11-06

**Status: proposed integration only. No source merge and no pin bump.** This note records verified immutable inputs and the non-negotiable validation gate; it is not a resolved merge tree.

## Exact upstream inputs

| Component | Fork input | Upstream target | Verification |
|---|---|---|---|
| OpenChamber RU | `feature/pipeline-optimization-20261104@06afd56dffe3e0fc0c2863d0017ae243b037cc1b` | `openchamber/openchamber v2.6.1@ce853f415704d1bfe8d076a5cfb2caabac00fffd` | Official GitHub tag ref fetched on 2026-11-06 |
| OpenCode distribution | Current `@opencode/plugin=2.1.4`, `tsx=4.23.15` in `config/opencode/package.json` | `anomalyco/opencode v2.2.5@9bbb8ce18c80f099e0e448775f59d965ead40a21` | Official GitHub tag ref fetched on 2026-11-06 |
| OpenChamber merge-base | `c4919abc1e7a0a3beeaa126666487806bf79cfe0` | `base tree b0a5fd6d7860617ed180303761ea31f23d25d432` | Git trees and exact blob metadata already captured |

Historical reproducible 3-way input: [manifest.jsonl](handoff-assets/upstream-conflicts-20261105/manifest.jsonl) and [merge-check.py](handoff-assets/upstream-conflicts-20261105/merge-check.py). For the old fork SHA, union of paths = 8,154, both-modified text = 98, clean = 80, textual conflicts = 18 files / 29 regions, delete/modify = 6. The **only** later OpenChamber feature change is docs-only `06afd56d`; semantic source merge has not been tested anew. No merge tree or new commit with two parents exists.

## GitData staging tree — source preparation, NOT a merge

I created and re-read an **unreferenced Git tree object** in the OpenChamber fork:

- `18f1b7cc287adf0507ea1aa92430fd42976c0867` — base is exact upstream `v2.6.1` tree `9d2471f2c9e72f86e18c4becdd4c044588bd67f3`.
- Overlaid **132 ours-only paths** with exact existing fork blob hashes/modes, preserving fork-only features and deletions where upstream was unchanged.
- Explicitly removed **6** fork-deleted GitHub workflows that upstream had modified, to ensure they do not reappear even in the staged candidate.
- **98 both-modified text paths are deliberately unresolved**: the staged tree retains the upstream versions of those paths, and **must not** be used as a tested or ready-to-merge source tree. This includes critical session/projection/notification logic, pins, README and UI translations.
- Validation: GitHub recursive tree read succeeded, `truncated=false`, 8,089 file/symlink paths, six forbidden workflows absent, fork-only `packages/ui/src/lib/exportSession.ts` blob retained as `0c2e520c27adedf364ad454891d55378cf5b8be7`.
- No commit or branch ref was created or moved in `openchamber-ru` by this step; no workflow started. This Git tree is a reusable immutable **partial merge basis**, not an installed upstream update.

This work can accelerate conflict resolution in a Bun-equipped isolated checkout. Source integration stays **NOT DONE** until the 98 paths have real three-way resolutions, compatible locks/pins and required tests. Publishing the staged tree as-is would silently discard fork behavior.

## Conflict decisions reserved for source-level review

- **Keep deletions pending explicit security review** (never restore on autopilot): `.github/workflows/issue-intake.yml`, `.github/workflows/nix-eval.yml`, `.github/workflows/pr-intake.yml`, `.github/workflows/pr-review.yml`, `.github/workflows/release-desktop-smoke.yml`, `.github/workflows/stale.yml`. Reintroducing upstream workflows can start paid Actions on a feature push, contrary to the task restrictions.
- **High-risk behavioral contracts:** `packages/web/server/lib/agent-tool/runtime.js`, `openchamber-control/{actions,service}.js`, `packages/web/server/lib/opencode/session-activity.js`, `packages/ui/src/lib/opencode/{projection,model}.ts`, `packages/ui/src/sync/sync-context.tsx`, `packages/ui/src/components/session/sidebar/sessions/SessionNodeItem.tsx`. Each requires caller tracing and existing/added regression for fork Telegram child subscriptions, session/worktree continuity, owner prompts and timing provenance. Both-sided modification alone is not proof of textual conflict; use merge-check before naming exact conflict regions.
- **Pin and release contracts:** `package.json`, `packages/electron/package.json`, `packages/web/bin/lib/cli-startup.js`, `packages/web/server/index.js`, `packages/web/server/lib/opencode/shutdown-runtime.js`, `.agents/skills/opencode-v2/SKILL.md`, `.github/workflows/release.yml`, `packages/electron/updater-feed.*`. Preserve existing fork functionality and new upstream API only with pinned/Bun and installation checks.
- **RU UI/locale:** message sources and `NotificationSettings.tsx` are both-modified; verify Russian strings, notification categories, hidden/unknown child anti-spam, settings registry generation and UI snapshots before marking clean merges accepted.

These are *review queues*, not conflict resolutions. Do not use mass ours/theirs or reconstruct a new standalone git repository from snapshots as a fake merge.

## Required procedure, with unavailable steps explicit

1. In an isolated worktree fetch the exact fork and upstream commits, verify all three Git ancestors and merge-base SHA; run true `git merge --no-commit` or equivalent reproducible GitData tree generation.
2. Resolve each textual region and deletion decision with the fork contract, replacement upstream path, and focused regression evidence. Verify clean-file semantics, especially timing/projection and sync-context.
3. With the target compatible package graph, update both repos' exact CLI/client/schema/plugin pins, the OpenChamber Docker/Electron manifests, regenerated `bun.lock`, distribution installer defaults and READMEs. Never retain old lock integrity while string-replacing a package version. `flake.nix/flake.lock/nix/hashes.json` follow the project's prescribed Nix-specific workflow, not a manual hash guess.
4. Run `bun run check:changed` **before any OpenChamber source commit** as required by `AGENTS.md`; frozen install, `bun run type-check`, focused UI/web tests, `bun run build`; then `node scripts/check-opencode-pins.mjs --openchamber <isolated-checkout>` from the distribution. Do not run paid Actions or production deploy.
5. If the isolated Bun environment is unavailable, preserve proposed conflicts/resolutions as a patch outside the source branch and report **NOT RUN**. Do not publish a presumed-safe upstream merge or fake supported pins.

**Current blocker:** available GitHub connector provides Git data/content editing, but no tested, pinned Bun checkout to satisfy OpenChamber's required pre-source-commit `check:changed`. The attempted Gateway server inventory is unavailable. Therefore upstream source merge/pins remain **NOT IMPLEMENTED**, not a matter of owner approval.
