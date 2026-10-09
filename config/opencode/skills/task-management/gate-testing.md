# Frozen local test contract

`gate_profiles[profile][gate]` remains the complete authoritative command array.
The optional `gate_testing[profile][gate]` adds diagnostic impact groups and
managed PostgreSQL resources. Validation and selection are implemented once in
`scripts/gate-testing-policy.mjs`; lifecycle and evidence belong to the existing
`gate-runner-cli.ts`. RUN owns call order, not a second implementation of these rules.

## Early implementation contract

When an existing deterministic local test/typecheck command can validate source-changing
CoderAgent work, PLAN assigns the source pipeline the shared frozen `profile` and defines
`gate_testing[profile][gate].impact_groups` for the relevant component boundaries and
transitive consumers. A source-only feature pipeline may share the terminal delivery
pipeline's profile solely for advisory selection; this does **not** add a `local_gate`
stage, authoritative final PASS, extra fix budget or duplicate final validation.

Every source-changing CoderAgent work item freezes its exact target agent `stage` and a
non-empty `allowed_change_paths` subset. On each Coder dispatch, `stage-cli dispatch` captures
a machine-owned content baseline for that work item and returns `advisory_checks[]` containing
`work_item_id`, `baseline_path` and `baseline_sha256`. The worker cannot edit `.tmp/pipelines`
and must execute the supplied bound check. `stage-complete-cli` verifies the resulting PASS
against the same baseline and current scoped source before delegating to the ordinary
`stage-cli complete` transition.

Do not create a synthetic profile or impact mapping when no repository-native deterministic
check applies. If a relevant deterministic check exists but a source-changing CoderAgent
pipeline cannot resolve it through its frozen profile + impact groups, planning is incomplete
and must be revised before approval. If the work item lacks its frozen stage/scope binding,
dispatch is incomplete and must not silently fall back to a global affected check. RUN and
the worker must not guess a test command or dependency graph.

```json
{
  "gate_profiles": {
    "local": {
      "local-gates": [
        "pnpm exec vitest run --config vitest.config.ts --passWithNoTests=false",
        "pnpm exec vitest run --config vitest.live.config.ts --passWithNoTests=false"
      ]
    }
  },
  "gate_testing": {
    "local": {
      "local-gates": {
        "impact_groups": [
          {
            "inputs": ["apps/api/src/orders/**", "packages/shared/src/orders/**"],
            "command_index": 0,
            "test_files": ["apps/api/test/orders.test.ts"]
          },
          {
            "inputs": ["apps/api/src/orders/**", "packages/shared/src/orders/**"],
            "command_index": 1
          }
        ],
        "live_postgres": {
          "image": "postgres:16@sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST",
          "command_indexes": [1]
        },
        "timeout_seconds": 1800,
        "report_files": ["validation/live-pg.json"]
      }
    }
  }
}
```

The image placeholder is deliberately invalid: PLAN must resolve and review a
real official PostgreSQL image digest. Never substitute a mutable tag or a
working database. No resource is created when this contract is absent.

## Impact groups

Each group binds an original zero-based command index to exact repository inputs
or directory prefixes ending in `/**`. Include transitive consumers: a shared
module must select every dependent suite/package. Optional `test_files` appends
file filters to an explicit `vitest run`; omission runs that command in full.
Overlapping groups union file filters; an unfiltered group wins. Previously
failed commands are rechecked in full.

A bound Coder affected run compares the current worktree with the machine-owned snapshot
captured at that exact dispatch, then intersects that content delta with the work item's
frozen `allowed_change_paths`. Therefore unrelated parallel work outside that scope neither
selects extra tests nor invalidates a previously bound PASS. A later change inside the same
scope changes the scoped source digest and makes the PASS stale until the affected check is
rerun.

Legacy/manual advisory affected invocations without a dispatch baseline retain the existing
`git_setup.base_sha` comparison. Missing impact metadata, an unmapped change inside the
selected delta, schema/migration/auth/shared-contract, lockfile or configuration changes
select the complete command array. Final authoritative gates always execute the original
complete array. No dependency graph is guessed by the model during RUN.

## Disposable PostgreSQL

The runner creates a separate container for the selected live commands, waits
for readiness, and injects `LIVE_PG_TEST`, `LIVE_PG_CONTOUR`, `DATABASE_URL` only
into those subprocesses. It uses a random temporary password and a random
loopback port, a non-root user, dropped capabilities, read-only root filesystem,
512 MiB memory, one CPU, bounded PIDs and tmpfs storage. There are no host mounts,
persistent volumes, host network or privileged mode. Project tests own migrations
and fixtures; the runner does not guess SQL or migrate a working contour.

Cleanup verifies the unique RUN/project ownership label before removing the
exact container. Only a local Unix-socket Docker daemon is supported; remote
contexts cannot supply the runner's loopback database. Success, test failure,
timeout, SIGINT and SIGTERM use the same
cleanup path; a cleanup/daemon failure is reported, never hidden as PASS. SIGKILL
or a host crash cannot run cleanup: report the exact labelled container for
addressed recovery, never use Docker prune or a wildcard delete.

## Diagnostics

Evidence includes per-command durations, bounded redacted output, failure
summaries and fresh Vitest JSON report summaries. Bound Coder evidence also records its
work-item/stage identity, baseline SHA-256, selected paths and scoped source digest.
`report_files` is relative to the RUN directory; stale reports and paths escaping that
directory are rejected or ignored. Exit status and the complete final gate remain
authoritative; derived report summaries cannot turn FAIL into PASS.

Repeating unchanged failed diagnostic inputs is blocked. A correction changes
the input fingerprint; a new concrete hypothesis can be recorded in this RUN's
`checks/` and passed with `--hypothesis PATH`. Its content hash is consumed once
for those inputs. This is not another fix budget. Do not manufacture changes or
rewrite hypotheses merely to repeat the same attempt. If targeted corrections
do not explain the persistent failure, obtain independent review of code and
test validity. A faulty test is repaired against its approved requirement, not
weakened to pass. Only a genuine requirement/policy/external-access choice needs
the owner; see the RUN command for repair and stop handling.

Docker access for managed test resources is only through the trusted runner. DevOps uses its
separate bounded runtime diagnostic route; orchestration owns the final gate and stage
transitions. No manual env-prefix or OpenCode restart is needed for a frozen managed resource.
