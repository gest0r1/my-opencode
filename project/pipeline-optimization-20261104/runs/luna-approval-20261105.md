# Approval audit contract update — 2026-11-05

Status: implemented in isolated snapshot `isolated/my-opencode-approval`; pending root review and remote publication. No source commit or GitHub write made.

The final-manifest audit descriptor contains `subject`, `run_id`, `decision`, exact displayed manifest SHA-256, response text, and optional OpenCode message/session correlation IDs. `plan-start` validates the descriptor and raw manifest hash before plan-check/adopt/verify/init; direct `approve` validates status, bytes and descriptor before environment preflight, then rechecks the hash under the state lock before mutation. Scope/story descriptors fail by subject. No natural-language classification or authorship claim is made.

New audit data lives in `state.json`; the existing `updateState` still owns the planned→approved transition and GitHub outbox. Technical revision carries the original approval through existing `planning/revision.json` / `revisions.jsonl` only with previous approval, `owner_contract_changed=false`, and matching review evidence SHA. It retains original and current manifest hashes, evidence path/hash, and existing outbox events. Changed-contract revision starts planned and needs a fresh descriptor. Existing approved/in-progress state without an audit record remains usable without backfill.

Focused suites passed under Node v24.22.1 and cached tsx 4.21.0 loader shim (pinned tsx 4.23.15 was unavailable; tsx CLI fails with `EPERM` when it creates a Unix socket):

| Suite | Pass | Fail | Duration |
|---|---:|---:|---:|
| `owner-amendment-git-gate.test.mjs` | 9 | 0 | 11.3 s |
| `pipeline-v2-contract.test.mjs` | 43 | 0 | 26.9 s |
| `stage-cli-dag.test.mjs` | 7 | 0 | 11.1 s |
| `stage-cli-scope.test.mjs` | 14 | 0 | 17.0 s |
| `pipeline-runtime.test.mjs` | 22 | 0 | 27.0 s |
| `stage-cli-budget.test.mjs` | 25 | 0 | 147.4 s |
| **Total** | **120** | **0** | |

Exact invocation for each suite:

```sh
PATH=/workspace/scratch/33c68a33a56d/isolated/bin:$PATH node --import /root/.npm/_npx/fd45a72a545557e9/node_modules/tsx/dist/loader.mjs --test config/opencode/skills/task-management/scripts/<suite>.test.mjs
```

These are native isolated fixtures; no production, remote runtime, or pinned-dependency checks were run.
