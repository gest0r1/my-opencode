import { readFileSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

// A frozen work item declares its required file outputs. The PLAN verifies the
// loaded agent's edit policy once; RUN checks only frozen output evidence.
export class WorkItemOutputError extends Error {}

const sha = value => createHash('sha256').update(value).digest('hex');
const safePath = p => typeof p === 'string' && p.length > 0 && !p.startsWith('/') &&
  !p.includes('\\') && !p.includes('\0') && !p.split('/').some(x => x === '..' || x === '.' || x === '.git') &&
  !/[?*\[\]{}]/.test(p) && !p.endsWith('/');
function scopeContains(scope, path) {
  if (typeof scope !== 'string') return false;
  if (scope.endsWith('/**')) {
    const base = scope.slice(0, -3);
    return path === base || path.startsWith(base + '/');
  }
  return scope === path;
}

function globMatches(glob, path) {
  if (glob === '*') return true;
  let source = '^';
  for (let i = 0; i < glob.length;) {
    if (glob.slice(i, i + 3) === '**/') { source += '(?:.*/)?'; i += 3; }
    else if (glob.slice(i, i + 2) === '**') { source += '.*'; i += 2; }
    else if (glob[i] === '*') { source += '[^/]*'; i++; }
    else if (glob[i] === '?') { source += '[^/]'; i++; }
    else { source += glob[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  return new RegExp(source + '$').test(path);
}

export function readRoleEditPolicy(role, { policyDir, cache = new Map() } = {}) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(role)) throw new WorkItemOutputError('AGENT_ROLE_INVALID');
  if (cache.has(role)) return cache.get(role);
  const dir = policyDir ?? process.env.OPENCODE_AGENT_POLICY_DIR ?? join(homedir(), '.config/opencode/agents');
  let raw;
  try { raw = readFileSync(join(dir, role + '.md'), 'utf8'); }
  catch { throw new WorkItemOutputError('AGENT_POLICY_UNAVAILABLE: ' + role); }
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(raw)?.[1];
  if (!frontmatter) throw new WorkItemOutputError('AGENT_POLICY_INVALID: ' + role);
  let permission = false, edit = false;
  const rules = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^permission:\s*$/.test(line)) { permission = true; edit = false; continue; }
    if (/^[^\s]/.test(line)) { permission = false; edit = false; continue; }
    if (!permission) continue;
    const section = /^  ([A-Za-z_]+):\s*(allow|deny)?\s*$/.exec(line);
    if (section) {
      edit = section[1] === 'edit';
      if (edit && section[2]) rules.push({ glob: '*', access: section[2] });
      continue;
    }
    if (edit) {
      const pair = /^    (.+?):\s*(allow|deny)\s*$/.exec(line);
      if (pair) rules.push({ glob: pair[1].replace(/^(['"])(.*)\1$/, '$2'), access: pair[2] });
    }
  }
  if (!rules.length) throw new WorkItemOutputError('AGENT_EDIT_POLICY_UNAVAILABLE: ' + role);
  cache.set(role, rules);
  return rules;
}

export function roleCanEdit(rules, path) {
  const matches = rules.filter(rule => globMatches(rule.glob, path));
  if (!matches.length) return false;
  // Exact/narrow rules override broad globs. At equal specificity, deny wins.
  matches.sort((a, b) => {
    const score = rule => rule.glob.replace(/[?*]/g, '').length;
    return score(b) - score(a) || (a.access === 'deny' ? -1 : 1);
  });
  return matches[0].access === 'allow';
}

export function validateWorkItemOutputContract(record, manifest, { policyDir, cache } = {}) {
  const declared = record.required_outputs;
  if (declared === undefined) {
    // Historical frozen WIs without outputs retain their previous behavior.
    if (record.suggested_agent === 'DocWriter' && manifest.work_item_output_contract_version === 1) {
      throw new WorkItemOutputError('WORK_ITEM_OUTPUT_DECLARATION_REQUIRED: ' + record.id);
    }
    return;
  }
  if (!Array.isArray(declared) || !declared.length || new Set(declared).size !== declared.length) {
    throw new WorkItemOutputError('WORK_ITEM_OUTPUTS_INVALID: ' + record.id);
  }
  if (typeof record.stage !== 'string' || !record.stage || typeof record.suggested_agent !== 'string') {
    throw new WorkItemOutputError('WORK_ITEM_OUTPUT_IDENTITY_REQUIRED: ' + record.id);
  }
  const scopes = record.allowed_change_paths ?? [];
  const role = record.suggested_agent;
  const rules = readRoleEditPolicy(role, { policyDir, cache });
  for (const p of declared) {
    if (!safePath(p)) throw new WorkItemOutputError('WORK_ITEM_OUTPUT_PATH_INVALID: ' + record.id);
    if (!(manifest.allowed_change_paths ?? []).some(s => scopeContains(s, p)) ||
        !scopes.some(s => scopeContains(s, p))) {
      throw new WorkItemOutputError('WORK_ITEM_OUTPUT_OUT_OF_SCOPE: ' + record.id + ' ' + p);
    }
    if (!roleCanEdit(rules, p)) throw new WorkItemOutputError('WORK_ITEM_OUTPUT_ROLE_DENIED: ' + role + ' ' + p);
  }
}

export function verifyCompletedWorkItemOutputs({ manifest, pipeline, stage, manifestFile, runId, startedAt, projectRoot = process.cwd() }) {
  const root = resolve(projectRoot);
  const runRoot = resolve(manifestFile, '..');
  for (const frozen of manifest.work_items ?? []) {
    if (frozen.pipeline_id !== pipeline.id || !pipeline.work_items?.includes(frozen.id)) continue;
    const itemFile = resolve(runRoot, frozen.path);
    let itemRaw;
    try { itemRaw = readFileSync(itemFile, 'utf8'); }
    catch { throw new WorkItemOutputError('WORK_ITEM_OUTPUT_CONTRACT_MISSING: ' + frozen.id); }
    if (sha(itemRaw) !== frozen.sha256) throw new WorkItemOutputError('WORK_ITEM_CHANGED: ' + frozen.id);
    const record = JSON.parse(itemRaw);
    if (record.stage !== stage || record.required_outputs === undefined) continue;
    if (!Array.isArray(record.required_outputs) || !record.required_outputs.length ||
        new Set(record.required_outputs).size !== record.required_outputs.length) {
      throw new WorkItemOutputError('WORK_ITEM_OUTPUTS_INVALID: ' + frozen.id);
    }
    for (const p of record.required_outputs) {
      if (!safePath(p) || !(manifest.allowed_change_paths ?? []).some(s => scopeContains(s, p)) ||
          !(record.allowed_change_paths ?? []).some(s => scopeContains(s, p))) {
        throw new WorkItemOutputError('WORK_ITEM_OUTPUT_OUT_OF_SCOPE: ' + frozen.id + ' ' + p);
      }
      const file = resolve(root, p);
      if (file !== root && !file.startsWith(root + sep)) throw new WorkItemOutputError('WORK_ITEM_OUTPUT_PATH_ESCAPE: ' + p);
      let cursor = root;
      for (const part of relative(root, file).split(sep)) {
        cursor = join(cursor, part);
        try { if (lstatSync(cursor).isSymbolicLink()) throw new WorkItemOutputError('WORK_ITEM_OUTPUT_SYMLINK: ' + p); }
        catch (error) {
          if (error instanceof WorkItemOutputError) throw error;
          throw new WorkItemOutputError('WORK_ITEM_OUTPUT_MISSING: ' + frozen.id + ' ' + p);
        }
      }
      const stat = statSync(file);
      if (!stat.isFile() || !stat.size) throw new WorkItemOutputError('WORK_ITEM_OUTPUT_EMPTY: ' + frozen.id + ' ' + p);
      if (startedAt && Number.isFinite(Date.parse(startedAt)) && stat.mtimeMs + 1000 < Date.parse(startedAt)) {
        throw new WorkItemOutputError('WORK_ITEM_OUTPUT_STALE: ' + frozen.id + ' ' + p);
      }
      const data = readFileSync(file, 'utf8');
      if (!data.trim()) throw new WorkItemOutputError('WORK_ITEM_OUTPUT_EMPTY: ' + frozen.id + ' ' + p);
      if (p.endsWith('.json')) {
        try { JSON.parse(data); }
        catch { throw new WorkItemOutputError('WORK_ITEM_OUTPUT_INVALID_JSON: ' + frozen.id + ' ' + p); }
      }
    }
  }
}
