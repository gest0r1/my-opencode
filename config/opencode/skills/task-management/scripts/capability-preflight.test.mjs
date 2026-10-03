import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPipelineCapabilities } from './capability-preflight.mjs';

const workers = ['ContextScout', 'ExternalScout', 'StoryMapper', 'SeniorStoryReviewer', 'ArchitectureAnalyzer', 'ContractManager', 'PrioritizationEngine', 'SeniorTechnicalPlanReviewer', 'TaskManager', 'CoderAgent', 'BuildAgent', 'CodeReviewer', 'TestEngineer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist'];
const valid = { tools: ['read', 'shell', 'subagent', 'pipeline_runtime_prepare'].map(id => ({ id })), agents: workers.map(id => ({ id, mode: 'subagent' })), skills: [{ name: 'task-management' }], permissions: workers.map(resource => ({ action: 'subagent', resource, effect: 'allow' })) };
test('preflight checks exact worker IDs and live availability, including permissions and per-session tools', () => {
  assert.equal(assertPipelineCapabilities(valid).status, 'PASS');
  for (const mutation of [{ tools: [] }, { agents: valid.agents.filter(x => x.id !== 'CoderAgent') }, { skills: [] }, { visibleTools: ['read', 'shell'] }, { permissions: [{ action: 'subagent', resource: '*', effect: 'deny' }] }]) {
    assert.throws(() => assertPipelineCapabilities({ ...valid, ...mutation }), /PIPELINE_CAPABILITY_UNAVAILABLE/);
  }
  assert.throws(() => assertPipelineCapabilities({ ...valid, agents: valid.agents.map(x => ({ ...x, mode: 'primary' })) }), /subagent/);
  assert.equal(valid.permissions.every(x => x.action === 'subagent'), true);
});
