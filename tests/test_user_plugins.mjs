import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergePlugins, preservePlugins, parseConfig } from '../scripts/merge-user-plugins.mjs';
test('repo priority, options, versions, v1 tuples and exclusions', () => {
  assert.deepEqual(mergePlugins({ plugins: ['managed@2'] }, { plugin: [['user', { x: 1 }]], plugins: ['managed@1', 'retired@1'] }, { excluded: ['retired'] }), [{ package: 'user', options: { x: 1 } }, 'managed@2']);
});
test('JSONC keeps URLs and quoted comment text', () => {
  assert.deepEqual(parseConfig('{ // comment\n "plugins": ["https://host/plugin", "/*literal*/",],}'), { plugins: ['https://host/plugin', '/*literal*/'] });
});
test('fresh install, repeated update and local plugins remain available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-')); const active = path.join(root, 'active'), staged = path.join(root, 'staged');
  try {
    fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'opencode.json'), '{"plugins":[]}');
    preservePlugins(active, staged, path.join(root, 'absent')); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staged, 'opencode.json'))).plugins, []);
    fs.mkdirSync(active); fs.mkdirSync(path.join(active, 'plugins')); fs.writeFileSync(path.join(active, 'plugins/user.ts'), 'user');
    fs.writeFileSync(path.join(active, 'opencode.jsonc'), '{"plugins":[{"package":"user-plugin","options":{"x":1}}]}');
    preservePlugins(active, staged, path.join(root, 'absent')); preservePlugins(active, staged, path.join(root, 'absent'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(staged, 'opencode.json'))).plugins.length, 1);
    assert.equal(fs.readFileSync(path.join(staged, 'plugins/user.ts'), 'utf8'), 'user');
    const before = fs.readFileSync(path.join(staged, 'opencode.json'), 'utf8');
    fs.writeFileSync(path.join(active, 'opencode.json'), '{broken');
    assert.throws(() => preservePlugins(active, staged, path.join(root, 'absent')));
    assert.equal(fs.readFileSync(path.join(staged, 'opencode.json'), 'utf8'), before);
  } finally { fs.rmSync(root, { recursive: true }); }
});


test('retired reboot helper is excluded while independent user plugins survive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-plugin-'));
  const active = path.join(root, 'active'), staged = path.join(root, 'staged');
  try {
    fs.mkdirSync(path.join(active, 'plugins/opencode-web-reboot'), { recursive: true });
    fs.writeFileSync(path.join(active, 'plugins/opencode-web-reboot/index.js'), 'retired');
    fs.writeFileSync(path.join(active, 'plugins/user.ts'), 'user');
    fs.writeFileSync(path.join(active, 'opencode.json'), JSON.stringify({ plugins: ['./plugins/opencode-web-reboot', 'user-plugin'] }));
    fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'opencode.json'), '{"plugins":[]}');
    preservePlugins(active, staged, new URL('../config/opencode/plugin-policy.json', import.meta.url));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staged, 'opencode.json'))).plugins, ['user-plugin']);
    assert.equal(fs.existsSync(path.join(staged, 'plugins/opencode-web-reboot')), false);
    assert.equal(fs.readFileSync(path.join(staged, 'plugins/user.ts'), 'utf8'), 'user');
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('preserve global model across staging, config updates and deliberate unpinning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pref-'));
  const active = path.join(root, 'active'), staged = path.join(root, 'staged');
  try {
    fs.mkdirSync(active); fs.mkdirSync(staged);
    const repoFile = path.join(staged, 'opencode.json');
    fs.writeFileSync(repoFile, '{"model":"repo/default","plugins":[]}');
    fs.writeFileSync(path.join(active, 'opencode.json'), '{"model":"my/provider#high","plugins":[]}');
    preservePlugins(active, staged, new URL('../config/opencode/plugin-policy.json', import.meta.url));
    assert.equal(parseConfig(fs.readFileSync(repoFile,'utf8')).model, 'my/provider#high');
    preservePlugins(active, staged, new URL('../config/opencode/plugin-policy.json', import.meta.url));
    assert.equal(parseConfig(fs.readFileSync(repoFile,'utf8')).model, 'my/provider#high');
    fs.writeFileSync(path.join(active, 'opencode.json'), '{"plugins":[]}');
    fs.writeFileSync(repoFile, '{"model":"repo/new","plugins":[]}');
    preservePlugins(active, staged, new URL('../config/opencode/plugin-policy.json', import.meta.url));
    assert.equal(Object.hasOwn(parseConfig(fs.readFileSync(repoFile,'utf8')), 'model'), false);
  } finally { fs.rmSync(root, {recursive:true}); }
});
