# Fixture corrections — 2026-11-06

Base feature HEAD: `f7ed0ed71add7016671420533f461abbd6e7bb77`.

Only test fixtures were changed:
- RUN preflight test creates `scripts/` recursively because fixture setup may already create it.
- Snapshot fixture fake pnpm answers `--version` with its pinned `1.0.0` before running the test body.
- Snapshot cache and heavy-lock paths use `.tmp/`, so generated runtime artifacts do not enter the ignored local-input identity.

## Verification

- `gate-snapshot.test.mjs`: 7 PASS, 0 FAIL.
- RUN preflight regression: 1 PASS, 0 FAIL. Expected evidence: preflight invoked; expensive command and Docker not invoked after preflight failure.
- Both checks used Node 24.22.1 with a temporary external `npx` shim that invokes Node's native TypeScript support. The environment blocks the pinned `npx/tsx` IPC socket (`listen EPERM`), so these are focused isolated checks, not pinned-loader acceptance or a full regression run.
- No production runtime code changed.

## Test file hashes

- `gate-runner-cli.test.mjs`: `a6a6f01be8334ade7042b4a28736b23b7ebf965788a7f9ecdcb0310b5c4096bd`
- `gate-snapshot.test.mjs`: `e79e72145cacd9b0e409b3a3226a431fddefac79f824ef065fdf9a9a57cdfc1a`
