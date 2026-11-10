#!/usr/bin/env node
// Rewrite only old provider IDs. Actual model availability is checked before
// activating the staged generation; never silently replace the chosen model.
import fs from 'node:fs';
import path from 'node:path';

const [stage, reportPath] = process.argv.slice(2);
if (!stage || !reportPath) throw new Error('Usage: migrate-claude-provider.mjs STAGE REPORT');
const migrated = new Set();
function migrateID(id) {
  if (typeof id !== 'string' || !id.startsWith('claude-code/')) return id;
  const result = 'claude-agent/' + id.slice('claude-code/'.length);
  if (!result.slice('claude-agent/'.length)) throw new Error('Empty Claude model name');
  migrated.add(result.split('#')[0]);
  return result;
}
const configPath = path.join(stage, 'opencode.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (typeof config.model === 'string') config.model = migrateID(config.model);
else if (config.model && typeof config.model === 'object' && !Array.isArray(config.model)) {
  if (config.model.providerID === 'claude-code') {
    config.model.providerID = 'claude-agent';
    if (typeof config.model.model !== 'string' || !config.model.model.trim()) throw new Error('Invalid Claude model selection');
    migrated.add(('claude-agent/' + config.model.model).split('#')[0]);
  }
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
function visit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
    const name = path.join(dir, ent.name);
    if (ent.isDirectory()) { visit(name); continue; }
    if (!ent.isFile() || !name.endsWith('.md')) continue;
    const before = fs.readFileSync(name, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(before);
    if (!match) continue;
    let changed = false;
    const front = match[1].split(/\r?\n/).map((line) => {
      if (!line.startsWith('model:')) return line;
      const value = line.slice('model:'.length).trim();
      const raw = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1) : value;
      const updated = migrateID(raw);
      if (updated === raw) return line;
      changed = true;
      return 'model: ' + JSON.stringify(updated);
    }).join('\n');
    if (changed) fs.writeFileSync(name, before.replace(match[0], '---\n' + front + '\n---'));
  }
}
visit(path.join(stage, 'agents'));
fs.writeFileSync(reportPath, JSON.stringify([...migrated].sort()) + '\n', {mode: 0o600});
if (migrated.size) console.log('Claude provider migration staged for ' + migrated.size + ' distinct model(s). Activation requires native-model verification.');
