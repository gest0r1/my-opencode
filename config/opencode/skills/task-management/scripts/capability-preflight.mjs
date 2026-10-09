const WORKERS = ['ContextScout', 'ExternalScout', 'StoryMapper', 'SeniorStoryReviewer', 'ArchitectureAnalyzer', 'ContractManager', 'PrioritizationEngine', 'SeniorTechnicalPlanReviewer', 'TaskManager', 'CoderAgent', 'BuildAgent', 'CodeReviewer', 'TestEngineer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist'];

const RESEARCH_ROLES = new Set(['ExternalScout', 'WebResearcher', 'ArchitectureAnalyzer', 'CoderAgent', 'CodeReviewer', 'SeniorTechnicalPlanReviewer']);
const ADVISORY_RUNNER_INVOCATIONS = [
  'npx tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts RUN PIPELINE GATE --advisory --affected',
  'npx --yes tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts RUN PIPELINE GATE --advisory --affected',
];
const TEST_DIAGNOSTIC_INVOCATIONS = [
  'npx vitest run example.test.ts',
  'npx jest example.test.ts',
  'pytest example_test.py',
  'python -m pytest example_test.py',
  'npm test -- example',
  'pnpm test -- example',
  'yarn test example',
  'bun test example',
  'go test ./...',
  'cargo test example',
];
const RUNTIME_DIAGNOSTIC_REQUIREMENTS = [
  {
    name: 'http',
    invocations: [
      'npx tsx $HOME/.config/opencode/skills/task-management/scripts/runtime-diagnostic-cli.ts http-get https://example.invalid/health',
      'npx --yes tsx $HOME/.config/opencode/skills/task-management/scripts/runtime-diagnostic-cli.ts http-get https://example.invalid/health',
    ],
  },
  {
    name: 'postgres',
    invocations: [
      'npx tsx $HOME/.config/opencode/skills/task-management/scripts/runtime-diagnostic-cli.ts postgres-compose --project demo --compose-file compose.yml --service db --query SELECT 1',
      'npx --yes tsx $HOME/.config/opencode/skills/task-management/scripts/runtime-diagnostic-cli.ts postgres-compose --project demo --compose-file compose.yml --service db --query SELECT 1',
    ],
  },
];

export function assertPipelineCapabilities({ tools, agents, skills, visibleTools, permissions, models, researchAgents = [] }) {
  const names = new Set(tools.map(x => x.id ?? x.name));
  const missing = [];
  for (const tool of ['read', 'shell', 'subagent', 'pipeline_runtime_prepare']) {
    if (!names.has(tool) || (visibleTools && !visibleTools.includes(tool))) missing.push(`tool:${tool}`);
  }
  const catalog = new Map(agents.map(x => [x.id ?? x.name, x]));
  const match = (value, pattern) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(value);
  if (!Array.isArray(researchAgents) || researchAgents.some(id => !RESEARCH_ROLES.has(id))) {
    throw new Error('PIPELINE_CAPABILITY_UNAVAILABLE: invalid research_agents');
  }
  const selected = [...new Set(researchAgents)];
  const requiredWorkers = [...new Set([...WORKERS, ...selected])];
  const effectFor = (rules, action, resource = '*') => {
    let effect = 'ask';
    for (const rule of rules ?? []) if (match(action, rule.action) && match(resource, rule.resource)) effect = rule.effect;
    return effect;
  };
  const invocationAllowed = (agent, resources) => ['bash', 'shell'].some(action =>
    resources.some(resource => effectFor(agent?.permissions, action, resource) === 'allow'));
  for (const id of requiredWorkers) {
    if (!catalog.has(id) || catalog.get(id).mode === 'primary') missing.push(`subagent:${id}`);
    if (permissions) {
      let effect = 'ask';
      for (const rule of permissions) if (match('subagent', rule.action) && match(id, rule.resource)) effect = rule.effect;
      if (effect !== 'allow') missing.push(`permission:subagent:${id}:${effect}`);
    }
  }
  for (const id of ['CoderAgent', 'TestEngineer']) {
    const agent = catalog.get(id);
    if (!agent) continue;
    if (!invocationAllowed(agent, ADVISORY_RUNNER_INVOCATIONS)) missing.push(`capability:${id}:advisory-gate-runner`);
  }
  const testEngineer = catalog.get('TestEngineer');
  if (testEngineer && !invocationAllowed(testEngineer, TEST_DIAGNOSTIC_INVOCATIONS)) {
    missing.push('capability:TestEngineer:targeted-test-runner');
  }
  const devops = catalog.get('OpenDevopsSpecialist');
  if (devops) {
    for (const requirement of RUNTIME_DIAGNOSTIC_REQUIREMENTS) {
      if (!invocationAllowed(devops, requirement.invocations)) {
        missing.push(`capability:OpenDevopsSpecialist:runtime-diagnostic-${requirement.name}`);
      }
    }
  }
  const research = selected.map(id => {
    const agent = catalog.get(id);
    const available = [...names].filter(name => name === 'webfetch' || ['context7_', 'gh_grep_', 'exa_'].some(prefix => name.startsWith(prefix)))
      .filter(name => effectFor(agent?.permissions, name) === 'allow');
    if (!available.includes('webfetch')) missing.push(`research:${id}:webfetch`);
    if (!available.some(name => name !== 'webfetch')) missing.push(`research:${id}:search-or-docs`);
    return { agent: id, available_tools: available };
  });
  if (models !== undefined) {
    if (!Array.isArray(models) || models.length === 0) throw new Error('PIPELINE_MODEL_CATALOG_UNAVAILABLE: empty/invalid live model catalog');
    const available = new Set(models.filter(model => model.enabled !== false).map(model => `${model.providerID}/${model.id ?? model.modelID}`));
    const unavailable = [];
    for (const id of requiredWorkers) {
      const model = catalog.get(id)?.model;
      if (!model) continue;
      const full = typeof model === 'string' ? model : `${model.providerID}/${model.id ?? model.modelID}`;
      if (!available.has(full)) unavailable.push(`${id}=${full}`);
    }
    if (unavailable.length) throw new Error(`PIPELINE_MODEL_UNAVAILABLE: ${unavailable.join(', ')}; use exact provider/model from this runtime; provider fallback is forbidden`);
  }
  if (!skills.some(x => x.name === 'task-management')) missing.push('skill:task-management');
  if (missing.length) throw new Error(`PIPELINE_CAPABILITY_UNAVAILABLE: ${missing.join(', ')}; restore the configured capabilities; write-permission fallback is forbidden`);
  return { status: 'PASS', tools_checked: 4, subagents_checked: requiredWorkers.length, skills_checked: 1, research_checked: research };
}
