# P1 one-command upgrade — handover 2026-11-24

Owner approved implementation, CI, merge to main; do not deploy VPS until owner test. Work in PR #83. OpenCode 2.3.2 / OpenChamber 2.8.0; no upstream bump.

- [x] Baseline: PR #83 root:opencode Chats fix; CI previously green at 924dafd. VPS rollback restored old UI after EPERM.
- [x] Inspect installer entrypoints, restart/defer and systemd lifecycle. Implement explicit now as authorization to terminate managed sessions/PTYs only; preserve history and unrelated processes. Stage before downtime, avoid self-kill in embedded terminal, keep defer and no-op, preserve rollback. Remove redundant human flags in now, keep verified artifact and privilege boundary.
- [ ] Adapt existing tests for active terminal/session, version mismatch, repeat and rollback. Run GH Actions and inspect exact head results.
- [ ] Merge only green head; verify main; provide one-command SSH update and owner acceptance.

Checkpoint: coordinator implementation committed at 6321b93. Explicit now stages first, stops managed UI cgroups (TERM then bounded KILL), restarts OpenCode only for mismatched version or active/unknown session inventory, verifies the new running version, preserves rollback and root/opencode split. Existing auto/defer remains non-disruptive; embedded origin forces defer. No additional human flags in now. Static contracts adapted; real migration test now installs 2.2.7 first, creates a child in legacy UI cgroup, verifies child termination, unrelated process survival and OpenCode 2.3.2 restart/session retention after rollback. Root-to-root acceptance exercises mixed-owner Chats and unchanged idle OpenCode PID. Test changes committed through 2de734a. CI pending; verify exact final head, correct failures, and explicitly verify active RUN and embedded protection before merge. No VPS mutations.
