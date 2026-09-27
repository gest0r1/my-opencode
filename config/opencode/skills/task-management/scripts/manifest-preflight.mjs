import { readFileSync, accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gatePolicyError, isFrozenUvPytest, tokenizeGateCommand as tokenizeGateCommandPolicy } from './gate-command-policy.mjs';
import { validateManifestV2Policy, validatePackageManagerContract } from './manifest-v2-policy.mjs';

export class ManifestPreflightError extends Error {}

// Only stages executed by gate-runner require profiles. Implementation, human review,
// Git scope verification and candidate publication use their own deterministic tools.
const MACHINE_STAGE = /(?:^|[-_])(test|tests|pytest|build|lint|typecheck|type-check|runtime|deploy|release|smoke|install|unit|e2e|scan|gates?|docs?|validate)(?:$|[-_])/i;
const RUNTIME_GATE = /(runtime|deploy|release|smoke|install)/i;
const SAFE_SHA = /^[0-9a-f]{40}$/i;

export function tokenizeGateCommand(command) {
  try {
    return tokenizeGateCommandShared(command);
  } catch (error) {
    throw new ManifestPreflightError(error instanceof Error ? error.message : String(error));
  }
}

function tokenizeGateCommandShared(command) {
  return tokenizeGateCommandPolicy(command);
}

export function assertSafeGateInvocation(tokens, gate) {
  const reason = gatePolicyError(tokens, gate);
  if (reason) throw new ManifestPreflightError(reason);
}


function executableOnPath(exe) {
  if (isAbsolute(exe) || exe.includes('/')) return false;
  return (process.env.PATH ?? '').split(delimiter).some((directory) => {
    try { accessSync(join(directory || '.', exe), constants.X_OK); return true; }
    catch { return false; }
  });
}

function runChecked(exe, args, cwd, label) {
  const result = spawnSync(exe, args, { cwd, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code || String(result.stderr || result.error?.message || result.status).trim().slice(0, 300);
    throw new ManifestPreflightError(`${label}: ${reason}`);
  }
  return String(result.stdout ?? '');
}

function projectPythonContract(cwd) {
  const versionFile = join(cwd, '.python-version');
  try {
    const value = readFileSync(versionFile, 'utf8').trim().split(/\s+/)[0];
    if (value) return { source: '.python-version', value };
  } catch {}
  try {
    const pyproject = readFileSync(join(cwd, 'pyproject.toml'), 'utf8');
    const match = pyproject.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m);
    if (match?.[1]) return { source: 'pyproject.toml requires-python', value: match[1] };
  } catch {}
  return undefined;
}

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function matchesPythonContract(version, contract) {
  const actual = versionTuple(version);
  if (!actual || !contract) return false;
  if (/^\d+\.\d+(?:\.\d+)?$/.test(contract)) return version.startsWith(contract);
  for (const clause of contract.split(',').map((item) => item.trim()).filter(Boolean)) {
    const match = /^(>=|<=|==|!=|>|<|~=)\s*(\d+(?:\.\d+){1,2})/.exec(clause);
    if (!match) continue;
    const expected = versionTuple(match[2]);
    const comparison = compareVersion(actual, expected);
    const ok = match[1] === '>=' ? comparison >= 0 : match[1] === '<=' ? comparison <= 0 :
      match[1] === '>' ? comparison > 0 : match[1] === '<' ? comparison < 0 :
      match[1] === '!=' ? comparison !== 0 : match[1] === '==' ? comparison === 0 :
      (actual[0] === expected[0] && actual[1] >= expected[1]);
    if (!ok) return false;
  }
  return true;
}

function checkUv(tokens, cwd) {
  if (!isFrozenUvPytest(tokens)) return;
  if (!executableOnPath('uv')) throw new ManifestPreflightError('EXECUTABLE_NOT_FOUND: uv is absent from runner PATH');
  try { accessSync(join(cwd, 'pyproject.toml'), constants.R_OK); }
  catch { throw new ManifestPreflightError('UV_PROJECT_NOT_FOUND: pyproject.toml is required for uv gate'); }
  try { accessSync(join(cwd, 'uv.lock'), constants.R_OK); }
  catch { throw new ManifestPreflightError('UV_LOCK_NOT_FOUND: uv.lock is required for uv run --frozen gate'); }

  const output = runChecked('uv', ['run', '--frozen', 'python', '-c', 'import sys, pytest; print(sys.version.split()[0]); print(pytest.__version__)'], cwd, 'UV_LOCKED_ENV_NOT_READY');
  const version = output.trim().split(/\r?\n/)[0] ?? '';
  const contract = projectPythonContract(cwd);
  if (contract && !matchesPythonContract(version, contract.value)) {
    throw new ManifestPreflightError(`PYTHON_CONTRACT_MISMATCH: uv Python ${version} does not satisfy ${contract.source}=${contract.value}`);
  }
}

function checkPython(tokens, cwd) {
  const exe = tokens[0];
  if (!['python', 'python3', 'pytest'].includes(exe)) return;
  const args = exe === 'pytest' ? ['--version'] : ['-m', 'pytest', '--version'];
  runChecked(exe, args, cwd, `PYTHON_ENV_NOT_READY: ${exe} cannot run pytest`);
}


export function validateGateManifest(manifest, { environment = false, cwd = process.cwd(), manifestPath } = {}) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.pipelines)) {
    throw new ManifestPreflightError('manifest.pipelines must be an array');
  }
  const profiles = manifest.gate_profiles ?? {};
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new ManifestPreflightError('gate_profiles must be an object');
  }
  const invocations = [];
  for (const pipeline of manifest.pipelines) {
    const stages = (pipeline.stages ?? []).filter((stage) => typeof stage === 'string');
    const machineStages = manifest.schema_version === 2
      ? stages.filter((stage) => pipeline.executors?.[stage] === 'local_gate')
      : stages.filter((stage) => MACHINE_STAGE.test(stage));
    if (machineStages.length && (!pipeline.profile || typeof pipeline.profile !== 'string')) {
      throw new ManifestPreflightError(`pipeline has no gate profile: ${pipeline.id} (local machine stages: ${machineStages.join(', ')})`);
    }
    if (pipeline.profile !== undefined) {
      const gates = profiles[pipeline.profile];
      if (!gates || typeof gates !== 'object' || Array.isArray(gates) || !Object.keys(gates).length) {
        throw new ManifestPreflightError(`gate profile is missing or empty: ${pipeline.id}/${String(pipeline.profile)}`);
      }
      for (const stage of machineStages) {
        if (!Array.isArray(gates[stage]) || gates[stage].length === 0) {
          throw new ManifestPreflightError(`MACHINE_GATE_MISSING: gate_profiles.${pipeline.profile}.${stage} must contain commands; gate key must match stage ID`);
        }
      }
    }
  }
  for (const [profile, gates] of Object.entries(profiles)) {
    if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
      throw new ManifestPreflightError(`gate_profiles.${profile} must be an object`);
    }
    for (const [gate, commands] of Object.entries(gates)) {
      if (!Array.isArray(commands) || commands.length === 0) {
        throw new ManifestPreflightError(`gate_profiles.${profile}.${gate} must be a nonempty command array`);
      }
      for (const command of commands) {
        const tokens = tokenizeGateCommand(command);
        assertSafeGateInvocation(tokens, gate);
        if (tokens.some((token) => token.includes('{candidate_sha}')) && !RUNTIME_GATE.test(gate)) {
          throw new ManifestPreflightError(`candidate_sha may only occur in runtime gate: ${profile}/${gate}`);
        }
        invocations.push({ profile, gate, tokens });
      }
    }
  }
  const used = new Set(manifest.pipelines.map((pipeline) => pipeline.profile).filter(Boolean));
  const usedInvocations = invocations.filter(({ profile }) => used.has(profile));
  if (manifest.schema_version === 2) {
    try {
      validateManifestV2Policy(manifest, { cwd, manifestPath });
      validatePackageManagerContract(usedInvocations, { cwd, environment, executableOnPath });
    } catch (error) {
      throw new ManifestPreflightError(error instanceof Error ? error.message : String(error));
    }
  }
  if (environment) {
    for (const { profile, gate, tokens } of usedInvocations) {
      if (!executableOnPath(tokens[0])) {
        throw new ManifestPreflightError(`EXECUTABLE_NOT_FOUND: ${tokens[0]} for ${profile}/${gate} is absent from runner PATH`);
      }
      checkUv(tokens, cwd);
      checkPython(tokens, cwd);
    }
  }
  return { status: 'PASS', checked_commands: invocations.length, environment_checked: environment };
}

export async function preflightFile(path, options = {}) {
  const raw = await readFile(path, 'utf8');
  return validateGateManifest(JSON.parse(raw), { ...options, manifestPath: path });
}
