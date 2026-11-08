# Exact test invocations — 2026-11-06

Input: `891a5c53d0fd3325e208402cf48fee5cdddc8c55`.

CWD: `/workspace/scratch/33c68a33a56d/review-20261106/my-opencode`.

Environment qualification: Node24.22.1, cached tsx4.21.0 loader, available plugin2.0.23, not source pins. No source module stubs. The isolated `npx --yes tsx` shim delegates to the real loader; a direct `.bin/tsx` loader entrypoint was added for the single plan-check retest. These are environment adaptations, not upstream or implementation edits.

```sh
node --test --test-concurrency=1 \
 config/opencode/skills/task-management/scripts/build-output-proof.test.mjs \
 config/opencode/skills/task-management/scripts/gate-testing-policy.test.mjs \
 config/opencode/skills/task-management/scripts/gate-snapshot-inputs.test.mjs \
 config/opencode/skills/task-management/scripts/gate-reuse-identity.test.mjs \
 config/opencode/skills/task-management/scripts/orchestrator-wake.test.mjs \
 config/opencode/skills/task-management/scripts/plan-probe-identity.test.mjs

PATH=/workspace/scratch/33c68a33a56d/isolated/bin:$PATH node --test --test-concurrency=1 \
 config/opencode/skills/task-management/scripts/gate-runner-cli.test.mjs \
 config/opencode/skills/task-management/scripts/pipeline-runtime.test.mjs \
 config/opencode/skills/task-management/scripts/pipeline-v2-contract.test.mjs

PATH=/workspace/scratch/33c68a33a56d/isolated/bin:$PATH node --test --test-concurrency=1 \
 config/opencode/skills/task-management/scripts/gate-snapshot.test.mjs \
 config/opencode/skills/task-management/scripts/dev-deploy-cli.test.mjs \
 config/opencode/skills/task-management/scripts/reuse-report.test.mjs \
 config/opencode/skills/task-management/scripts/contextscout-path-check.test.mjs \
 config/opencode/skills/task-management/scripts/owner-amendment-git-gate.test.mjs

bash tests/test_contextscout_installation.sh
node scripts/check-opencode-pins.mjs

PATH=/workspace/scratch/33c68a33a56d/isolated/bin:$PATH node --test \
 --test-name-pattern='plan-check runs preflight' \
 config/opencode/skills/task-management/scripts/pipeline-v2-contract.test.mjs

# Copy the saved review-repros.test.mjs.txt beside gate-runner-cli.test.mjs first.
PATH=/workspace/scratch/33c68a33a56d/isolated/bin:$PATH node \
 --import /workspace/scratch/061630f1d1c5/openchamber-work/node_modules/tsx/dist/loader.mjs \
 --test config/opencode/skills/task-management/scripts/review-only-repros.test.mjs

# Diagnostic only, not an official build configuration:
node /workspace/scratch/3f59319e8729/sevami/node_modules/typescript-compiler-api/lib/tsc.js \
 --noEmit --strict false --allowImportingTsExtensions \
 --module NodeNext --moduleResolution NodeNext --target ES2023 --skipLibCheck \
 --types node --typeRoots /workspace/scratch/3f59319e8729/sevami/node_modules/@types \
 config/opencode/skills/task-management/scripts/gate-runner-cli.ts \
 config/opencode/skills/task-management/scripts/stage-cli.ts \
 config/opencode/plugins/pipeline-runtime.ts
```

The TypeScript executable in the last command is version6.0.3; the historical dependency directory was read only. No SeVami repository source was read or changed in this review. Source files were materialized with 436/436 matching remote blob SHA and remained unchanged after tests.

Snapshot fixture diagnosis was a copy of its original test with only an added print of `evidence.reuse_disabled_reason`, executed with the one name pattern `a gate that passed on an earlier snapshot`. Removing only the inherited test `NODE_PATH` exposed the missing local vitest fixture. No production env sanitization was changed.

All test sessions completed. No production processes, real Docker resources or server restarts were used.
