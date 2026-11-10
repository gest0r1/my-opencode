import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Preserve strings while stripping JSONC comments and trailing commas.
export function parseConfig(text) {
  let result = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { result += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; result += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; result += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); if (end < 0) throw Error('Unterminated JSONC comment'); i = end + 1; result += ' '; continue; }
    if (c === ',') { let j = i + 1; while (/\s/.test(text[j] ?? '') && j < text.length) j++; if (text[j] === ']' || text[j] === '}') continue; }
    result += c;
  }
  // A second string-aware pass handles commas followed by comments.
  let clean = ''; quoted = false; escaped = false;
  for (let i = 0; i < result.length; i++) {
    const c = result[i];
    if (quoted) { clean += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    if (c === ',') { let j = i + 1; while (j < result.length && /\s/.test(result[j])) j++; if (result[j] === ']' || result[j] === '}') continue; }
    clean += c;
  }
  const value = JSON.parse(clean);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Config must be an object');
  return value;
}
function normalize(entry) {
  if (typeof entry === 'string' && entry.trim()) return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string' && entry.length <= 2) return { package: entry[0], ...(entry[1] === undefined ? {} : { options: entry[1] }) };
  if (entry && typeof entry === 'object' && typeof entry.package === 'string' && entry.package.trim()) return entry;
  throw Error('Invalid plugin entry');
}
function spec(entry) { return typeof entry === 'string' ? entry : entry.package; }
function identity(entry) { return spec(entry).replace(/(@[^/@]+)$/, ''); }
export function mergePlugins(repo, user, policy = { excluded: [] }) {
  const result = new Map();
  for (const config of [user, repo]) {
    for (const key of ['plugin', 'plugins']) {
      if (config[key] !== undefined && !Array.isArray(config[key])) throw Error(`${key} must be an array`);
      for (const entry of config[key] ?? []) {
        const normalized = normalize(entry), id = identity(normalized);
        if (!(policy.excluded ?? []).includes(id) && !(policy.excluded ?? []).includes(spec(normalized))) {
          const previous = result.get(id);
          result.set(id, normalized);
        }
      }
    }
  }
  return [...result.values()];
}
export function preservePlugins(active, staged, policyFile) {
  const repoFile = path.join(staged, 'opencode.json');
  const repo = parseConfig(fs.readFileSync(repoFile, 'utf8'));
  const policy = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : { excluded: [] };
  let user = {}, hasActive = false, userModel;
  // Existing global model (or its deliberate absence) wins over distribution defaults.
  // Both files may contribute; invalid input aborts before active config changes.
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(active, name);
    if (!fs.existsSync(file)) continue;
    const existing = parseConfig(fs.readFileSync(file, 'utf8'));
    hasActive = true;
    if (Object.hasOwn(existing, 'model')) userModel = existing.model;
    user.plugins = mergePlugins(existing, user, policy);
  }
  if (hasActive) {
    if (userModel === undefined || userModel === null) delete repo.model;
    else if (typeof userModel === 'string' && userModel.trim()) repo.model = userModel;
    else if (userModel && typeof userModel === 'object' && !Array.isArray(userModel) &&
      typeof userModel.providerID === 'string' && typeof userModel.model === 'string') repo.model = userModel;
    else throw Error('Invalid existing model preference');
  }
  repo.plugins = mergePlugins(repo, user, policy); delete repo.plugin;
  const oldPlugins = path.join(active, 'plugins'), newPlugins = path.join(staged, 'plugins');
  if (fs.existsSync(oldPlugins)) for (const name of fs.readdirSync(oldPlugins)) {
    if ((policy.excluded_local ?? []).includes(name) || fs.existsSync(path.join(newPlugins, name))) continue;
    fs.mkdirSync(newPlugins, { recursive: true });
    fs.cpSync(path.join(oldPlugins, name), path.join(newPlugins, name), { recursive: true, dereference: false });
  }
  fs.writeFileSync(repoFile, JSON.stringify(repo, null, 2) + '\n');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) preservePlugins(...process.argv.slice(2));
