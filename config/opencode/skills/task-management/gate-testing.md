# Frozen local test contract

`gate_profiles[profile][gate]` remains the complete authoritative command array.

## Stateless PLAN live-gate preflight

A PLAN probe is not a RUN. It never creates or simulates `state.json` and never
imports a published `candidate.json`, `CANDIDATE_SHA` or a production contour.
For a `local_gate` with `gate_testing[profile][gate].live_postgres`, freeze an
**explicit** `live_postgres.preflight_command`:

```json
{
  "live_postgres": {
  "image": "postgres:16@sha256:<actual 64-hex digest>",
  "command_indexes": [0],
  "preflight_command": "pnpm exec tsx scripts/testing/live-pg-preflight.ts --pipeline-preflight"
  }
}
```

The preflight command is a repository-local `node <script.js>` or
`pnpm exec tsx <script.ts>` (also `corepack pnpm exec tsx`) ending with
`--pipeline-preflight`, without shell composition or arbitrary flags. Its
`validateOnly` mode must use the project's **same** phase-aware evidence resolver
as its live runner, return nonzero on unresolvable/ambiguous runtime or input, and
not create evidence, allocate resources or touch production. This is a contract
for the consumer; the generic runner does not implement project-specific adapters.

The runner checks a clean git checkout, then holds the existing machine heavy
and live slots in their established acquisition order. It creates **one**
`.tmp/pipelines/.runtime-locks` gate lock with PID/PID-start, `phase=plan_probe`,
absolute canonical `manifest_file` under `.tmp/pipelines/<run-id>/`,
`manifest_sha256` of the **raw** draft bytes, `head_sha` and `input_digest`.
The digest is SHA-256(JSON.stringify([
`"plan-probe-input-v1"`, lowercase HEAD SHA, commandsDigest(frozen commands),
{ image, command_indexes, preflight_command }
])). The `manifest_sha256` is audit provenance and may change while PLAN edits
unrelated frozen sections; it does not independently invalidate a probe. The
HEAD, commands and resource contract do invalidate it.

While the lock is held, run the cheap validator **before** allocating a gate
attempt/scratch directory or running Docker/expensive test commands. On nonzero
validation or missing preflight the runner writes `status=BLOCKED`,
`attempt=null`, `preflight_status=FAIL` and no command PASS. On success it
runs the original frozen gate, records `phase`, raw manifest SHA, input digest,
`candidate_sha=null`, cleanup outcome and exits without leaving phase locks.
The existing project live resource lifecycle remains authoritative; cleanup
failures turn the result into BLOCKED.

For PLAN acceptance a live probe must bind the exact pipeline (no cross-pipeline
reuse), its frozen HEAD, commands and resource contract, with successful
`preflight_status`. Legacy non-live probe behavior is unchanged. Existing RUN
state/candidate resolution remains unchanged. This source contract requires a
separate actual-adapter integration test; generic fake-Docker PASS cannot verify
a consumer's phase resolver.

### Deployed-service provenance

For a frozen `input_kind: "deployed-service"` local gate, the existing
`gate-runner-cli.ts` requires the preceding `dev_deploy` stage to be
`completed`, the exact published candidate from `candidate.json` (including
run/branch/manifest/remote SHA checks), and the existing
`dev-deploy-cli.ts` proof. Its verifier reads the root-owned current target
record from `OPENCODE_DEPLOY_STATE_DIR` (default:
`/var/lib/opencode/deploy-targets`), checks the target key, installed candidate
SHA, successful install and installed timestamp after stage start, plus a
candidate-referencing service status file. **Only then** can the smoke commands
run. It passes the verified contour key as `PIPELINE_DEPLOY_TARGET` and rechecks
candidate and contour identity before accepting their PASS result. The gate evidence records `deployed_service` provenance; it does not
deploy, modify the target, or create a second installation store.

The target state is a read-only point-in-time observation; if the target changes
during the smoke, external services may change independently. Do not describe
this as a cryptographic attestation or as a production deployment test.

## Declared gate input (new PLANs)

A local gate may freeze `gate_testing[profile][gate].input_kind`, which is
validated by the existing gate policy rather than a second executor:

- `tree`: test/check the working tree; the local gate must be **before** `git_publish` and cannot require `{candidate_sha}`.
- `candidate`: must follow `git_verify` and the `git_publish` producer; every frozen command includes `{candidate_sha}`. The runner checks the canonical publish evidence for the same run, frozen manifest, branch and matching candidate/remote SHA before substitution. This establishes the identity passed to a command, not that a command actually verifies the candidate correctly.
- `deployed-service`: must follow `dev_deploy`, never a PLAN probe.
- `build-output`: consumes an exact artifact emitted by a **preceding** `local_gate` in the same pipeline. Declare `input_kind: "tree", artifact_output: { "path": "dist/bundle.tgz" }` on the producer gate, and `input_kind: "build-output", build_output: { "producer_gate": "assemble" }` on the consumer. Each consumer command includes `{artifact_path}`. Output paths must be exact files in `dist/` or `build/` (not arbitrary source/working paths). Producer commands run **in place** in RUN; PLAN clean-tree probes cannot produce this artifact. The existing runner writes the successful producer's run/pipeline/manifest/source digest and artifact SHA-256 to its normal gate evidence. Consumer requires the producer stage `completed`, verifies those fields and current file bytes **before and after** its commands, and refuses cached PASS for either producing or consuming gates. No separate artifact cache, implicit build, or post-publish source mutation is permitted. Output persistence follows the checkout's local build lifecycle, so a missing or cleaned artifact forces a fresh build instead of a false PASS.

Existing frozen manifests that omit `input_kind` retain their previous behavior.
This declaration does not replace `git_verify`, runner snapshot identity, SHA checks,
or a final full gate. Mark tree-only expensive suites before publish; post-publish
candidate checks must verify the same committed candidate, not a mutable checkout.

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
   `ignored_input_rules` (legacy patterns with optional `except`). For new
   freezes use **reviewed exact repo-relative documentation/handoff paths**.
   A glob or unverified rule remains compatible but cannot narrow test selection:
   it triggers a conservative full fallback. Do not include webmanifest/icons,
   test contracts, CI or AGENTS.md as excluded inputs.
3. Preflight, dispatch, the runner and completion all read the snapshot; a changed
   snapshot or command array blocks with `GATE_TESTING_SOURCE_*`.

Selection with a bound map: ignored inputs remove only known exact *incremental*
work-item changes after SHA validation of the frozen source and a verified baseline.
Inline `ignored_inputs` beside `source` is rejected (`GATE_TESTING_SOURCE_CONFLICT`).
Mandatory security/dependency/test-contract changes take precedence over exclusions;
`previousFailures` are rechecked even for an ignored-only diff. Ignored-only
selection has `incremental_selection_status: not_applicable` (not a full-gate PASS);
unbound, invalid, legacy-glob or unknown/new changes conservatively select full
checks. Coordinator-only and final gates retain their frozen commands.
A new test file runs
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
complete array. A new test file runs alone with the command that owns tests in its directory, or,
in a new test folder, with the single command whose tests sit under its nearest parent directory;
two commands there leave it unmapped. `selection_reason` names the first unmapped path.
Final authoritative gates always cover the original complete array. No
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
- Reuse is per command for **source-only evidence**: an already passing command with proven identical source, toolchain and environment may be reused (`commands_reused`) in advisory and authoritative runs. Commands backed by a disposable `live_postgres` container, `artifact_output` producers and `input_kind: build-output` / `input_kind: deployed-service` consumers are **always executed** for each gate attempt: earlier PASS does not prove the new database/service state. Unrelated pure commands in the same gate may still be reused. Local ignored files copied into a gate snapshot, and local nontracked configuration files that an in-place fallback can read, are hashed into the aggregate reuse identity. The runner rejects reuse if that input set changes during the attempt; it does not persist the contents. If snapshot copying fails, it falls back to in-place validation instead of silently omitting the input.
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
serves every pipeline that shares the frozen profile. A PASS plan probe (below) for the same profile/gate at the same clean HEAD with equal `commands_sha256` satisfies the requirement without a rerun; a FAIL plan probe counts like a FAIL base probe.

## Gate environment and PLAN probe

Every command a gate runs (authoritative and advisory) gets, besides the process env and any
`live_postgres` env: `PIPELINE_RUN_ID`, `PIPELINE_ID`, `PIPELINE_GATE`; `PIPELINE_GATE_ATTEMPT`
(1-based count of runs of that evidence file, stored as `attempt`); `CANDIDATE_SHA` (only when a
candidate is loaded: non-advisory run with a PASS `candidate.json`, same value as
`{candidate_sha}`; otherwise it is removed from the command env); `PIPELINE_SCRATCH_DIR`, a fresh
empty directory `<state-root>/<run-id>/scratch/<pipeline>-<gate><suffix>-<attempt>` created before
the first command and recorded as `scratch_dir` in the evidence. Gates install and write there,
never into the source tree, and take identity and install roots from these vars, not from owner
shell. None of them enters `environment_digest`, so evidence reuse is unaffected.

`gate-runner-cli.ts --plan-probe <manifest-path> <pipeline-id> <gate>` runs the complete frozen
command set of one local gate against the draft `.tmp/pipelines/<run>/manifest.json` before any
`state.json` exists (no approval, no reuse, clean checkout required like `--base-probe`,
`live_postgres` provisioned as usual, `CANDIDATE_SHA` unset). Gates with `{candidate_sha}` or a
runtime/deploy/release/smoke/install name are refused (`PLAN_PROBE_UNSUPPORTED`). Evidence:
`<manifest-dir>/planning/probes/<pipeline>-<gate>.json` with `kind: "plan_probe"`, `status`
PASS|FAIL|BLOCKED, `run_id`, `pipeline_id`, `gate`, `profile`, `head_sha`, `base_sha`,
`commands_sha256` (sha256 of `JSON.stringify` of the frozen command array of that profile/gate,
exported as `planProbeCommandsSha256`), `attempt`, `scratch_dir`, `results` (per command as in the
base probe, with `failure_summary`/`output_tail`), `started_at`, `completed_at`, `duration_ms`,
`error`. FAIL means the suite is red on the base (baseline repair or gate fix before approval);
BLOCKED means the gate could not start (fix env/resources in the gate contract).

At RUN, post-publish gates (dev-install, release checks needing the candidate) are not probed in PLAN; they get `CANDIDATE_SHA` and `PIPELINE_SCRATCH_DIR` from the gate environment when they run, so OpenStage never asks the owner for an identity or install root.

## Gates on a tree snapshot

Authoritative gates (except runtime/deploy/release/smoke/install gates and commands with
`{candidate_sha}`) and `--coordinator` checks run on a snapshot, not in the checkout. The runner builds
a commit object of the working tree with a private index (tracked files plus the untracked files the
source inventory covers; no ref, branch or main index changes), checks it out as a detached worktree
under `~/.cache/opencode-pipeline/snapshots` (`PIPELINE_SNAPSHOT_DIR`), copies ignored local files
outside dependency/build directories, links `.tmp/pipelines` back to the run state root, hard-links the
checkout's dependency trees (root and per-package `node_modules`, `snapshot.dependency_trees`; a copy
across filesystems) so the snapshot resolves exactly what the checkout resolves, and runs the commands
there. Only a checkout without installed dependencies gets a lockfile restore (`--prefer-offline`;
evidence `checks/<pipeline>-<gate>-snapshot-install.json`). The source inventory hashes content plus
the executable bit, so a checkout and its snapshot with the same bytes have the same digest whatever
their other permission bits. `source_digest` describes the snapshot. The worktree is removed afterwards
(`PIPELINE_KEEP_SNAPSHOT=1` keeps it for diagnosis). If the snapshot cannot be built or prepared the
gate runs in place and `snapshot.status` is `unavailable` with the reason; `--in-place` (or
`PIPELINE_GATE_SNAPSHOT=0`) always runs in place.

On FAIL the runner compares the snapshot with the current checkout. When changed paths reach a failed
command through the frozen impact map (unmapped and dependency changes reach every command), it moves
the worktree to a fresh snapshot and runs again the failed and not yet run commands plus passed ones the
changes reach; `snapshot.rerun` records the first attempt and only the second result counts. Otherwise
the FAIL stands with `snapshot.failure_check`. Evidence carries `snapshot.lane_scope` (the lane's work
item paths, declared exclusive/migration/fixture paths and scope-check paths of its agent stages) and
`lane_scope_digest` over those files minus `generated_paths` (`lane_exclude`; the coordinator rewrites
them for every lane); completion of the `local_gate` stage refuses it with `EVIDENCE_STALE_LANE_SOURCE`
once those files differ in the checkout. From the lane's last agent stage until its ready milestone its
planned paths (work items, declared exclusive/migration/fixture paths) are reserved against other
pipelines' dispatch and scope-check; shared paths scope-check granted at runtime stay free, and a change
to them reaches that check and a partial rerun instead of a wait.

A gate whose previous evidence is a PASS on a snapshot (same manifest and environment) repeats only the
commands the changes between the two snapshot commits reach through the impact map; the others keep
their PASS (`snapshot.reused_by_impact`). Unmapped and dependency changes reach every command, and
`--no-reuse` runs the full set.

A project's live harness sees the snapshot directory as its repository root. It must take the root from
its own location (not a fixed path) and accept `.tmp/pipelines` being a link to the run state root.

## Disposable PostgreSQL

The runner creates a separate container for the selected live commands, waits
for readiness, and injects `LIVE_PG_TEST`, `LIVE_PG_CONTOUR`, `DATABASE_URL` only
into those subprocesses. It uses a random temporary password and a random
loopback port, a non-root user, dropped capabilities, read-only root filesystem,
512 MiB memory, one CPU, bounded PIDs and tmpfs storage. There are no host mounts,
persistent volumes, host network or privileged mode. Project tests own migrations
and fixtures; the runner does not guess SQL or migrate a working contour.

Live commands run one at a time on the machine. Before the first of a run of consecutive live
commands the runner takes the machine-wide live slot (`~/.cache/opencode-pipeline/live-gate.lock`,
waited for, never failed; `live_slot_wait_ms` in the evidence), writes the gate's lock
`gate:<run>:<pipeline>:<gate>` into `<state-root>/.runtime-locks/`, and starts the container; all three
are released before the next non-live command. A project's live harness may therefore rely on
`.runtime-locks` holding exactly one `gate:` lock while a live command runs. Runtime/release gates keep
their locks there for the whole run. Two runs of one lane gate (two work items checking in parallel)
queue on `<state-root>/.gate-locks/` instead of failing.

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


## Candidate-contour lifecycle supervisor (Issue #60)

A post-publish disposable-contour gate uses the existing `local_gate` executor and the
new `gate_testing[profile][gate].input_kind: "candidate-contour"` contract. It is
**different** from `deployed-service`: the latter still requires a completed
`dev_deploy` with live installed-candidate provenance and is not provisioned by this hook.
A `candidate-contour` gate requires preceding `git_verify` and `git_publish`.
The runner loads their exact published candidate evidence; it does not infer a candidate
from the mutable checkout. PLAN, RUN and the gate runner all validate the same frozen
manifest. Existing manifests are not implicitly migrated.

Example (use actual project commands and the reviewed 64-hex recipe digest):

```json
{
  "gate_profiles": {
    "release": {
      "install-check": [
        "bash scripts/testing/release-parity.sh fresh-install",
        "bash scripts/testing/release-parity.sh upgrade-install"
      ]
    }
  },
  "gate_testing": {
    "release": {
      "install-check": {
        "input_kind": "candidate-contour",
        "timeout_seconds": 3600,
        "lifecycle": {
          "schema_version": 1,
          "producer": "bash scripts/testing/release-contour.sh",
          "handoff_schema": "sevami.release-contour/v2",
          "recipe_digest": "REPLACE_WITH_REVIEWED_64_HEX_SHA256",
          "exclusive_lock": "sevami-dev-provider-tokens",
          "commands": [
            { "command": "bash scripts/testing/release-parity.sh fresh-install", "operation": "fresh" },
            { "command": "bash scripts/testing/release-parity.sh upgrade-install", "operation": "upgrade" }
          ]
        }
      }
    }
  }
}
```

The example digest placeholder is deliberately INVALID. Every frozen command must occur
exactly once in the lifecycle command mapping. Operations are `fresh` or `upgrade`;
a `service-health` command can bind to `fresh` without masquerading as `deployed-service`.
Mappings use exact command **text**, never array indexes. Each command receives a unique
nested attempt scratch/lease and a fresh producer-owned contour. No command-level PASS
reuse, impact reuse, automatic timeout retry or snapshot rerun is allowed on lifecycle
gates; a failed provision must never be silently skipped.

### Producer protocol

The frozen `producer` is only a repository-local `bash <file.sh>`,
`node <file.mjs|file.js>`, or `node --import tsx <file.ts>` entry. It is executed
with `spawn` (no shell) and the following exact subcommands:

- `reap --expired` before each provision and periodically while a gate is running;
- `provision --operation fresh|upgrade --handoff-ref ABS --lease-ref ABS --run-id ID
  --pipeline-id ID --gate ID --attempt N --candidate-sha SHA --nonce HEX
  --recipe-digest SHA256`;
- `heartbeat --lease-ref ABS` every 30 seconds during an active gate;
- `down --lease-ref ABS` in `finally` on all outcomes, including a refusal.
  
The producer owns resource creation, journal-before-create, ownership verification,
lease expiry and owned-only destruction. `reap --expired` MUST refuse a still-valid
live holder and reclaim orphaned resources from interrupted supervisors; it must work
after a supervisor is killed without `finally`. All subcommands exit nonzero on
failure. The runner never executes arbitrary Compose commands or manipulates a target
project's dev contour directly.

The producer writes the handoff as an owner-only (mode 0600), regular absolute-path
JSON file at `--handoff-ref`. It must include:

```text
schema, runId, pipelineId, gate, attempt (integer), candidateSha,
operation, nonce, recipeDigest, expiresAt (future ISO timestamp)
```

The runner verifies each field against the frozen descriptor and exact gate attempt,
hashes the handoff bytes, and injects the following into the **one** frozen gate child:

- `RELEASE_PARITY_CONTOUR_REF` — protected absolute path;
- `RELEASE_PARITY_CONTOUR_EXPECTED_SHA256` and `PIPELINE_LIFECYCLE_HANDOFF_SHA256`
  — the expected SHA-256 of handoff bytes;
- existing `PIPELINE_RUN_ID`, `PIPELINE_ID`, `PIPELINE_GATE`,
  `PIPELINE_GATE_ATTEMPT`, `CANDIDATE_SHA`, `PIPELINE_SCRATCH_DIR`.

Before accepting result evidence the runner rehashes the handoff. A changed, invalid
or expired handoff is BLOCKED. Child PASS is not finalized until producer `down`
succeeds; cleanup evidence is attached to the normal gate result. A crash or SIGKILL
requires subsequent startup reaping by the producer, not a claim that `finally`
ran. The runner takes a machine-wide `exclusive_lock` (independent of worktree)
for the provision/gate/down window, so shared credential users do not overlap.

`RELEASE_PARITY_INCIDENT_COPY` may be supplied by the operator only as a protected
owner-readable file. Provider references and credentials are operator-managed
environment inputs; the generic runner does not mint, log or stop/start bots.
The producer must report refusals with a **leading machine code on stderr**,
e.g. `DEV_CONTOUR_RUNNING: ...`, and never print secret values. A refusal is not
retried. If the dev contour shares Telegram/MAX tokens, the operator stops it for
the exclusive test window and restarts it after teardown; the generic runner
does neither.

Errors include `GATE_LIFECYCLE_REQUIRED`, `GATE_LIFECYCLE_INVALID`,
`LIFECYCLE_DESCRIPTOR_INVALID`, `LIFECYCLE_HANDOFF_INVALID`,
`LIFECYCLE_HANDOFF_CHANGED`, `LIFECYCLE_INCIDENT_COPY_INVALID`,
`LIFECYCLE_PRODUCER_FAILED` and `LIFECYCLE_CLEANUP_FAILED`.
An unavailable producer or broken handoff is always BLOCKED, not PASS/skipped.
Tests: `node --test config/opencode/skills/task-management/scripts/gate-lifecycle.test.mjs`.

An existing approved manifest requires the regular PLAN revision/amendment flow
before adding or changing this frozen contract; installed OpenCode files must not
be hot-patched. Real SeVami integration requires its repository producer to adopt
this exact CLI/handoff protocol; this document does not assert that it is already deployed.
