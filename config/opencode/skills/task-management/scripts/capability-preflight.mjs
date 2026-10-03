const WORKERS = ['ContextScout', 'ExternalScout', 'StoryMapper', 'SeniorStoryReviewer', 'ArchitectureAnalyzer', 'ContractManager', 'PrioritizationEngine', 'SeniorTechnicalPlanReviewer', 'TaskManager', 'CoderAgent', 'BuildAgent', 'CodeReviewer', 'TestEngineer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist'];

export function assertPipelineCapabilities({ tools, agents, skills, visibleTools, permissions }) {
  const names = new Set(tools.map(x => x.id ?? x.name));
  const missing = [];
  for (const tool of ['read', 'shell', 'subagent', 'pipeline_runtime_prepare']) {
    if (!names.has(tool) || (visibleTools && !visibleTools.includes(tool))) missing.push(`tool:${tool}`);
  }
  const catalog = new Map(agents.map(x => [x.id ?? x.name, x]));
  const match = (value, pattern) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(value);
  for (const id of WORKERS) {
    if (!catalog.has(id) || catalog.get(id).mode === 'primary') missing.push(`subagent:${id}`);
    if (permissions) {
      let effect = 'ask';
      for (const rule of permissions) if (match('subagent', rule.action) && match(id, rule.resource)) effect = rule.effect;
      if (effect !== 'allow') missing.push(`permission:subagent:${id}:${effect}`);
    }
  }
  if (!skills.some(x => x.name === 'task-management')) missing.push('skill:task-management');
  if (missing.length) throw new Error(`PIPELINE_CAPABILITY_UNAVAILABLE: ${missing.join(', ')}; restore the configured capabilities; write-permission fallback is forbidden`);
  return { status: 'PASS', tools_checked: 4, subagents_checked: WORKERS.length, skills_checked: 1 };
}
