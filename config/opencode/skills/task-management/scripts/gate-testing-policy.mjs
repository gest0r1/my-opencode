// Frozen test impact and disposable-resource contract, shared by PLAN and RUN.
import { gatePolicyError, tokenizeGateCommand } from './gate-command-policy.mjs';

export function safeTestPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !value.startsWith('-') && !value.includes('\\') && !/[\0\r\n]/.test(value) &&
    !value.split('/').some(part => part === '..' || part === '.git');
}

export function impactMatches(pattern, file) {
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) || file === pattern.slice(0, -3) : pattern === file;
}

export function validateGateTesting(manifest) {
  const testing = manifest.gate_testing;
  if (testing === undefined) return;
  if (!testing || typeof testing !== 'object' || Array.isArray(testing)) throw new Error('GATE_TESTING_INVALID: expected profile map');
  for (const [profile, gates] of Object.entries(testing)) {
    if (!gates || typeof gates !== 'object' || Array.isArray(gates)) throw new Error('GATE_TESTING_INVALID: expected gate map');
    for (const [gate, config] of Object.entries(gates)) {
      const commands = manifest.gate_profiles?.[profile]?.[gate];
      if (!Array.isArray(commands) || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`GATE_TESTING_INVALID: ${profile}/${gate}`);
      if (/(runtime|deploy|release|smoke|install)/i.test(gate)) throw new Error('GATE_TESTING_INVALID: test resources cannot wrap deployment gates');
      if (Object.keys(config).some(key => !['impact_groups', 'live_postgres', 'timeout_seconds', 'report_files', 'coordinator_only', 'parallel_groups'].includes(key))) throw new Error('GATE_TESTING_INVALID: unknown option');
      if (config.report_files !== undefined && (!Array.isArray(config.report_files) || config.report_files.some(file => !safeTestPath(file) || !file.endsWith('.json') || file.includes('*')))) throw new Error('GATE_TESTING_INVALID: report_files must be relative JSON paths inside the run');
      if (config.timeout_seconds !== undefined && (!Number.isInteger(config.timeout_seconds) || config.timeout_seconds < 10 || config.timeout_seconds > 3600)) throw new Error('GATE_TESTING_INVALID: timeout must be 10..3600 seconds');
      const indexValid = index => Number.isInteger(index) && index >= 0 && index < commands.length;
      if (config.impact_groups !== undefined) {
        if (!Array.isArray(config.impact_groups) || !config.impact_groups.length) throw new Error('GATE_TESTING_INVALID: impact_groups must be nonempty');
        for (const group of config.impact_groups) {
          if (!group || Object.keys(group).some(key => !['inputs', 'command_index', 'test_files'].includes(key)) ||
              !indexValid(group.command_index) || !Array.isArray(group.inputs) || !group.inputs.length ||
              group.inputs.some(input => !safeTestPath(input) || (input.includes('*') && !input.endsWith('/**')))) throw new Error('GATE_TESTING_INVALID: impact group');
          const tokens = tokenizeGateCommand(commands[group.command_index]);
          if (gatePolicyError(tokens, gate)) throw new Error('GATE_TESTING_INVALID: unsafe test command');
          if (group.test_files !== undefined && (!Array.isArray(group.test_files) || !group.test_files.length ||
              group.test_files.some(file => !safeTestPath(file) || file.includes('*')) ||
              !tokens.includes('vitest') || !tokens.includes('run'))) throw new Error('GATE_TESTING_INVALID: test_files requires an explicit vitest run command');
        }
      }
      if (config.coordinator_only !== undefined && (!Array.isArray(config.coordinator_only) || !config.coordinator_only.length ||
          config.coordinator_only.some(index => !indexValid(index)) || new Set(config.coordinator_only).size !== config.coordinator_only.length)) {
        throw new Error('GATE_TESTING_INVALID: coordinator_only must list distinct frozen command indexes');
      }
      if (config.parallel_groups !== undefined) {
        const seen = new Set();
        const live = new Set(config.live_postgres?.command_indexes ?? []);
        if (!Array.isArray(config.parallel_groups) || !config.parallel_groups.length) throw new Error('GATE_TESTING_INVALID: parallel_groups must be nonempty');
        for (const group of config.parallel_groups) {
          if (!Array.isArray(group) || group.length < 2 || group.length > MAX_PARALLEL || new Set(group).size !== group.length ||
              group.some(index => !indexValid(index) || seen.has(index) || live.has(index))) {
            throw new Error(`GATE_TESTING_INVALID: parallel_groups hold 2..${MAX_PARALLEL} distinct non-live frozen command indexes, each in one group`);
          }
          for (const index of group) seen.add(index);
        }
      }
      const pg = config.live_postgres;
      if (pg !== undefined && (!pg || Object.keys(pg).some(key => !['image', 'command_indexes'].includes(key)) ||
          !/^postgres:(?:1[6-9]|[2-9][0-9])(?:\.[0-9]+)?(?:-bookworm)?@sha256:[0-9a-f]{64}$/.test(pg.image ?? '') ||
          !Array.isArray(pg.command_indexes) || !pg.command_indexes.length || pg.command_indexes.some(index => !indexValid(index)))) {
        throw new Error('GATE_TESTING_INVALID: live_postgres requires an official digest-pinned PostgreSQL image and command_indexes');
      }
    }
  }
}

// Commands that share a checkout compete for CPU and memory; three concurrent heavy commands is the
// ceiling that still finishes faster than serial on a 4-core host.
export const MAX_PARALLEL = 3;

// Invocations in frozen order, grouped into batches: members of one frozen parallel group that were
// both selected run together; everything else (including live-PG commands) runs alone.
export function parallelBatches(invocations, config, liveIndexes = []) {
  const groups = Array.isArray(config?.parallel_groups) ? config.parallel_groups : [];
  const groupOf = new Map();
  groups.forEach((group, id) => group.forEach(index => { if (!liveIndexes.includes(index)) groupOf.set(index, id); }));
  const batches = [];
  const open = new Map();
  for (const invocation of invocations) {
    const id = groupOf.get(invocation.index);
    if (id === undefined) { batches.push([invocation]); continue; }
    if (open.has(id)) { open.get(id).push(invocation); continue; }
    const batch = [invocation]; open.set(id, batch); batches.push(batch);
  }
  return batches;
}

// Dependency manifests/lockfiles and auth/security paths can affect any suite: always full.
const ALWAYS_FULL_CHANGE = /(^|\/)(package\.json|(?:pnpm|bun|yarn|package)[.-]lock[^/]*)$|(^|\/)auth(\/|[.-])/i;

export function selectAffectedCommands(commands, config, changed, previousFailures = []) {
  // coordinator_only commands (type-check, lint, build, complete suites) run once per wave on the
  // combined tree and in the final gate; a worker's affected check never runs them.
  const coordinatorOnly = new Set(Array.isArray(config?.coordinator_only) ? config.coordinator_only : []);
  const worker = item => !coordinatorOnly.has(item.index);
  const full = reason => ({ reason, selected: commands.map((command, index) => ({ command, index, test_files: [] })).filter(worker) });
  if (!config?.impact_groups || !changed?.length) return full('missing impact map or change baseline');
  if (changed.some(file => ALWAYS_FULL_CHANGE.test(file))) return full('dependency or security change');
  // Schema/migration/configuration/shared-contract changes use the frozen, reviewed transitive
  // impact groups like any other path; an unmapped one still selects the complete array.
  if (changed.some(file => !config.impact_groups.some(group => group.inputs.some(input => impactMatches(input, file))))) return full('unmapped change');
  const selected = new Map();
  for (const group of config.impact_groups) {
    if (!group.inputs.some(input => changed.some(file => impactMatches(input, file)))) continue;
    const prior = selected.get(group.command_index);
    const files = group.test_files ?? [];
    selected.set(group.command_index, {
      command: commands[group.command_index], index: group.command_index,
      test_files: prior ? (prior.test_files.length && files.length ? [...new Set([...prior.test_files, ...files])] : []) : files,
    });
  }
  // A failing command is always rechecked in full, even if its inputs did not change.
  for (const index of previousFailures) {
    if (Number.isInteger(index) && commands[index]) selected.set(index, { command: commands[index], index, test_files: [] });
  }
  return { reason: 'frozen transitive impact groups plus previous failures', selected: [...selected.values()].filter(worker).sort((a, b) => a.index - b.index) };
}
