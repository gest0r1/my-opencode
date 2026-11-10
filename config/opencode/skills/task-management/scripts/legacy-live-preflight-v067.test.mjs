import test from 'node:test';
import assert from 'node:assert/strict';
import { isLegacySevami067Run } from './legacy-live-preflight-v067.mjs';

const commands = [
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
const live = {"image":"postgres:16@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d","command_indexes":[9]};
function eligible() {
  const runId='release-v0.6.7';
  return {runId, state: {run_id:runId,schema_version:1,status:'in_progress',
    created_at:'2026-11-04T12:00:00Z',execution_started_at:'2026-11-05T10:00:00Z'},
    manifest:{run_id:runId,schema_version:2},pipeline:{profile:'release'},gate:'fail-fast',
    commands:[...commands],config:{live_postgres:{...live,command_indexes:[9]}}};
}
test('legacy v0.6.7 full frozen fail-fast resumes unchanged live PostgreSQL gate', () => {
  assert.equal(isLegacySevami067Run(eligible()), true);
});
test('no legacy exemption for a new run, changed command, changed PostgreSQL contract, or arbitrary profile', () => {
  const variations=[
    {runId:'new-release-v0.6.7'},
    {runId:'release-v0.6.8'},
    {state:{...eligible().state,execution_started_at:'2026-11-11T01:00:00Z'}},
    {state:{...eligible().state,status:'approved'}},
    {state:{...eligible().state,execution_started_at:undefined}},
    {state:{...eligible().state,schema_version:2}},
    {manifest:{...eligible().manifest,schema_version:3}},
    {pipeline:{profile:'other'}},
    {gate:'build'},
    {config:{live_postgres:{...live,command_indexes:[8]}}},
    {config:{live_postgres:{...live,preflight_command:'node preflight.js --pipeline-preflight'}}},
    {config:{live_postgres:{...live,image:'postgres:16@sha256:'+'f'.repeat(64)}}},
    {commands:commands.map((x,i)=>i===9 ? x.replace('vitest.live','vitest.unit'):x)},
    {commands:commands.slice(1)},
  ];
  for(const mutation of variations)
    assert.equal(isLegacySevami067Run({...eligible(),...mutation}),false,JSON.stringify(Object.keys(mutation)));
});
test('compatibility matches only the original frozen 10-command profile with one live index', () => {
  const original=eligible();
  assert.equal(original.commands[9].includes('vitest.live.config.ts'),true);
  assert.equal(original.config.live_postgres.command_indexes[0],9);
  assert.equal(isLegacySevami067Run(original),true);
});
