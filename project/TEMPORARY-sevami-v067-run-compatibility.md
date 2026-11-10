# Temporary compatibility: SeVami release v0.6.7 frozen RUN

**REMOVE AT THE NEXT UPSTREAM UPDATE. Do not treat as permanent API compatibility.**

Issue: [my-opencode #18](https://github.com/gest0r1/my-opencode/issues/18)

OpenCode RUN live PostgreSQL preflight became mandatory on 2026-11-06, after
SeVami v0.6.7 frozen gate profiles were already established without
`live_postgres.preflight_command`. Rewriting the signed manifest or state hash
is forbidden. This bridge permits **only** `release-v0.6.7` (optionally a
SeVami prefix or safe suffix), in-progress RUNs with a pre-existing execution
start before 2026-11-11 UTC, the exact `release/fail-fast` frozen command
array, the exact historical PG image digest and only live index 9.

The bridge skips only the **new cheap preflight invocation** and preserves
existing frozen full vitest execution, live disposable PostgreSQL provisioning,
Docker resource guards, evidence and cleanup. Other RUNs remain fail-closed.
It is not permission to alter the manifest or waive acceptance criteria.

**Removal checklist for the next upstream sync:**
1. Verify that SeVami v0.6.7 is finished or superseded.
2. Remove `legacy-live-preflight-v067.mjs`, its import/guard in
   `gate-runner-cli.ts`, and its tests.
3. Ensure all **new** SeVami gate profiles include the real
   `--pipeline-preflight` adapter and test their frozen preflight.
4. Run the gate-runner and pipeline-contract regression suites.

Current deployment status: implementation in repository only; no access to the
user's running process, so the exact current RUN ID and activation on the
installed host have not been observed.
