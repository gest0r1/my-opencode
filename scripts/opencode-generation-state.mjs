#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const relevant = p => p.startsWith('config/opencode/') || p.startsWith('config/agents/skills/') ||
  ['config/opencode.env.example', 'install.sh', 'scripts/install-opencode-generation.sh', 'scripts/install-opencode-agents.sh', 'scripts/normalize-opencode-agent-permissions.mjs', 'scripts/materialize-opencode-trusted-paths.mjs', 'scripts/opencode-generation-state.mjs'].includes(p);
export function configFingerprint(tree) {
  if (!Array.isArray(tree?.tree) || tree.truncated) throw new Error('Incomplete config source tree');
  const inventory = tree.tree.filter(x => x.type === 'blob' && relevant(x.path)).map(x => [x.path, x.mode, x.sha]).sort((a,b) => a[0].localeCompare(b[0]));
  if (!inventory.some(x => x[0] === 'config/opencode/opencode.json')) throw new Error('Config source missing');
  return crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(x => {
  const file = path.join(root, x.name);
  if (x.isDirectory()) return walk(file);
  return [file];
});

export function checkGeneration(receipt, repo, fingerprint, home) {
  try {
    const state = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (state.schema_version !== 1 || state.repo !== repo || state.fingerprint !== fingerprint ||
        state.home !== home || !state.files?.length) return false;
    return state.files.every(x => {
      if (typeof x.path !== 'string' || path.isAbsolute(x.path) || x.path.split('/').includes('..')) return false;
      const file = path.join(home, x.path);
      const stat = fs.lstatSync(file);
      return stat.isFile() && hash(file) === x.sha256 && (stat.mode & 0o777) === x.mode;
    });
  } catch { return false; }
}

function record(receipt, repo, sha, fingerprint, source, home) {
  const targets = [];
  for (const file of walk(path.join(source, 'config/opencode'))) {
    const relative = path.relative(path.join(source, 'config/opencode'), file);
    let target = relative;
    if (relative.startsWith('agent/')) {
      const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(fs.readFileSync(file, 'utf8'))?.[1]?.trim();
      if (!name || name.includes('/')) throw new Error('Invalid managed agent');
      target = `agents/${name}.md`;
    } else if (relative.startsWith('command/')) target = 'commands/' + relative.slice(8);
    else if (relative.startsWith('tool/')) {
      if (relative.slice(5).includes('/')) continue;
      target = 'tools/' + relative.slice(5);
    }
    targets.push(`.config/opencode/${target}`);
  }
  for (const file of walk(path.join(source, 'config/agents/skills'))) targets.push('.agents/skills/' + path.relative(path.join(source, 'config/agents/skills'), file));
  targets.push('.config/opencode/.managed-generation.mjs', '.config/opencode/node_modules/@opencode/plugin/package.json');
  const files = [...new Set(targets)].sort().map(relative => {
    const file = path.join(home, relative);
    return { path: relative, sha256: hash(file), mode: fs.statSync(file).mode & 0o777 };
  });
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  const temporary = `${receipt}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify({ schema_version: 1, repo, sha, fingerprint, home, files }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, receipt);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'remote') {
    const [repo, sha] = args;
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Exact config commit required');
    const result = spawnSync('gh', ['api', `repos/${repo}/git/trees/${sha}?recursive=1`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Cannot resolve config fingerprint');
    console.log(configFingerprint(JSON.parse(result.stdout)));
  } else if (action === 'check') process.exit(checkGeneration(...args) ? 0 : 1);
  else if (action === 'record') record(...args);
  else throw new Error('Usage: opencode-generation-state.mjs remote|check|record ...');
}
