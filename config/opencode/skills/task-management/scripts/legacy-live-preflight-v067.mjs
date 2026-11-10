// TEMPORARY UPSTREAM-UPGRADE COMPATIBILITY — REMOVE ON THE NEXT UPSTREAM UPDATE.
// Issue: gest0r1/my-opencode#18; affected active SeVami release-v0.6.7 RUN only.
// The 2026-11-06 RUN preflight change was not backward compatible with this
// already-frozen manifest. This exact legacy exception DOES NOT relax live PG,
// frozen command identity, Docker isolation, tests, cleanup or evidence checks.
// Do not extend to new runs; remove this file, its import and tests on upgrade.
const LAST_ELIGIBLE_RUN_START = Date.parse('2026-11-11T00:00:00Z');
const LEGACY_LIVE_PG_IMAGE = "postgres:16@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d";
const LEGACY_COMMANDS = [
  "corepack pnpm run build",
  "corepack pnpm run typecheck",
  "corepack pnpm run lint",
  "corepack pnpm exec vitest run packages --passWithNoTests=false",
  "corepack pnpm exec vitest run apps/api --passWithNoTests=false",
  "corepack pnpm exec vitest run apps/worker --passWithNoTests=false",
  "corepack pnpm exec vitest run apps/telegram-bot apps/max-bot --passWithNoTests=false",
  "corepack pnpm exec vitest run scripts/testing --passWithNoTests=false",
  "corepack pnpm exec vitest run --root apps/web --config vitest.config.ts --passWithNoTests=false",
  "corepack pnpm exec vitest run --config vitest.live.config.ts --passWithNoTests=false"
];

export function isLegacySevami067Run({ state, manifest, pipeline, runId, gate, commands, config }) {
  // Narrow release-specific scope; no environment bypass and no manifest edits.
  if (!/^(?:sevami[-_])?release[-_]v0\.6\.7(?:[-_][A-Za-z0-9._-]+)?$/.test(runId) ||
      manifest?.run_id !== runId || state?.run_id !== runId ||
      state?.status !== 'in_progress' || pipeline?.profile !== 'release' ||
      gate !== 'fail-fast' || !config?.live_postgres || config?.live_postgres.preflight_command !== undefined ||
      !Array.isArray(config.live_postgres.command_indexes) ||
      config.live_postgres.command_indexes.length !== 1 || config.live_postgres.command_indexes[0] !== 9 ||
      config.live_postgres.image !== LEGACY_LIVE_PG_IMAGE ||
      !Array.isArray(commands) || commands.length !== LEGACY_COMMANDS.length ||
      !commands.every((command, index) => command === LEGACY_COMMANDS[index])) return false;
  if (state?.schema_version !== 1 || manifest?.schema_version !== 2) return false;
  // This is for the only already-running v0.6.7 job. Fresh runs started after
  // this compatibility patch's creation are always required to use preflight.
  const created = Date.parse(state?.created_at ?? '');
  const started = Date.parse(state?.execution_started_at ?? '');
  return Number.isFinite(created) && Number.isFinite(started) &&
    created <= started && started < LAST_ELIGIBLE_RUN_START;
}
