import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

const excluded = file => /(^|\/)(\.tmp|\.git|node_modules|dist|build|coverage)(\/|$)|(^|\/)(\.env(?:\..*)?|[^/]+\.(?:key|pem|secret))$/i.test(file);

function scopeMatches(file, scope) {
  if (typeof scope !== 'string' || !scope) return false;
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3).replace(/\/$/, '');
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return file === scope;
}

export async function sourceInventory(cwd, invoke) {
  const files = await invoke('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (files.exit_code !== 0 || files.truncated) return { digest: null, files: null };
  const entries = {};
  const digest = createHash('sha256');
  for (const file of [...new Set(files.stdout.split('\0').filter(Boolean))].filter(file => !excluded(file)).sort()) {
    let identity = 'deleted';
    try {
      const stat = await lstat(join(cwd, file));
      if (!stat.isFile()) identity = `non-regular:${stat.mode}`;
      else identity = createHash('sha256').update(String(stat.mode)).update('\0').update(await readFile(join(cwd, file))).digest('hex');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    entries[file] = identity;
    digest.update(file).update('\0').update(identity).update('\0');
  }
  return { digest: digest.digest('hex'), files: entries };
}

export function changedFromInventory(currentFiles, baselineFiles, scopes = []) {
  if (!currentFiles || !baselineFiles) return null;
  const changed = [];
  for (const file of [...new Set([...Object.keys(currentFiles), ...Object.keys(baselineFiles)])].sort()) {
    if (currentFiles[file] === baselineFiles[file]) continue;
    if (scopes.length && !scopes.some(scope => scopeMatches(file, scope))) continue;
    changed.push(file);
  }
  return changed;
}

export async function sourceSnapshot(cwd, manifest, invoke, baseline) {
  const inventory = await sourceInventory(cwd, invoke);
  if (!inventory.files) return { digest: null, changed: null };

  if (baseline?.files && Array.isArray(baseline?.allowed_change_paths)) {
    return {
      digest: inventory.digest,
      changed: changedFromInventory(inventory.files, baseline.files, baseline.allowed_change_paths),
    };
  }

  let changed = null;
  const base = manifest.git_setup?.base_sha;
  if (/^[0-9a-f]{40}$/i.test(base ?? '')) {
    const diff = await invoke('git', ['diff', '--name-only', '--no-renames', '-z', base, '--']);
    const untracked = await invoke('git', ['ls-files', '--others', '--exclude-standard', '-z']);
    if (diff.exit_code === 0 && untracked.exit_code === 0 && !diff.truncated && !untracked.truncated) changed = [...new Set([...diff.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(file => file && !excluded(file)))];
  }
  return { digest: inventory.digest, changed };
}

export async function readDiagnosticHypothesis(path, runDirectory) {
  if (!path) return null;
  const { realpath } = await import('node:fs/promises');
  const { resolve, sep } = await import('node:path');
  const actual = await realpath(path);
  const root = await realpath(runDirectory);
  if (!actual.startsWith(`${resolve(root)}${sep}checks${sep}`)) throw new Error('DIAGNOSTIC_HYPOTHESIS_INVALID: write the hypothesis under this run checks/');
  const text = await readFile(actual, 'utf8');
  if (!text.trim()) throw new Error('DIAGNOSTIC_HYPOTHESIS_INVALID: empty hypothesis');
  return createHash('sha256').update(text).digest('hex');
}

export function failureSummary(stdout, stderr) {
  return `${stdout}\n${stderr}`.split(/\r?\n/).filter(line => /fail|error|exception|assertion|tests?\s+\d|suites?\s+\d/i.test(line)).slice(0, 30).map(line => line.slice(0, 400));
}

export async function readTestReports(files, runDirectory, startedAt) {
  const { realpath, stat } = await import('node:fs/promises');
  const { sep } = await import('node:path');
  const root = await realpath(runDirectory);
  const reports = [];
  for (const file of files ?? []) {
    try {
      const actual = await realpath(join(root, file));
      if (!actual.startsWith(root + sep)) throw new Error('report escaped run directory');
      const metadata = await stat(actual);
      if (!metadata.isFile() || metadata.mtimeMs < Date.parse(startedAt)) continue;
      const report = JSON.parse(await readFile(actual, 'utf8'));
      const failures = (report.testResults ?? []).flatMap(suite => [
        ...(suite.message ? [{ suite: suite.name, message: String(suite.message).slice(0, 2000) }] : []),
        ...(suite.assertionResults ?? []).filter(test => test.status === 'failed').map(test => ({ suite: suite.name, test: test.fullName ?? test.title, message: (test.failureMessages ?? []).join('\n').slice(0, 2000) })),
      ]);
      reports.push({ file, failed_suites: report.numFailedTestSuites, failed_tests: report.numFailedTests,
        passed_tests: report.numPassedTests, pending_tests: report.numPendingTests, failures: failures.slice(0, 50) });
    } catch (error) {
      if (error.code !== 'ENOENT') reports.push({ file, parse_error: String(error.message).slice(0, 300) });
    }
  }
  return reports;
}
