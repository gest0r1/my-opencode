import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPipelineCapabilities } from './capability-preflight.mjs';

const workers = ['ContextScout', 'ExternalScout', 'StoryMapper', 'SeniorStoryReviewer', 'ArchitectureAnalyzer', 'ContractManager', 'PrioritizationEngine', 'SeniorTechnicalPlanReviewer', 'TaskManager', 'CoderAgent', 'BuildAgent', 'CodeReviewer', 'TestEngineer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist'];
const valid = { tools: ['read', 'shell', 'subagent', 'pipeline_runtime_prepare'].map(id => ({ id })), agents: workers.map(id => ({ id, mode: 'subagent' })), skills: [{ name: 'task-management' }], permissions: workers.map(resource => ({ action: 'subagent', resource, effect: 'allow' })) };
test('live model catalog detects wrong provider and preserves the exact plugin suffix', () => {
  const input = {...valid, agents: valid.agents.map(a => a.id === 'SeniorTechnicalPlanReviewer' ? {...a, model: 'claude-code/claude-opus-5-5[1m]'} : a),
    models: [{providerID: 'claude-code', id: 'claude-opus-5-5[1m]'}]};
  assert.equal(assertPipelineCapabilities(input).status, 'PASS');
  assert.throws(() => assertPipelineCapabilities({...input, models: []}), /MODEL_CATALOG_UNAVAILABLE/);
  assert.throws(() => assertPipelineCapabilities({...input, models: [{providerID: 'anthropic', id: 'claude-opus-5-5[1m]'}]}), /PIPELINE_MODEL_UNAVAILABLE/);
  assert.throws(() => assertPipelineCapabilities({...input, models: [{providerID: 'claude-code', id: 'claude-opus-5-5'}]}), /PIPELINE_MODEL_UNAVAILABLE/);
});
test('preflight checks exact worker IDs and live availability, including permissions and per-session tools', () => {
  assert.equal(assertPipelineCapabilities(valid).status, 'PASS');
  for (const mutation of [{ tools: [] }, { agents: valid.agents.filter(x => x.id !== 'CoderAgent') }, { skills: [] }, { visibleTools: ['read', 'shell'] }, { permissions: [{ action: 'subagent', resource: '*', effect: 'deny' }] }]) {
    assert.throws(() => assertPipelineCapabilities({ ...valid, ...mutation }), /PIPELINE_CAPABILITY_UNAVAILABLE/);
  }
  assert.throws(() => assertPipelineCapabilities({ ...valid, agents: valid.agents.map(x => ({ ...x, mode: 'primary' })) }), /subagent/);
  assert.equal(valid.permissions.every(x => x.action === 'subagent'), true);
});


test('a live tool-level denial overrides worker delegation grants', () => {
  assert.throws(() => assertPipelineCapabilities({ ...valid, permissions: [...valid.permissions, {action: "subagent", resource: "*", effect: "deny"}] }), /permission:subagent:CoderAgent:deny/);
});
