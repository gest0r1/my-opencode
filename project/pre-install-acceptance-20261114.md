# Pre-install acceptance: OpenCode 2.2.7 / OpenChamber 2.7.1 / Telegram SDK

**Status: NOT APPROVED FOR INSTALL OR DEPLOY.** Execution checklist, not test evidence.
Always start with [master handover](./upstream-227-telegram-review-value-plan-20261113.md) and
[OpenChamber ledger](https://github.com/gest0r1/openchamber-ru/blob/feature/upstream-271-fork-reconciliation-20261114/project/upstream-271-20261114/integration-ledger.md).
Use exact source SHA from their latest checkpoint. Historical green commits do not validate subsequent source.

## Isolation and rules

- Execute only in a disposable checkout/test host with Node **24**, Bun **1.4.4**, installed local `tsx`, no production mounts/config/data. Use test Bot API credentials only, never add secrets to GitHub/chat/logs.
- Do **not** merge into `main`, release, SSH or install onto the user's server until explicit owner approval. Keep OpenChamber PR #27 **DRAFT**.
- Record every actual test as `PASS/FAIL/NOT RUN` with command, runtime versions, exact SHA and log pointer in the master handover immediately after completion. For OpenChamber, sync integration ledger without interrupting active CI.
- Never turn on SDK sender automatically. The bot remains outbound-only. Legacy is only a recovery sender after SDK acceptance. Isolated-space subscriptions block SDK cutover until proven equivalent.

## A3/C1/C2/D: independent my-opencode checkout

From the repository root of the **isolated** checkout (do not run the installer in a real home directory for this test):

```bash
node --version
bun --version
cd config/opencode
bun install --frozen-lockfile
cd ../..
node scripts/check-opencode-pins.mjs
export PATH="$PWD/config/opencode/node_modules/.bin:$PATH"
export NODE_PATH="$PWD/config/opencode/node_modules"
node --test config/opencode/skills/task-management/scripts/stage-cli-budget.test.mjs
node --test config/opencode/skills/task-management/scripts/agent-models.test.mjs
node --test config/opencode/skills/task-management/scripts/gate-runner-cli.test.mjs
```

Additional acceptance in **actual OpenCode 2.2.7 runtime** (the preceding tests cannot prove it):
- `GateRunner` shell dispatch for exact permitted `gate-runner-cli.ts` command; verify blocked commands remain denied.
- PLAN unjustified custom mechanism → explicit owner choice, justified reuse → no needless gate; C1 recurring independently proven defect → class review on third detection, no Senior for bounded confirmation; D optional-only review cannot spend a fix-cycle, explicit blocker still can.
- Backup disposable `~/.config/opencode`, install to disposable HOME, repeat; verify old user-selected `model/variant/color` survive changed agent prompt (#18); then simulate failed install and restore original generation/credentials/config without modification.
- Preserve frozen budgets and original runner architecture; no bypass of live PostgreSQL preflight.

## B/E: independent OpenChamber runtime

- Review current PR #27 **exact source SHA** grouped checks: `tests`, `type-check`, `lint`, `build` and Russian i18n. Passing old source SHA is insufficient.
- Install `extensions/telegram-notifier` using actual OpenChamber SDK host; deny before grants, approve `service/opencode`, revoke and restart; verify strict `{ok:true}`, dropped-event catch-up within 60-second sweep and no host secret leak.
- Use a disposable Telegram bot and destination. Demonstrate completion only after root, children, Goal, detached shell and pending dispatch have ended; form/permission/page question; explicit error; failed/ambiguous send kept in durable ledger and never automatically retried; opt-out during last live probe stops physical HTTP send.
- With quiescent legacy subscriptions, run `legacy → paused → sdk`, verify in-flight drain and single-owner, then `sdk → paused → legacy` rollback. Crash mid-`paused` must recover to legacy **before** watcher begins. Active/unknown or isolated-space subscriptions must refuse SDK transition.
- UI: >50 session history, old/completed/renamed sessions, mixed worktrees/projects, live title with fallback to saved name/ID, search and pagination, unsubscribe without navigating to beginning of an old session, persistence/revocation after restart.
- Regression smoke: full Markdown export and per-tool timing, worktree/session management, RU/EN labels, Windows updater packaging; mobile release job only if explicitly planned. No hidden assumption that Linux unit tests prove Windows/macOS/Android packaging.

## Exit decision

Ready for owner-controlled **installation and subsequent manual testing** only when:
1. every executable isolation test above has traceable PASS or an owner-approved explicitly scoped exclusion;
2. SDK host/delivery/cutover/rollback invariants are demonstrated, with no two senders;
3. both handover/ledger have the same source SHA, CI evidence, limitations and rollback instructions;
4. no `main`, production, deployment or secrets were touched during preparation.

If isolation toolchain or disposable Telegram credentials are absent, record `NOT RUN` and do not claim READY.
