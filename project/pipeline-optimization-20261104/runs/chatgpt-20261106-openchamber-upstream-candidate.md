# OpenChamber upstream merge draft — 2026-11-06

## Disposition

A review-only OpenChamber candidate is recorded as an **unreferenced Git tree**:

- Candidate tree: `a4018d99f425573e1e7de9f058764cd379253195`
- Base review tree: `73c05c4197b59044748f5af91b92809ba4dbd5e1`
- Draft report and release notes are stored in the candidate as `UPSTREAM_CONFLICT_REVIEW_20261106.md`, `UPSTREAM_RELEASE_REVIEW_20261106.md`, and `UPSTREAM_MERGE_DRAFT_20261106.md`.

No OpenChamber source branch, `main`, release, install, production or paid Actions were changed. The only planned branch write in this run is this documentation note in the my-opencode feature branch.

## What was prepared

The draft tree overlays 18 source-file conflict proposals on the 80 clean three-way merges from the prior candidate. It includes the release proposal at `.github/workflows/release.yml` and removes a duplicate call to `sessionRuntime.processOpenCodeSsePayload` found during event-flow review.

The release proposal follows the repository's existing fork policy: immutable source-SHA authorization, exact-SHA package reuse, x64 Windows/Linux, Android, draft uploads and final asset verification. The fork policy checker explicitly rejects macOS, arm64, npm publication, external runners and Actions artifact aggregation. These upstream release targets were not enabled as an incidental merge decision.

## Verification

- The release proposal parses as YAML; all seven jobs have existing `needs` dependencies.
- Static inventory review matched the finalizer's expected web, Windows, Linux and Android assets to upload producers.
- An isolated harness using the available release test scripts reported **7/8 tests passing**.
- `scripts/check-fork-release-policy.mjs`: **PASS**.
- The failing assertion is in `scripts/release-workflow-contract.test.mjs`: it requires literal `draft: false`. The proposal publishes via `gh api --method PATCH ... -F draft=false`, so the assertion does not recognize the equivalent finalization mechanism. Align the contract test or implementation before acceptance.
- Node syntax checks for the prepared JavaScript files, JSON registry parsing, locale-key duplicate scan, and workflow syntax checks passed.

The test harness used the available local OpenChamber worktree at `0cdcea71c6dd6c3912b3899ffde69bbedf27809c` plus the draft workflow; it was not a clean checkout of the target feature branch. Bun, full TypeScript/unit/integration tests, builds, release secrets, draft-resume behavior against the pinned action, installation, rollback, and platform release runs were **not tested**.

## Refs and next gate

OpenChamber feature remained `06afd56dffe3e0fc0c2863d0017ae243b037cc1b`; OpenChamber main remained `f9521f168c894cb17dc60ba4f929d4df0722e263`. No source ref was advanced.

The candidate is not ready to merge, install or test as a complete source tree. Continue with a clean full checkout, resolve remaining caller/space-event and generated-changelog questions, run OpenChamber's required checks in a Bun-equipped environment, and resolve the release contract-test mismatch. This note does not claim source acceptance or rollout readiness.
