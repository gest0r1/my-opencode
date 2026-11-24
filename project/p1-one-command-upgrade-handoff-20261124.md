# P1 one-command upgrade — handover 2026-11-24

Owner approved implementation, CI, merge to main; do not deploy VPS until owner test. Work in PR #83. OpenCode 2.3.2 / OpenChamber 2.8.0; no upstream bump.

- [x] Baseline: PR #83 root:opencode Chats fix; CI previously green at 924dafd. VPS rollback restored old UI after EPERM.
- [ ] Inspect installer entrypoints, restart/defer and systemd lifecycle. Implement explicit now as authorization to terminate managed sessions/PTYs only; preserve history and unrelated processes. Stage before downtime, avoid self-kill in embedded terminal, keep defer and no-op, preserve rollback. Remove redundant human flags in now, keep verified artifact and privilege boundary.
- [ ] Adapt existing tests for active terminal/session, version mismatch, repeat and rollback. Run GH Actions and inspect exact head results.
- [ ] Merge only green head; verify main; provide one-command SSH update and owner acceptance.

No VPS mutations. Next: inspect root installer and OpenCode restart mechanism before editing.
