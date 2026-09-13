#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function die(message, code = 2) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

function parseArgs(argv) {
  const out = { sha: null, required: [], waitSeconds: 0, pollSeconds: 10, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sha') out.sha = argv[++i];
    else if (arg === '--required') out.required.push(...String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
    else if (arg === '--wait-seconds') out.waitSeconds = Number(argv[++i]);
    else if (arg === '--poll-seconds') out.pollSeconds = Number(argv[++i]);
    else if (arg === '--repo') out.repo = argv[++i];
    else die(`unknown argument: ${arg}`);
  }
  if (!out.sha || !/^[0-9a-f]{40}$/i.test(out.sha)) die('--sha must be a 40-hex commit SHA');
  out.required = [...new Set(out.required)];
  if (out.required.length === 0) die('at least one --required check name is mandatory');
  if (!Number.isFinite(out.waitSeconds) || out.waitSeconds < 0) die('--wait-seconds must be >= 0');
  if (!Number.isFinite(out.pollSeconds) || out.pollSeconds < 2) die('--poll-seconds must be >= 2');
  return out;
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = error?.stderr?.toString?.().trim() || error?.message || String(error);
    die(`gh ${args.join(' ')} failed: ${detail}`);
  }
}

function resolveRepo(explicit) {
  if (explicit) return explicit;
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!/^[^/]+\/[^/]+$/.test(repo)) die('cannot resolve GitHub owner/repository');
  return repo;
}

function latestByName(items, nameKey, dateKeys) {
  const map = new Map();
  for (const item of items) {
    const name = item?.[nameKey];
    if (!name) continue;
    const stamp = Math.max(...dateKeys.map((key) => Date.parse(item?.[key] ?? 0) || 0));
    const prev = map.get(name);
    if (!prev || stamp >= prev.stamp) map.set(name, { item, stamp });
  }
  return map;
}

function fetchState(repo, sha, required) {
  const checksJson = JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]));
  const statusJson = JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/commits/${sha}/status`]));
  const checkMap = latestByName(checksJson.check_runs ?? [], 'name', ['completed_at', 'started_at']);
  const statusMap = latestByName(statusJson.statuses ?? [], 'context', ['updated_at', 'created_at']);

  const passConclusions = new Set(['success', 'neutral', 'skipped']);
  const failureConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
  const details = [];

  for (const name of required) {
    const check = checkMap.get(name)?.item;
    const status = statusMap.get(name)?.item;
    if (check) {
      let state = 'pending';
      if (check.status === 'completed' && passConclusions.has(check.conclusion)) state = 'pass';
      else if (check.status === 'completed' && failureConclusions.has(check.conclusion)) state = 'fail';
      details.push({ name, source: 'check_run', state, status: check.status, conclusion: check.conclusion ?? null, url: check.html_url ?? null });
    } else if (status) {
      const state = status.state === 'success' ? 'pass' : ['failure', 'error'].includes(status.state) ? 'fail' : 'pending';
      details.push({ name, source: 'commit_status', state, status: status.state, conclusion: status.state, url: status.target_url ?? null });
    } else {
      details.push({ name, source: null, state: 'missing', status: null, conclusion: null, url: null });
    }
  }

  const failed = details.filter((x) => x.state === 'fail');
  const pending = details.filter((x) => x.state === 'pending' || x.state === 'missing');
  return { details, failed, pending, passed: details.filter((x) => x.state === 'pass') };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const args = parseArgs(process.argv.slice(2));
const repo = resolveRepo(args.repo);
const deadline = Date.now() + args.waitSeconds * 1000;
let state;
while (true) {
  state = fetchState(repo, args.sha, args.required);
  if (state.failed.length > 0 || state.pending.length === 0 || Date.now() >= deadline) break;
  sleep(args.pollSeconds * 1000);
}

const result = {
  ok: state.failed.length === 0 && state.pending.length === 0,
  repository: repo,
  sha: args.sha,
  required_checks: args.required,
  checks: state.details,
  pass_count: state.passed.length,
  fail_count: state.failed.length,
  pending_or_missing_count: state.pending.length,
};
console.log(JSON.stringify(result, null, 2));
if (state.failed.length > 0) process.exitCode = 1;
else if (state.pending.length > 0) process.exitCode = 2;
else process.exitCode = 0;
