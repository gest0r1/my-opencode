import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOwnerAmendmentEvidence } from './owner-amendment-policy.ts';

const manifest = {
  pipelines: [
    {
      id: 'onboarding',
      stages: ['implementation', 'review', 'owner-accept'],
      executors: {
        implementation: 'agent',
        review: 'review',
        'owner-accept': 'owner_acceptance',
      },
      work_items: ['WI-42-ONBOARD-SERVICE-001', 'WI-42-ONBOARD-HOURS-001'],
    },
  ],
  work_items: [
    { id: 'WI-42-ONBOARD-SERVICE-001', pipeline_id: 'onboarding', path: 'work-items/service.json', sha256: 'a'.repeat(64) },
    { id: 'WI-42-ONBOARD-HOURS-001', pipeline_id: 'onboarding', path: 'work-items/hours.json', sha256: 'b'.repeat(64) },
  ],
};

function amendment(overrides = {}) {
  return {
    kind: 'owner_amendment',
    status: 'ready',
    bounded: true,
    pipeline_id: 'onboarding',
    source_stage: 'owner-accept',
    target_stage: 'implementation',
    work_item_id: 'WI-42-ONBOARD-SERVICE-001',
    new_work_item_required: false,
    summary: 'Reuse the existing service creation form from onboarding',
    paths: [
      'apps/web/src/pages/owner/OnboardingPage.tsx',
      'apps/web/src/pages/owner/ServiceCreateForm.tsx',
    ],
    work_items: [],
    requirements_changed: true,
    acceptance_criteria_changed: true,
    business_intent_changed: false,
    external_contract_changed: false,
    security_boundary_changed: false,
    destructive_change: false,
    ...overrides,
  };
}

test('bounded owner amendment may add files/components while staying in the existing frozen work item', () => {
  const result = validateOwnerAmendmentEvidence(
    amendment(),
    manifest,
    'onboarding',
    'owner-accept',
  );
  assert.equal(result.work_item_id, 'WI-42-ONBOARD-SERVICE-001');
  assert.equal(result.new_work_item_required, false);
  assert.deepEqual(result.work_items, []);
  assert.ok(result.paths.includes('apps/web/src/pages/owner/ServiceCreateForm.tsx'));
});

test('new independently scoped work item is a hard full-replan boundary', () => {
  assert.throws(
    () => validateOwnerAmendmentEvidence(
      amendment({ new_work_item_required: true }),
      manifest,
      'onboarding',
      'owner-accept',
    ),
    /FULL_REPLAN_REQUIRED_NEW_WORK_ITEM/,
  );
});

test('runtime work item injection is rejected even when new_work_item_required is falsely marked false', () => {
  assert.throws(
    () => validateOwnerAmendmentEvidence(
      amendment({
        work_items: [{ id: 'WI-RUNTIME-NEW' }],
      }),
      manifest,
      'onboarding',
      'owner-accept',
    ),
    /FULL_REPLAN_REQUIRED_NEW_WORK_ITEM/,
  );
});

test('work_item_id must already be frozen and mapped to this pipeline', () => {
  assert.throws(
    () => validateOwnerAmendmentEvidence(
      amendment({ work_item_id: 'WI-NEW' }),
      manifest,
      'onboarding',
      'owner-accept',
    ),
    /FULL_REPLAN_REQUIRED_NEW_WORK_ITEM/,
  );
});

test('local AC changes are allowed but structural PLAN changes require full replan', () => {
  assert.doesNotThrow(() => validateOwnerAmendmentEvidence(
    amendment({ requirements_changed: true, acceptance_criteria_changed: true }),
    manifest,
    'onboarding',
    'owner-accept',
  ));

  for (const field of [
    'business_intent_changed',
    'external_contract_changed',
    'security_boundary_changed',
    'destructive_change',
  ]) {
    assert.throws(
      () => validateOwnerAmendmentEvidence(
        amendment({ [field]: true }),
        manifest,
        'onboarding',
        'owner-accept',
      ),
      /FULL_REPLAN_REQUIRED/,
      field,
    );
  }
});

test('boundary flags are fail-closed and must be explicit booleans', () => {
  const value = amendment();
  delete value.external_contract_changed;
  assert.throws(
    () => validateOwnerAmendmentEvidence(value, manifest, 'onboarding', 'owner-accept'),
    /external_contract_changed must be explicit true\|false/,
  );
});

test('post-freeze owner amendment paths must be exact and may not use directory wildcards', () => {
  assert.throws(
    () => validateOwnerAmendmentEvidence(
      amendment({ paths: ['apps/web/src/pages/owner/**'] }),
      manifest,
      'onboarding',
      'owner-accept',
    ),
    /exact safe repository paths/,
  );
});
