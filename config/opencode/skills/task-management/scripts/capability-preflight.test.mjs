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

const researchInput = (id = 'ArchitectureAnalyzer') => ({
  ...valid,
  tools: [...valid.tools, {id: 'webfetch'}, {id: 'gh_grep_searchGitHub'}, {id: 'context7_query-docs'}],
  agents: [...valid.agents.filter(a => a.id !== id), {id, mode: 'subagent', permissions: [
    {action: '*', resource: '*', effect: 'deny'},
    ...['webfetch', 'gh_grep_*', 'context7_*'].map(action => ({action, resource: '*', effect: 'allow'})),
  ]}],
  permissions: [...valid.permissions, {action: 'subagent', resource: id, effect: 'allow'}],
  researchAgents: [id],
});

test('research is conditional and checks child tools rather than parent visibility', () => {
  assert.deepEqual(assertPipelineCapabilities(valid).research_checked, []);
  const input = {...researchInput(), visibleTools: valid.tools.map(t => t.id)};
  assert.equal(assertPipelineCapabilities(input).research_checked[0].agent, 'ArchitectureAnalyzer');
  assert.throws(() => assertPipelineCapabilities({...input, tools: valid.tools}), /research:ArchitectureAnalyzer/);
  assert.throws(() => assertPipelineCapabilities({...input, researchAgents: ['UnknownAgent']}), /invalid research_agents/);
});

test('research honors effective last-match tool permissions and permits available fallbacks', () => {
  const input = researchInput();
  const denied = input.agents.map(a => a.id === 'ArchitectureAnalyzer' ? {...a, permissions: [...a.permissions,
    {action: 'webfetch', resource: '*', effect: 'deny'}]} : a);
  assert.throws(() => assertPipelineCapabilities({...input, agents: denied}), /research:ArchitectureAnalyzer:webfetch/);
  assert.equal(assertPipelineCapabilities({...input, tools: input.tools.filter(t => !t.id.startsWith('gh_grep_'))}).status, 'PASS');
  assert.throws(() => assertPipelineCapabilities({...input, tools: input.tools.filter(t => !t.id.startsWith('gh_grep_') && !t.id.startsWith('context7_'))}), /search-or-docs/);
});

test('WebResearcher is checked only when selected, including delegation and model availability', () => {
  const input = researchInput('WebResearcher');
  assert.equal(assertPipelineCapabilities(input).subagents_checked, workers.length + 1);
  assert.throws(() => assertPipelineCapabilities({...input, agents: valid.agents}), /subagent:WebResearcher/);
  assert.throws(() => assertPipelineCapabilities({...input, permissions: valid.permissions}), /permission:subagent:WebResearcher:ask/);
  const agents = input.agents.map(a => a.id === 'WebResearcher' ? {...a, model: 'opencode-go/longcat-2.5-preview-free'} : a);
  assert.throws(() => assertPipelineCapabilities({...input, agents, models: [{providerID: 'openai', id: 'other'}]}), /PIPELINE_MODEL_UNAVAILABLE: WebResearcher/);
});
