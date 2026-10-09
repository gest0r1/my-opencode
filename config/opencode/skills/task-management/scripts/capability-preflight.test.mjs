import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPipelineCapabilities } from './capability-preflight.mjs';

const workers = ['ContextScout', 'ExternalScout', 'StoryMapper', 'SeniorStoryReviewer', 'ArchitectureAnalyzer', 'ContractManager', 'PrioritizationEngine', 'SeniorTechnicalPlanReviewer', 'TaskManager', 'CoderAgent', 'BuildAgent', 'CodeReviewer', 'TestEngineer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist'];
const advisoryPermissions = [
  {action: 'bash', resource: '*', effect: 'deny'},
  {action: 'bash', resource: 'npx tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts * --advisory*', effect: 'allow'},
];
const coderPermissions = advisoryPermissions;
const testEngineerPermissions = [
  ...advisoryPermissions,
  {action: 'bash', resource: 'pytest *', effect: 'allow'},
];
const devopsPermissions = [
  {action: 'bash', resource: '*', effect: 'deny'},
  {action: 'bash', resource: 'npx tsx $HOME/.config/opencode/skills/task-management/scripts/runtime-diagnostic-cli.ts *', effect: 'allow'},
];
const workerAgent = id => ({ id, mode: 'subagent', ...(id === 'CoderAgent' ? { permissions: coderPermissions } : {}), ...(id === 'TestEngineer' ? { permissions: testEngineerPermissions } : {}), ...(id === 'OpenDevopsSpecialist' ? { permissions: devopsPermissions } : {}) });
const valid = { tools: ['read', 'shell', 'subagent', 'pipeline_runtime_prepare'].map(id => ({ id })), agents: workers.map(workerAgent), skills: [{ name: 'task-management' }], permissions: workers.map(resource => ({ action: 'subagent', resource, effect: 'allow' })) };
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

test('preflight requires live CoderAgent access to the affected advisory runner', () => {
  const denied = valid.agents.map(agent => agent.id === 'CoderAgent'
    ? {...agent, permissions: [{action: 'bash', resource: '*', effect: 'deny'}]}
    : agent);
  assert.throws(() => assertPipelineCapabilities({...valid, agents: denied}), /capability:CoderAgent:advisory-gate-runner/);
  const missing = valid.agents.map(agent => agent.id === 'CoderAgent'
    ? {...agent, permissions: []}
    : agent);
  assert.throws(() => assertPipelineCapabilities({...valid, agents: missing}), /capability:CoderAgent:advisory-gate-runner/);
});

test('preflight requires TestEngineer advisory and targeted-test routes independently', () => {
  const denied = valid.agents.map(agent => agent.id === 'TestEngineer'
    ? {...agent, permissions: [{action: 'bash', resource: '*', effect: 'deny'}]}
    : agent);
  assert.throws(() => assertPipelineCapabilities({...valid, agents: denied}), /capability:TestEngineer:advisory-gate-runner/);

  const advisoryOnly = valid.agents.map(agent => agent.id === 'TestEngineer'
    ? {...agent, permissions: advisoryPermissions}
    : agent);
  assert.throws(() => assertPipelineCapabilities({...valid, agents: advisoryOnly}), /capability:TestEngineer:targeted-test-runner/);
});

test('preflight requires both HTTP and PostgreSQL DevOps diagnostic routes', () => {
  const denied = valid.agents.map(agent => agent.id === 'OpenDevopsSpecialist'
    ? {...agent, permissions: [{action: 'bash', resource: '*', effect: 'deny'}]}
    : agent);
  assert.throws(() => assertPipelineCapabilities({...valid, agents: denied}), /runtime-diagnostic-http/);

  const httpOnlyPermissions = [
    {action: 'bash', resource: '*', effect: 'deny'},
    {action: 'bash', resource: 'npx tsx $HOME/.config/opencode/skills/task-management/scripts/runtime-diagnostic-cli.ts http-get *', effect: 'allow'},
  ];
  const httpOnly = valid.agents.map(agent => agent.id === 'OpenDevopsSpecialist'
    ? {...agent, permissions: httpOnlyPermissions}
    : agent);
  assert.throws(() => assertPipelineCapabilities({...valid, agents: httpOnly}), /runtime-diagnostic-postgres/);
});

test('a live tool-level denial overrides worker delegation grants', () => {
  assert.throws(() => assertPipelineCapabilities({ ...valid, permissions: [...valid.permissions, {action: "subagent", resource: "*", effect: "deny"}] }), /permission:subagent:CoderAgent:deny/);
});

const researchInput = (id = 'ArchitectureAnalyzer') => ({
  ...valid,
  tools: [...valid.tools, {id: 'webfetch'}, {id: 'gh_grep_searchGitHub'}, {id: 'context7_query-docs'}],
  agents: [...valid.agents.filter(a => a.id !== id), {id, mode: 'subagent', permissions: [
    ...(id === 'CoderAgent' ? coderPermissions : []),
    ...(id === 'TestEngineer' ? testEngineerPermissions : []),
    ...(id === 'OpenDevopsSpecialist' ? devopsPermissions : []),
    {action: '*', resource: '*', effect: 'deny'},
    ...['webfetch', 'gh_grep_*', 'context7_*'].map(action => ({action, resource: '*', effect: 'allow'})),
    ...(id === 'CoderAgent' ? coderPermissions : []),
    ...(id === 'TestEngineer' ? testEngineerPermissions : []),
    ...(id === 'OpenDevopsSpecialist' ? devopsPermissions : []),
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
