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

## Project-generated impact map

When the repository already generates its own test impact map (for example
`docs/testing/gate-testing.release.json` next to the command array it indexes,
`docs/testing/frozen-release-commands.json`), PLAN binds that map instead of writing
impact groups by hand. A hand-written copy of a generated map is never complete:
reviewers rightly reject it for missing transitive edges, and the result is a
non-narrowing contract that runs the whole suite on every work item.

1. Copy the project's command array for that gate into `gate_profiles[profile][gate]`
   exactly (same order; the map's `command_index` values refer to it).
2. Run `stage-cli gate-testing-freeze <manifest.json> --profile <p> --gate <g>
   --source <map.json> --commands <commands.json> [--ignored <rules.json>]`.
   It snapshots the map into `planning/gate-testing/<p>.<g>.json`, checks the
   command array, and records only `gate_testing[p][g].source` (snapshot path,
   SHA-256, command-array digest). `--ignored` takes an array, `ignored_inputs` or
   `ignored_input_rules` (patterns with optional `except`), for example the
   project's documentation and asset rules.
3. Preflight, dispatch, the runner and completion all read the snapshot; a changed
   snapshot or command array blocks with `GATE_TESTING_SOURCE_*`.

Selection with a bound map: ignored inputs select nothing; a new test file runs
alone with the command owning its directory; a new source file counts as reached
through the changed mapped files that import it (alone it selects the complete
set); other unmapped paths, dependency manifests and auth paths select the complete
set. Regenerating the project map during RUN does not change the frozen snapshot;
the final authoritative gate always runs the complete array.

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
selected delta, auth/security paths, `package.json` or lockfile changes select the complete
command array. Schema, migration, configuration and shared-contract paths follow the frozen
impact groups like any other input, so PLAN must map them to every consuming suite (for example
`packages/db/migrations/**` → db and live-PG commands); an unmapped one still selects the
complete array. Final authoritative gates always cover the original complete array. No
dependency graph is guessed by the model during RUN.

## Coordinator-only commands, parallel groups and reuse

Parallel workers edit one checkout. A worker runs only the tests its change impacts; heavy
whole-repository commands run once, on the combined tree, by the coordinator (OpenStage) after a
wave of parallel work and again in the final gate. Running them per worker multiplies the wall
clock, competes for CPU and memory, and reports other workers' half-finished edits.

```json
"gate_testing": { "local": { "local-gates": {
  "coordinator_only": [0, 1, 2],
  "parallel_groups": [[1, 2], [3, 4, 5]],
  "impact_groups": [ ... ]
} } }
```

- `coordinator_only` lists frozen command indexes (type-check, lint, build, complete suites) that
  `--affected` never selects, including as a previous failure. Explicit `--command-index`
  diagnostics and complete runs still execute them. At least one command must stay outside it.
  When a change impacts only coordinator commands, the worker check runs nothing and its
  evidence names them in `deferred_to_coordinator`; the coordinator check
  (`--advisory --coordinator`) before a review and the final complete gate run them.
- Reuse is per command: a command that already passed on the identical tree, manifest, gate and
  environment is not run again (`commands_reused`), in advisory and authoritative runs alike.
- `parallel_groups` lists 2–3 consecutive frozen indexes that may run at the same time, so a
  group is one step of the frozen order. Neighbouring selected members run concurrently;
  everything else runs alone in frozen order. Live-PostgreSQL commands never join a group, and two
  commands naming the same `report_files` entry never share a batch. A failing group stops the
  gate after all its members finish; a member that cannot start is recorded with exit 127.
- A PASS recorded by the runner is reused when the whole source tree digest (not only the work
  item scope), frozen manifest,
  environment and a superset of the selected commands match; the new evidence records
  `reused_from` and runs nothing. An authoritative gate reuses only a PASS that covered the
  complete array; base probes, hypothesis runs, runtime gates and `{candidate_sha}` commands never
  reuse. `--no-reuse` forces execution.

## Focused runs and base probe

`--advisory --command-index N --test-file PATH` (repeatable) appends existing repo-relative
test files to one explicit frozen `vitest run` command, with the same managed resources. It is
the fast correction loop for a failing suite; its `checks/<pipeline>-<gate>-focus-*.json`
evidence never satisfies a bound completion check.

`--advisory --base-probe` runs the complete frozen array on a clean checkout before the first
implementation start and records `base_probe.head_sha/base_sha` in
`checks/<pipeline>-<gate>-base-probe.json`, so a suite that is already red on the base is
classified before any work item starts instead of surfacing inside an unrelated one. The first
source dispatch of a RUN is refused without a PASS probe (`BASE_PROBE_REQUIRED`); one probe
serves every pipeline that shares the frozen profile.

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

An advisory run stopped by its caller (SIGINT/SIGTERM, for example a shell timeout) is recorded as
`INTERRUPTED` and does not count as a failed attempt. Repeating unchanged failed diagnostic inputs is blocked. A correction changes
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
