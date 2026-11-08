# OpenChamber upstream merge preparation — 2026-11-06

## Status

Prepared an **unreferenced Git tree**, not a commit or branch. It is a review aid only and is **not safe to merge, install, or test as a complete source tree**.

- Candidate tree: `73c05c4197b59044748f5af91b92809ba4dbd5e1` (recursive GitHub tree read: 8,588 entries, `truncated=false`).
- OpenChamber feature ref remains `06afd56dffe3e0fc0c2863d0017ae243b037cc1b`; `main` remains `f9521f168c894cb17dc60ba4f929d4df0722e263`.
- Upstream `openchamber/openchamber` tag `v2.6.1` still resolves to `ce853f415704d1bfe8d076a5cfb2caabac00fffd`.
- The sole feature commit after the original merge inventory is docs-only (`project/pipeline-optimization-20261104.md`, 3 additions / 1 deletion); its current blob was overlaid in the candidate.
- No commit or ref update was made in `openchamber-ru`; no source commit was created.

## Candidate contents and integrity

The candidate starts from the already reviewed upstream-based Git tree `bdacc1ececfa446036e17c9edfd3f4d9ee78e7b7`. It preserves the fork-only overlay and six fork-deleted workflows from that preparation. Then it overlays all **80 clean outputs** from native `git merge-file -p` using the saved three-way inputs. The outputs were re-hashed locally with `git hash-object` and compared with the recursive candidate tree: 80/80 matched. One ~1 MB translation file was initially uploaded truncated; that blob was replaced via chunked base64 transfer and re-verified (`bbca016f4baf83ceb0734534bca86c5a51683c0a`). The six deleted workflows remain absent:

- `.github/workflows/issue-intake.yml`
- `.github/workflows/nix-eval.yml`
- `.github/workflows/pr-intake.yml`
- `.github/workflows/pr-review.yml`
- `.github/workflows/release-desktop-smoke.yml`
- `.github/workflows/stale.yml`

The 18 native merge conflicts remain unresolved (29 conflict regions). For these paths the candidate retains the upstream-side content from its base; those files must be resolved before the candidate can represent a merge:

- `.github/workflows/mobile-release.yml` (5 regions), `.github/workflows/release.yml` (3)
- `CHANGELOG.md`, `changelog/index.json`
- `packages/electron/scripts/finalize-latest-yml.mjs`
- `packages/ui/src/components/chat/ChatInput.tsx`
- `packages/ui/src/lib/i18n/messages/{es.settings.ts,pt-BR.settings.ts,uk.settings.ts}`
- `packages/ui/src/lib/settings/{registry.ts,search.ts}`
- `packages/vscode/src/settings-registry.json`
- `packages/web/bin/lib/{DOCUMENTATION.md,cli-startup.js}`
- `packages/web/server/index.js` (5 regions)
- `packages/web/server/lib/openchamber-control/service.js`
- `packages/web/server/lib/opencode/{session-activity.js,settings-registry.json}`

The previous inventory records 132 fork-only paths, 2 both-same paths, 2,398 upstream-only paths, 5,518 unchanged paths, and six fork-deleted/upstream-modified workflows. The merge inputs are pinned to fork commit `f9e8831586efc5b6ef975102bc3facef968561e3`, merge base `c4919abc1e7a0a3beeaa126666487806bf79cfe0`, and upstream v2.6.1. The newer feature tip differs from that fork input only by the docs change noted above.

## Validation and blockers

- **Structural checks completed:** exact refs checked; recursive trees were not truncated; 80 merged blob hashes match; six intentionally deleted workflows are absent.
- **Not run:** Bun checks, type checks, lint, package tests, builds, runtime/platform tests, or full regression. There is no complete isolated checkout with Bun 1.4.4 available in this workspace.
- OpenChamber `AGENTS.md` requires `bun run check:changed` to pass before any source commit. The 18 high-risk conflicts include shared session/projection UI, CLI startup, settings contracts, and release workflows; they need module ownership/docs and callers reviewed in a Bun-equipped isolated checkout.
- The 80 clean textual merges are algorithmic merges, not semantic acceptance. Do not treat them as proof that behavior or package/version locks are compatible.
- Upstream's v2.6.1 tree and the required OpenCode 2.2.5 pins/locks must be validated together before any source ref is advanced.

## Next safe step

In a Bun 1.4.4 isolated full checkout, apply the candidate tree as a review base; manually resolve the 18 conflict files while preserving the six workflow deletions; synchronize OpenCode 2.2.5 package/CLI/plugin pins and `bun.lock`; review upstream-only changes and fork-only contracts; run `bun run check:changed`, affected tests and builds. Only after that acceptance should a real two-parent merge commit be considered. Until then, leave feature and main refs unchanged.
