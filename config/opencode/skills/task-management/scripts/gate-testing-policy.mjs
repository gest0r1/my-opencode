// Frozen test impact and disposable-resource contract, shared by PLAN and RUN.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gatePolicyError, tokenizeGateCommand } from './gate-command-policy.mjs';

// Keys a project-generated impact map may supply; the manifest keeps only its frozen reference.
const SOURCE_KEYS = ['impact_groups', 'coordinator_only', 'parallel_groups', 'live_postgres', 'ignored_inputs'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const commandsDigest = commands => sha256(JSON.stringify(commands));

// `gate_testing[profile][gate].source` points at a snapshot of the project's own generated impact
// map, copied into the run directory by `stage-cli gate-testing-freeze`. Every reader resolves it
// here, so the runner, dispatch, completion and preflight all see the same frozen groups.
export function resolveGateTesting(manifest, runDirectory) {
  const testing = manifest?.gate_testing;
  if (!testing || typeof testing !== 'object' || Array.isArray(testing)) return manifest;
  let changed = false;
  const resolved = {};
  for (const [profile, gates] of Object.entries(testing)) {
    if (!gates || typeof gates !== 'object' || Array.isArray(gates)) { resolved[profile] = gates; continue; }
    resolved[profile] = {};
    for (const [gate, config] of Object.entries(gates)) {
      if (!config?.source) { resolved[profile][gate] = config; continue; }
      const source = config.source;
      if (typeof source !== 'object' || typeof source.snapshot !== 'string' || !/^[0-9a-f]{64}$/i.test(source.sha256 ?? '') ||
          !/^[0-9a-f]{64}$/i.test(source.commands_sha256 ?? '') || !safeTestPath(source.snapshot)) {
        throw new Error(`GATE_TESTING_SOURCE_INVALID: ${profile}/${gate}`);
      }
      if (!runDirectory) throw new Error(`GATE_TESTING_SOURCE_UNRESOLVED: ${profile}/${gate} needs the run directory`);
      const root = resolve(runDirectory);
      const path = resolve(root, source.snapshot);
      if (!path.startsWith(`${root}${sep}`) || !existsSync(path)) throw new Error(`GATE_TESTING_SOURCE_MISSING: ${source.snapshot}`);
      const raw = readFileSync(path, 'utf8');
      if (sha256(raw) !== source.sha256.toLowerCase()) throw new Error(`GATE_TESTING_SOURCE_CHANGED: ${source.snapshot}`);
      const commands = manifest.gate_profiles?.[profile]?.[gate];
      if (!Array.isArray(commands) || commandsDigest(commands) !== source.commands_sha256.toLowerCase()) {
        throw new Error(`GATE_TESTING_SOURCE_COMMANDS_CHANGED: ${profile}/${gate} indexes were frozen against another command array`);
      }
      let snapshot;
      try { snapshot = JSON.parse(raw); } catch { throw new Error(`GATE_TESTING_SOURCE_INVALID: ${source.snapshot}`); }
      const inline = Object.keys(config).filter(key => key !== 'source');
      if (inline.some(key => SOURCE_KEYS.includes(key) && key !== 'ignored_inputs')) throw new Error(`GATE_TESTING_SOURCE_CONFLICT: ${profile}/${gate} keeps impact data only in the snapshot`);
      const merged = { ...config };
      delete merged.source;
      for (const key of SOURCE_KEYS) if (snapshot[key] !== undefined && merged[key] === undefined) merged[key] = snapshot[key];
      resolved[profile][gate] = merged;
      changed = true;
    }
  }
  return changed ? { ...manifest, gate_testing: resolved } : manifest;
}

// Same as resolveGateTesting for a manifest file path (its directory is the run directory).
export function resolveGateTestingFile(manifest, manifestFile) {
  return resolveGateTesting(manifest, dirname(resolve(manifestFile)));
}

export function snapshotPath(profile, gate) {
  return join('planning', 'gate-testing', `${profile}.${gate}.json`);
}

export function safeTestPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !value.startsWith('-') && !value.includes('\\') && !/[\0\r\n]/.test(value) &&
    !value.split('/').some(part => part === '..' || part === '.git');
}

export function impactMatches(pattern, file) {
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) || file === pattern.slice(0, -3) : pattern === file;
}

// A local gate is pre-publish when every pipeline that freezes it on this profile runs it before
// git_publish (or has no git_publish stage). Pre-publish gates may hold test resources and run in
// the PLAN probe whatever their name; deployment and smoke gates never do.
export function isPrePublishGate(manifest, profile, gate) {
  if (/(deploy|smoke)/i.test(gate)) return false;
  const users = (manifest.pipelines ?? []).filter(pipeline => pipeline?.profile === profile && (pipeline.stages ?? []).includes(gate));
  if (!users.length) return false;
  return users.every(pipeline => {
    const publish = pipeline.stages.findIndex(stage => pipeline.executors?.[stage] === 'git_publish');
    return (pipeline.executors?.[gate] ?? 'local_gate') === 'local_gate' && (publish < 0 || pipeline.stages.indexOf(gate) < publish);
  });
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
      if (/(runtime|deploy|release|smoke|install)/i.test(gate) && !isPrePublishGate(manifest, profile, gate)) throw new Error('GATE_TESTING_INVALID: test resources cannot wrap deployment gates');
      if (Object.keys(config).some(key => !['impact_groups', 'live_postgres', 'timeout_seconds', 'report_files', 'coordinator_only', 'parallel_groups', 'ignored_inputs', 'source'].includes(key))) throw new Error('GATE_TESTING_INVALID: unknown option');
      // An unresolved source reference is validated after resolveGateTesting merges its snapshot.
      if (config.source !== undefined) continue;
      if (config.ignored_inputs !== undefined && (!Array.isArray(config.ignored_inputs) || config.ignored_inputs.some(rule => {
        const pattern = typeof rule === 'string' ? rule : rule?.pattern;
        const except = typeof rule === 'string' ? [] : rule?.except ?? [];
        return typeof pattern !== 'string' || !pattern || pattern.startsWith('/') || pattern.includes('..') || !Array.isArray(except) || except.some(item => typeof item !== 'string' || !item);
      }))) throw new Error('GATE_TESTING_INVALID: ignored_inputs holds glob patterns with optional except lists');
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
      // A worker's bound check must be able to run something: an all-coordinator profile would
      // turn every worker check into an empty PASS.
      if (new Set(config.coordinator_only ?? []).size >= commands.length) throw new Error('GATE_TESTING_INVALID: coordinator_only leaves no command for the worker check');
      if (config.parallel_groups !== undefined) {
        const seen = new Set();
        const live = new Set(config.live_postgres?.command_indexes ?? []);
        if (!Array.isArray(config.parallel_groups) || !config.parallel_groups.length) throw new Error('GATE_TESTING_INVALID: parallel_groups must be nonempty');
        for (const group of config.parallel_groups) {
          // Consecutive indexes only: a group runs as one step of the frozen order, never ahead of it.
          if (!Array.isArray(group) || group.length < 2 || group.length > MAX_PARALLEL ||
              group.some((index, position) => !indexValid(index) || seen.has(index) || live.has(index) || (position > 0 && index !== group[position - 1] + 1))) {
            throw new Error(`GATE_TESTING_INVALID: parallel_groups hold 2..${MAX_PARALLEL} consecutive non-live frozen command indexes, each in one group`);
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

// Invocations in frozen order, grouped into batches: neighbouring selected members of one frozen
// parallel group run together; everything else (including live-PG commands) runs alone. Two
// commands that name the same report file never share a batch, so neither overwrites the other.
export function parallelBatches(invocations, config, liveIndexes = []) {
  const groups = Array.isArray(config?.parallel_groups) ? config.parallel_groups : [];
  const reports = Array.isArray(config?.report_files) ? config.report_files : [];
  const groupOf = new Map();
  groups.forEach((group, id) => group.forEach(index => { if (!liveIndexes.includes(index)) groupOf.set(index, id); }));
  const reportsOf = invocation => reports.filter(file => (invocation.args ?? []).some(arg => String(arg).includes(file)));
  const batches = [];
  for (const invocation of invocations) {
    const id = groupOf.get(invocation.index);
    const last = batches.at(-1);
    const lastId = last ? groupOf.get(last[0].index) : undefined;
    const shared = last ? last.some(other => reportsOf(other).some(file => reportsOf(invocation).includes(file))) : false;
    if (id !== undefined && id === lastId && !shared) last.push(invocation);
    else batches.push([invocation]);
  }
  return batches;
}

// Dependency manifests/lockfiles and auth/security paths can affect any suite: always full.
const ALWAYS_FULL_CHANGE = /(^|\/)(package\.json|(?:pnpm|bun|yarn|package)[.-]lock[^/]*)$|(^|\/)auth(\/|[.-])/i;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function globRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function ignoredInput(rules, file) {
  return (Array.isArray(rules) ? rules : []).some(rule => {
    const pattern = typeof rule === 'string' ? rule : rule.pattern;
    const except = typeof rule === 'string' ? [] : rule.except ?? [];
    return globRegex(pattern).test(file) && !except.some(item => globRegex(item).test(file));
  });
}

// The command that runs a test file nobody mapped: the owner of a test in its own directory, else
// the single command whose tests live under the nearest parent directory (a new test folder).
// Two commands under that parent are ambiguous and leave the file unmapped.
function testOwnerIndex(groups, file) {
  const directory = file.slice(0, file.lastIndexOf('/') + 1);
  const sibling = groups.find(group => (group.test_files ?? []).some(test => test.startsWith(directory) && !test.slice(directory.length).includes('/')));
  if (sibling) return sibling.command_index;
  for (let end = directory.lastIndexOf('/', directory.length - 2); end > 0; end = directory.lastIndexOf('/', end - 1)) {
    const parent = directory.slice(0, end + 1);
    const owners = new Set(groups.filter(group => (group.test_files ?? []).some(test => test.startsWith(parent))).map(group => group.command_index));
    if (owners.size === 1) return [...owners][0];
    if (owners.size > 1) return undefined;
  }
  return undefined;
}

// `options.isNew(path)` says the path did not exist when the work item was dispatched. A generated
// project map cannot know files written after it was frozen, so a new test file runs alone with
// the command that owns its directory, and a new source file is reached through the changed
// mapped files that import it. Anything else unmapped still selects the complete array.
export function selectAffectedCommands(commands, config, changed, previousFailures = [], options = {}) {
  // coordinator_only commands (type-check, lint, build, complete suites) run once per wave on the
  // combined tree and in the final gate; a worker's affected check never runs them.
  const coordinatorOnly = new Set(Array.isArray(config?.coordinator_only) ? config.coordinator_only : []);
  const worker = item => !coordinatorOnly.has(item.index);
  const split = (reason, all) => ({ reason, selected: all.filter(worker), deferred: all.filter(item => !worker(item)).map(item => item.index) });
  const full = reason => split(reason, commands.map((command, index) => ({ command, index, test_files: [] })));
  if (!config?.impact_groups || !changed?.length) return full('missing impact map or change baseline');
  const relevant = changed.filter(file => !ignoredInput(config.ignored_inputs, file));
  if (!relevant.length) return split('only ignored inputs changed', []);
  if (relevant.some(file => ALWAYS_FULL_CHANGE.test(file))) return full('dependency or security change');
  const mapped = file => config.impact_groups.some(group => group.inputs.some(input => impactMatches(input, file)));
  const isNew = typeof options.isNew === 'function' ? options.isNew : () => false;
  const selected = new Map();
  const add = (index, files) => {
    const prior = selected.get(index);
    selected.set(index, {
      command: commands[index], index,
      test_files: prior ? (prior.test_files.length && files.length ? [...new Set([...prior.test_files, ...files])] : []) : files,
    });
  };
  const anyMapped = relevant.some(mapped);
  // A new test file is listed in no group's test_files even when a directory glob maps it.
  for (const file of relevant.filter(file => (!mapped(file) || (isNew(file) && TEST_FILE.test(file))))) {
    if (TEST_FILE.test(file)) {
      const index = testOwnerIndex(config.impact_groups, file);
      if (index === undefined) return full(`unmapped change: ${file}`);
      add(index, [file]);
    } else if (!(isNew(file) && anyMapped)) {
      return full(`unmapped change: ${file}`);
    }
  }
  // Schema/migration/configuration/shared-contract changes use the frozen, reviewed transitive
  // impact groups like any other path.
  for (const group of config.impact_groups) {
    if (!group.inputs.some(input => relevant.some(file => impactMatches(input, file)))) continue;
    add(group.command_index, group.test_files ?? []);
  }
  // A failing command is always rechecked in full, even if its inputs did not change.
  for (const index of previousFailures) {
    if (Number.isInteger(index) && commands[index]) selected.set(index, { command: commands[index], index, test_files: [] });
  }
  return split('frozen transitive impact groups plus previous failures', [...selected.values()].sort((a, b) => a.index - b.index));
}
