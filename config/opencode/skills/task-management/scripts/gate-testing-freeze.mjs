// PLAN-time binding of a project's own generated test impact map into the frozen manifest.
// The planner has no shell, so this deterministic step copies the map into the run directory,
// checks that its command indexes were generated for exactly the frozen command array, and
// records only {snapshot, sha256} in the manifest.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { commandsDigest, resolveGateTesting, safeTestPath, safeExactIgnoredRule, snapshotPath, validateGateTesting } from './gate-testing-policy.mjs';

const SOURCE_KEYS = ['impact_groups', 'coordinator_only', 'parallel_groups', 'live_postgres'];
const sha256 = value => createHash('sha256').update(value).digest('hex');

function readRepoJson(cwd, path, label) {
  if (!safeTestPath(path)) throw new Error(`GATE_TESTING_FREEZE_PATH_INVALID: ${label} ${path}`);
  const absolute = resolve(cwd, path);
  if (!absolute.startsWith(`${resolve(cwd)}${sep}`) || !existsSync(absolute)) throw new Error(`GATE_TESTING_FREEZE_MISSING: ${label} ${path}`);
  const raw = readFileSync(absolute, 'utf8');
  try { return { raw, json: JSON.parse(raw) }; } catch { throw new Error(`GATE_TESTING_FREEZE_INVALID_JSON: ${label} ${path}`); }
}

function sourceConfig(json, profile, gate) {
  if (json && Array.isArray(json.impact_groups)) return json;
  const nested = json?.gate_testing?.[profile]?.[gate];
  if (nested && Array.isArray(nested.impact_groups)) return nested;
  throw new Error('GATE_TESTING_FREEZE_SOURCE_SHAPE: expected impact_groups at the top level or under gate_testing.<profile>.<gate>');
}

function commandArrays(json, gate) {
  if (Array.isArray(json)) return [json];
  return Object.values(json?.gate_profiles ?? {}).map(profile => profile?.[gate]).filter(Array.isArray);
}

function ignoredRules(json) {
  const rules = Array.isArray(json) ? json : json?.ignored_inputs ?? json?.ignored_input_rules;
  if (!Array.isArray(rules)) throw new Error('GATE_TESTING_FREEZE_IGNORED_SHAPE: expected an array, ignored_inputs or ignored_input_rules');
  return rules;
}

// An exact rule can narrow tests only if the file exists and is Git-tracked
// at PLAN freeze. Legacy globs stay syntactically accepted but select full checks.
function verifyExactIgnoredInputs(cwd, rules) {
  for (const entry of rules) {
    const pattern = typeof entry === 'string' ? entry : entry?.pattern;
    if (typeof pattern !== 'string' || !safeTestPath(pattern) ||
        pattern.split('/').some(part => part === '.' || part === '..' || part === ''))
      throw Error('GATE_TESTING_FREEZE_IGNORED_PATH_INVALID');
    if (!safeExactIgnoredRule(entry)) continue;
    const absolute = resolve(cwd, pattern);
    let info;
    try { info = lstatSync(absolute); }
    catch { throw Error('GATE_TESTING_FREEZE_IGNORED_MISSING: ' + pattern); }
    if (!info.isFile() || info.isSymbolicLink())
      throw Error('GATE_TESTING_FREEZE_IGNORED_NOT_REGULAR: ' + pattern);
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', pattern], { cwd, encoding: 'utf8', timeout: 10000 });
    if (tracked.status !== 0 || tracked.error)
      throw Error('GATE_TESTING_FREEZE_IGNORED_NOT_TRACKED: ' + pattern);
  }
}

export function freezeGateTesting({ manifestPath, profile, gate, source, commands, ignored, cwd = process.cwd() }) {
  const manifestFile = resolve(manifestPath);
  const runDirectory = dirname(manifestFile);
  const statePath = join(runDirectory, 'state.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!['planned', 'approved'].includes(state.status)) throw new Error(`GATE_TESTING_FREEZE_RUN_STARTED: status=${state.status}`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const frozen = manifest.gate_profiles?.[profile]?.[gate];
  if (!Array.isArray(frozen) || !frozen.length) throw new Error(`GATE_TESTING_FREEZE_NO_COMMANDS: ${profile}/${gate}`);
  if (!commands) throw new Error('GATE_TESTING_FREEZE_COMMANDS_REQUIRED: pass the project file whose command array the map indexes refer to');

  const map = readRepoJson(cwd, source, 'source');
  const config = sourceConfig(map.json, profile, gate);
  const reference = readRepoJson(cwd, commands, 'commands');
  if (!commandArrays(reference.json, gate).some(array => JSON.stringify(array) === JSON.stringify(frozen))) {
    throw new Error(`GATE_TESTING_FREEZE_COMMANDS_MISMATCH: ${commands} does not hold the exact frozen ${profile}/${gate} array; copy that array into gate_profiles first`);
  }

  const snapshot = {};
  for (const key of SOURCE_KEYS) if (config[key] !== undefined) snapshot[key] = config[key];
  if (ignored) {
    const rules = ignoredRules(readRepoJson(cwd, ignored, 'ignored').json);
    verifyExactIgnoredInputs(cwd, rules);
    snapshot.ignored_inputs = rules;
  }
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const relative = snapshotPath(profile, gate);
  const target = join(runDirectory, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');

  const existing = manifest.gate_testing?.[profile]?.[gate] ?? {};
  const entry = {
    ...(existing.timeout_seconds !== undefined ? { timeout_seconds: existing.timeout_seconds } : {}),
    ...(existing.report_files !== undefined ? { report_files: existing.report_files } : {}),
    source: {
      snapshot: relative.split(sep).join('/'), sha256: sha256(content),
      repo_path: source, repo_sha256: sha256(map.raw),
      commands_path: commands, commands_sha256: commandsDigest(frozen),
      ...(ignored ? { ignored_path: ignored } : {}),
    },
  };
  const next = { ...manifest, gate_testing: { ...(manifest.gate_testing ?? {}), [profile]: { ...(manifest.gate_testing?.[profile] ?? {}), [gate]: entry } } };
  validateGateTesting(resolveGateTesting(next, runDirectory));
  writeFileSync(manifestFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return {
    status: 'PASS', profile, gate, snapshot: entry.source.snapshot, sha256: entry.source.sha256,
    impact_groups: snapshot.impact_groups.length, coordinator_only: snapshot.coordinator_only ?? [],
    parallel_groups: snapshot.parallel_groups ?? [], ignored_inputs: snapshot.ignored_inputs?.length ?? 0,
  };
}
