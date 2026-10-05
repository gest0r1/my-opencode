const WORKERS = ['ContextScout', 'ExternalScout', 'StoryMapper', 'SeniorStoryReviewer', 'ArchitectureAnalyzer', 'ContractManager', 'PrioritizationEngine', 'SeniorTechnicalPlanReviewer', 'TaskManager', 'CoderAgent', 'BuildAgent', 'CodeReviewer', 'TestEngineer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist'];

export function assertPipelineCapabilities({ tools, agents, skills, visibleTools, permissions, models }) {
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
  if (models !== undefined) {
    if (!Array.isArray(models) || models.length === 0) throw new Error('PIPELINE_MODEL_CATALOG_UNAVAILABLE: empty/invalid live model catalog');
    const available = new Set(models.filter(model => model.enabled !== false).map(model => `${model.providerID}/${model.id ?? model.modelID}`));
    const unavailable = [];
    for (const id of WORKERS) {
      const model = catalog.get(id)?.model;
      if (!model) continue; // Inherited models are resolved by the runtime.
      const full = typeof model === 'string' ? model : `${model.providerID}/${model.id ?? model.modelID}`;
      if (!available.has(full)) unavailable.push(`${id}=${full}`);
    }
    if (unavailable.length) throw new Error(`PIPELINE_MODEL_UNAVAILABLE: ${unavailable.join(', ')}; use exact provider/model from this runtime; provider fallback is forbidden`);
  }
  if (!skills.some(x => x.name === 'task-management')) missing.push('skill:task-management');
  if (missing.length) throw new Error(`PIPELINE_CAPABILITY_UNAVAILABLE: ${missing.join(', ')}; restore the configured capabilities; write-permission fallback is forbidden`);
  return { status: 'PASS', tools_checked: 4, subagents_checked: WORKERS.length, skills_checked: 1 };
}
